//! The refine planner: proposal parsing, edit validation, application, and
//! rollback. Port of the apply half of core/refinement/refinement.ts.

use serde::{Deserialize, Serialize};

use super::{
    AppliedRefinementEdit, HarnessEntry, HarnessRefinementEvent, HarnessScope, HarnessState,
    RefinementAction, RefinementKind,
};

pub const REFINEMENT_SYSTEM_PROMPT: &str = "You are Prime Agent's /refine continual harness subsystem.\n\nYour job is to improve the editable continual harness state from the current trajectory.\nThis is similar in spirit to context compaction, but instead of summarizing the\nconversation you emit precise Create, Update, or Delete edits to reusable state.\nThe continual harness is the persistent, editable set of prompt notes, memories,\nskills, and subagent specs that lets Prime Agent improve reusable behavior\noutside the token history.\nUse \"continual harness\" for that persistent artifact layer; keep \"RLM\" for the\nruntime, Python REPL kernel, and native call interface that executes those artifacts.\n\nContinual harness components:\n- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.\n- memory: durable facts, decisions, failures, preferences, and outcomes.\n- skill: installed Python REPL skill. Skill create/update edits MUST include a `reference` object with `{\"type\":\"python\"}`, a Python import, and a callable or call pattern; they also MUST include an `arguments` object describing accepted inputs, required fields, defaults, and constraints. Use `{}` for `arguments` only when the Python callable truly needs no external inputs. Include the RLM-native call form `await <skill_import>(...)`.\n- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with `handle = await rlm.spawn(\"sub-task\", name=\"worker\")`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role=\"parent\")`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role=\"child\", receiver_name=handle.name)` for follow-ups. Do not invent wrappers like `run_subagent(...)`.\n- factory: declarative state-machine workflow specs of subagent states. The spec lives in `arguments.machine` (the original DAG sugar in `arguments.dag` compiles to machine form; pass exactly one form). The kernel validator (`rlm.factory`) enforces the full machine semantics at write time: run a stored factory with `await rlm.factory.run('<id>')`, watch with `await rlm.factory.status(run_id)`, stop with `await rlm.factory.stop(run_id)`, and resume an escalate-paused run with `await rlm.factory.resume(run_id)`.\n\nScope and persistence policy:\n- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.\n- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.\n- Entry ids in the harness overview may carry a display-only `local:` or `global:` prefix. Always use the bare id (no prefix) in edits.\n- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.\n- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.\n- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.\n- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.\n- When an edit is persisted, include metadata such as `{\"scope\":\"local\"}` or `{\"scope\":\"global\"}` when that helps future review understand the intended blast radius.\n\nUse the trajectory, current continual harness state, and prior refinement history. Prefer\nsmall evidence-backed edits. If prior refinements caused issues, rollback or\nreplace the faulty editable entries. Never edit source files directly. Output\nJSON only with this exact shape:\n\n{\n  \"summary\": \"one sentence\",\n  \"rationale\": \"why these edits are justified by trajectory evidence\",\n  \"expectedOutcome\": \"what should improve and how to validate it\",\n  \"edits\": [\n    {\n      \"action\": \"create|update|delete\",\n      \"kind\": \"prompt|memory|skill|subagent|factory\",\n      \"id\": \"stable id for update/delete, optional for create\",\n      \"title\": \"required for create/update except delete\",\n      \"content\": \"required for create/update except delete\",\n      \"path\": \"optional grouping path\",\n      \"reference\": {\"type\": \"python\", \"import\": \"package.module\", \"callable\": \"function_name\", \"call_pattern\": \"await function_name(...)\"},\n      \"arguments\": {\"name\": {\"type\": \"string\", \"required\": true, \"description\": \"accepted input\"}},\n      \"metadata\": {},\n      \"reason\": \"why this edit is useful\"\n    }\n  ]\n}";

pub const AUTO_REFINE_REVIEW_SYSTEM_PROMPT: &str = "You are Prime Agent's automatic /refine review gate.\n\nDecide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.\nReject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.\n\nReturn JSON only:\n{\n  \"shouldRefine\": true|false,\n  \"rationale\": \"short reason\",\n  \"instructions\": \"optional concise instructions for /refine if shouldRefine is true\"\n}";

/// Output caps (reasoning off shares the model's output budget with JSON).
pub const REFINEMENT_MAX_OUTPUT_TOKENS: u64 = 32_000;
pub const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS: u64 = 4_096;
pub const REFINEMENT_CONTEXT_OVERHEAD_TOKENS: u64 = 1_024;

pub const TRUNCATED_JSON_ERROR: &str = "the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

/// One proposed edit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinementEdit {
    pub action: Option<RefinementAction>,
    pub kind: Option<RefinementKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The refiner's proposal.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RefinementProposal {
    pub summary: String,
    pub rationale: String,
    pub expected_outcome: String,
    pub edits: Vec<RefinementEdit>,
}

/// Whether a JSON candidate ends mid-value (unterminated string, unclosed
/// object/array): a truncated reply, as opposed to a malformed-but-balanced one.
#[must_use]
pub fn is_incomplete_json(candidate: &str) -> bool {
    let mut depth = 0i64;
    let mut in_string = false;
    let mut escaped = false;
    for char in candidate.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if in_string {
            if char == '\\' {
                escaped = true;
            } else if char == '"' {
                in_string = false;
            }
            continue;
        }
        match char {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ => {}
        }
    }
    in_string || depth > 0
}

fn parse_json_candidate(candidate: &str) -> Result<serde_json::Value, String> {
    match serde_json::from_str::<serde_json::Value>(candidate) {
        Ok(value) => Ok(value),
        Err(error) => {
            if is_incomplete_json(candidate) {
                Err(TRUNCATED_JSON_ERROR.to_string())
            } else {
                Err(format!("the model did not return valid JSON: {error}"))
            }
        }
    }
}

/// Extract the proposal JSON from a reply: direct, fenced, or brace-sliced
/// out of prose (with truncation diagnosed against the original text).
///
/// # Errors
///
/// Returns a human-readable error string when the reply contains no JSON
/// object, the candidate JSON is invalid, or the reply looks truncated.
pub fn extract_json_object(text: &str) -> Result<serde_json::Value, String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return parse_json_candidate(trimmed);
    }
    // Fenced block: ``` or ```json ... ```.
    if let Some(start) = trimmed.find("```") {
        let after_fence = &trimmed[start + 3..];
        let after_lang = after_fence.trim_start_matches("json").trim_start();
        if let Some(end) = after_lang.find("```") {
            return parse_json_candidate(after_lang[..end].trim());
        }
    }
    let start = trimmed.find('{');
    let end = trimmed.rfind('}');
    if let (Some(start), Some(end)) = (start, end) {
        if end > start {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed[start..=end]) {
                return Ok(value);
            }
            return parse_json_candidate(&trimmed[start..]);
        }
    }
    if is_incomplete_json(trimmed) {
        return Err(TRUNCATED_JSON_ERROR.to_string());
    }
    Err("Refiner did not return a JSON object".to_string())
}

fn normalize_action(raw: Option<&str>) -> Option<RefinementAction> {
    let raw = raw?;
    let lower = raw.trim().to_lowercase();
    match lower.as_str() {
        "add" | "insert" | "new" | "create" | "make" | "append" => Some(RefinementAction::Create),
        "edit" | "modify" | "patch" | "update" | "change" | "put" | "set" => Some(RefinementAction::Update),
        "remove" | "del" | "delete" | "drop" | "rm" | "clear" => Some(RefinementAction::Delete),
        _ => None,
    }
}

fn extract_action(edit: &serde_json::Map<String, serde_json::Value>) -> Option<RefinementAction> {
    for key in &["action", "op", "operation", "verb", "command", "type"] {
        if let Some(val) = edit.get(*key).and_then(|v| v.as_str()) {
            if let Some(act) = normalize_action(Some(val)) {
                return Some(act);
            }
        }
    }
    None
}

fn normalize_kind(raw: Option<&str>) -> (Option<RefinementKind>, Option<String>) {
    let Some(raw) = raw else {
        return (Some(RefinementKind::Memory), None);
    };
    let lower = raw.trim().to_lowercase();
    match lower.as_str() {
        "prompts" | "prompt" | "instruction" | "policy" | "rule" | "rules" | "system" => {
            (Some(RefinementKind::Prompt), None)
        }
        "skills" | "skill" | "tool" | "tools" | "function" | "functions" => {
            (Some(RefinementKind::Skill), None)
        }
        "subagents" | "subagent" | "agent" | "agents" => {
            (Some(RefinementKind::Subagent), None)
        }
        "memories" | "memory" | "facts" | "knowledge" => {
            (Some(RefinementKind::Memory), None)
        }
        "general" | "fact" | "decision" | "lesson" | "preference" => {
            (Some(RefinementKind::Memory), Some(lower))
        }
        _ => (Some(RefinementKind::Memory), Some(lower)),
    }
}

fn extract_kind(edit: &serde_json::Map<String, serde_json::Value>) -> (Option<RefinementKind>, Option<String>) {
    for key in &["kind", "layer", "type", "component", "category"] {
        if let Some(val) = edit.get(*key).and_then(|v| v.as_str()) {
            return normalize_kind(Some(val));
        }
    }
    (Some(RefinementKind::Memory), None)
}

fn clean_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let s = if let Some(stripped) = trimmed.strip_prefix("local:") {
        stripped.trim()
    } else if let Some(stripped) = trimmed.strip_prefix("global:") {
        stripped.trim()
    } else {
        trimmed
    };
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn find_bracket_id(text: &str) -> Option<String> {
    for prefix in &["[local:", "(local:", "[global:", "(global:"] {
        if let Some(start) = text.find(prefix) {
            let after = &text[start + prefix.len()..];
            let closing = if prefix.starts_with('[') { ']' } else { ')' };
            if let Some(end) = after.find(closing) {
                let candidate = &after[..end];
                if candidate.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                    return clean_id(candidate);
                }
            }
        }
    }
    None
}

fn extract_action_mention(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let keywords = [
        "update", "updating", "modify", "modifying", "patch", "patching",
        "delete", "deleting", "remove", "removing", "refine", "refining",
    ];
    let ignored = [
        "the", "a", "an", "this", "that", "entry", "entries", "memory", "memories",
        "prompt", "prompts", "skill", "skills", "subagent", "subagents", "to", "from",
        "harness", "continual", "state", "with", "for", "and",
    ];
    for kw in &keywords {
        if let Some(idx) = lower.find(kw) {
            let after = &text[idx + kw.len()..];
            let parts: Vec<&str> = after.split_whitespace().collect();
            for part in parts.iter().take(5) {
                let cleaned = part.trim_matches(|c: char| {
                    c == '`' || c == '[' || c == ']' || c == '*' || c == '"' || c == '\'' || c == '(' || c == ')'
                });
                let id_candidate = cleaned
                    .strip_prefix("local:")
                    .or_else(|| cleaned.strip_prefix("global:"))
                    .unwrap_or(cleaned);
                let candidate_lower = id_candidate.to_lowercase();
                if ignored.contains(&candidate_lower.as_str()) {
                    continue;
                }
                if id_candidate.len() >= 3
                    && id_candidate.len() <= 60
                    && id_candidate.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')
                {
                    return clean_id(id_candidate);
                }
            }
        }
    }
    None
}

fn extract_id(edit: &serde_json::Map<String, serde_json::Value>, context_text: Option<&str>) -> Option<String> {
    for key in &[
        "id", "name", "key", "slug", "identifier", "target", "entry",
        "entryId", "entry_id", "targetId", "target_id", "itemId", "item_id",
        "item", "ref", "originalId", "original_id", "existingId", "existing_id",
        "sourceId", "source_id",
    ] {
        if let Some(val) = edit.get(*key) {
            if let Some(s) = val.as_str() {
                if let Some(id) = clean_id(s) {
                    return Some(id);
                }
            } else if let Some(obj) = val.as_object() {
                for sub in &["id", "name", "key", "slug"] {
                    if let Some(s) = obj.get(*sub).and_then(|v| v.as_str()) {
                        if let Some(id) = clean_id(s) {
                            return Some(id);
                        }
                    }
                }
            }
        }
    }

    if let Some(val) = edit.get("reference").and_then(|v| v.as_str()) {
        if let Some(id) = clean_id(val) {
            return Some(id);
        }
    }

    if let Some(p) = edit.get("path").and_then(|v| v.as_str()) {
        let trimmed = p.trim();
        if !trimmed.contains('/') && trimmed.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
            if trimmed.contains('_') || trimmed.starts_with("local:") || trimmed.starts_with("global:") {
                if let Some(id) = clean_id(trimmed) {
                    return Some(id);
                }
            }
        }
    }

    if let Some(title) = edit.get("title").and_then(|v| v.as_str()) {
        if let Some(id) = find_bracket_id(title) {
            return Some(id);
        }
    }

    if let Some(content) = edit.get("content").and_then(|v| v.as_str()) {
        let slice = if content.len() > 200 { &content[..200] } else { content };
        if let Some(id) = find_bracket_id(slice) {
            return Some(id);
        }
    }

    for key in &["reason", "notes", "explanation", "rationale"] {
        if let Some(s) = edit.get(*key).and_then(|v| v.as_str()) {
            if let Some(id) = extract_action_mention(s) {
                return Some(id);
            }
        }
    }

    if let Some(ctx) = context_text {
        if let Some(id) = extract_action_mention(ctx) {
            return Some(id);
        }
    }

    None
}

fn extract_title(edit: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    for key in &["title", "header", "subject", "label", "heading"] {
        if let Some(s) = edit.get(*key).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if let Some(name) = edit.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        let id_val = edit.get("id").and_then(|v| v.as_str());
        if !trimmed.is_empty() && id_val.is_some() && id_val != Some(trimmed) {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn extract_content(edit: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    for key in &[
        "content", "value", "text", "body", "description", "desc",
        "note", "notes", "details", "detail", "data", "instruction",
        "instructions", "rule", "rules", "statement", "memory", "prompt",
    ] {
        if let Some(val) = edit.get(*key) {
            if let Some(s) = val.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            } else if let Some(arr) = val.as_array() {
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(|item| {
                        if let Some(s) = item.as_str() {
                            Some(s.to_string())
                        } else {
                            serde_json::to_string(item).ok()
                        }
                    })
                    .collect();
                let res = joined.join("\n").trim().to_string();
                if !res.is_empty() {
                    return Some(res);
                }
            } else if let Some(obj) = val.as_object() {
                for inner_key in &["text", "content", "value"] {
                    if let Some(inner) = obj.get(*inner_key).and_then(|v| v.as_str()) {
                        let trimmed = inner.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                }
                if let Ok(pretty) = serde_json::to_string_pretty(val) {
                    if pretty != "{}" {
                        return Some(pretty);
                    }
                }
            }
        }
    }
    None
}

fn derive_title(
    raw_title: Option<String>,
    content: Option<&str>,
    id: Option<&str>,
    kind: RefinementKind,
) -> String {
    if let Some(t) = raw_title {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(raw_id) = id {
        let trimmed = raw_id.trim();
        if !trimmed.is_empty() {
            return trimmed.replace('_', " ");
        }
    }
    if let Some(cnt) = content {
        if let Some(first_line) = cnt.lines().next() {
            let cleaned = first_line
                .trim()
                .trim_start_matches(|c: char| c == '#' || c == '*' || c == '-' || c.is_whitespace())
                .trim();
            if !cleaned.is_empty() {
                return cleaned.chars().take(60).collect();
            }
        }
    }
    format!("{} item", kind_name(kind))
}

/// Normalize an untrusted proposal, preserving invalid edit fields for
/// apply-time validation.
#[must_use]
pub fn normalize_refinement_proposal(value: &serde_json::Value) -> RefinementProposal {
    let (record, top_array) = if let Some(arr) = value.as_array() {
        (serde_json::Map::default(), Some(arr.clone()))
    } else if let Some(obj) = value.as_object() {
        (obj.clone(), None)
    } else {
        (serde_json::Map::default(), None)
    };

    let string_field = |key: &str, fallback: &str| -> String {
        record
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or(fallback)
            .to_string()
    };

    let summary = string_field("summary", "Refined continual harness state");
    let rationale = record
        .get("rationale")
        .or_else(|| record.get("reason"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let expected_outcome = record
        .get("expectedOutcome")
        .or_else(|| record.get("outcome"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let context_text = format!("{summary} {rationale}").trim().to_string();
    let context_opt = if context_text.is_empty() {
        None
    } else {
        Some(context_text.as_str())
    };

    let raw_edits_array = top_array
        .or_else(|| {
            for key in &["edits", "changes", "items", "entries", "proposals"] {
                if let Some(arr) = record.get(*key).and_then(|v| v.as_array()) {
                    return Some(arr.clone());
                }
            }
            None
        })
        .unwrap_or_default();

    let edits = raw_edits_array
        .iter()
        .filter_map(|item| {
            let edit_obj = item.as_object()?;
            let action = extract_action(edit_obj).or(Some(RefinementAction::Create));
            let (kind, suggested_path) = extract_kind(edit_obj);
            let raw_id = extract_id(edit_obj, context_opt);
            let raw_title = extract_title(edit_obj);
            let content = extract_content(edit_obj);
            let kind_val = kind.unwrap_or(RefinementKind::Memory);
            let title = Some(derive_title(
                raw_title,
                content.as_deref(),
                raw_id.as_deref(),
                kind_val,
            ));

            let path = edit_obj
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or(suggested_path);

            let reference = edit_obj
                .get("reference")
                .and_then(|v| v.as_object())
                .cloned();
            let arguments = edit_obj
                .get("arguments")
                .and_then(|v| v.as_object())
                .cloned();
            let metadata = edit_obj
                .get("metadata")
                .and_then(|v| v.as_object())
                .cloned();
            let reason = edit_obj
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            Some(RefinementEdit {
                action,
                kind: Some(kind_val),
                id: raw_id,
                title,
                content,
                path,
                reference,
                arguments,
                metadata,
                reason,
            })
        })
        .collect();

    RefinementProposal {
        summary,
        rationale,
        expected_outcome,
        edits,
    }
}

/// Parse and normalize a refinement proposal from a model reply.
///
/// # Errors
///
/// Returns a human-readable error string when the reply's JSON cannot be
/// extracted or its top level is not an object or array.
pub fn parse_proposal(text: &str) -> Result<RefinementProposal, String> {
    let value = extract_json_object(text)?;
    if !value.is_object() && !value.is_array() {
        return Err("Refiner JSON must be an object".to_string());
    }
    Ok(normalize_refinement_proposal(&value))
}

fn slug(raw: &str, fallback: &str) -> String {
    let mut normalized = String::new();
    for char in raw.trim().to_lowercase().chars() {
        if char.is_ascii_lowercase() || char.is_ascii_digit() {
            normalized.push(char);
        } else if !normalized.ends_with('_') {
            normalized.push('_');
        }
    }
    let normalized = normalized.trim_matches('_').to_string();
    let truncated: String = normalized.chars().take(80).collect();
    if truncated.is_empty() {
        fallback.to_string()
    } else {
        truncated
    }
}

fn resolve_target_id(
    entries: Option<&std::collections::BTreeMap<String, HarnessEntry>>,
    edit: &RefinementEdit,
) -> Option<String> {
    let entries = entries?;
    if entries.is_empty() {
        return None;
    }

    let record_keys: Vec<&String> = entries.keys().collect();
    let norm_title = edit.title.as_deref().unwrap_or("").to_lowercase();
    let norm_content = edit.content.as_deref().unwrap_or("").to_lowercase();

    // 1. Check if an existing entry ID appears in edit.title or edit.content
    for key in &record_keys {
        let k_norm = key.to_lowercase();
        if norm_title.contains(&k_norm) || norm_content.contains(&k_norm) {
            return Some((*key).clone());
        }
        if let Some(entry) = entries.get(*key) {
            let existing_title = entry.title.to_lowercase();
            if !existing_title.is_empty()
                && (norm_title.contains(&existing_title) || existing_title.contains(&norm_title))
            {
                return Some((*key).clone());
            }
        }
        let k_words: Vec<&str> = k_norm
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 3)
            .collect();
        let title_words: std::collections::HashSet<&str> = norm_title
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 3)
            .collect();
        let overlap = k_words.iter().filter(|w| title_words.contains(*w)).count();
        if overlap >= 2 {
            return Some((*key).clone());
        }
    }

    // 2. Check title prefix before version/colon/parenthesis
    if let Some(title) = &edit.title {
        let get_title_prefix = |t: &str| -> String {
            let clean = if let Some(idx) = t.find(']') {
                &t[idx + 1..]
            } else if let Some(idx) = t.find(')') {
                &t[idx + 1..]
            } else {
                t
            };
            let mut prefix = clean.trim();
            if let Some(pos) = prefix.find(|c| c == ':' || c == '(') {
                prefix = &prefix[..pos];
            }
            if let Some(v_idx) = prefix.to_lowercase().find(" v") {
                if prefix[v_idx + 2..]
                    .chars()
                    .next()
                    .map_or(false, |c| c.is_ascii_digit())
                {
                    prefix = &prefix[..v_idx];
                }
            }
            prefix
                .to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric() || c.is_whitespace())
                .collect::<String>()
                .trim()
                .to_string()
        };

        let edit_prefix = get_title_prefix(title);
        if edit_prefix.len() >= 5 {
            for key in &record_keys {
                if let Some(entry) = entries.get(*key) {
                    let entry_prefix = get_title_prefix(&entry.title);
                    if entry_prefix.len() >= 5
                        && (edit_prefix == entry_prefix
                            || edit_prefix.contains(&entry_prefix)
                            || entry_prefix.contains(&edit_prefix))
                    {
                        return Some((*key).clone());
                    }
                }
            }
        }

        // 3. Significant word overlap between edit title and existing entry title (>= 3 words)
        let stop_words: std::collections::HashSet<&str> = [
            "for", "and", "the", "with", "from", "state", "into", "that", "this",
        ]
        .into_iter()
        .collect();
        let edit_words: std::collections::HashSet<&str> = norm_title
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 3 && !stop_words.contains(w))
            .collect();

        let mut best_overlap = 0;
        let mut best_key = None;
        for key in &record_keys {
            if let Some(entry) = entries.get(*key) {
                let lower_entry_title = entry.title.to_lowercase();
                let entry_words: Vec<&str> = lower_entry_title
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| w.len() >= 3 && !stop_words.contains(w))
                    .collect();
                let overlap = entry_words.iter().filter(|w| edit_words.contains(*w)).count();
                if overlap >= 3 && overlap > best_overlap {
                    best_overlap = overlap;
                    best_key = Some((*key).clone());
                }
            }
        }
        if let Some(k) = best_key {
            return Some(k);
        }

        // 4. Path match (if unique)
        if let Some(path) = &edit.path {
            let matching: Vec<&String> = record_keys
                .iter()
                .filter(|k| entries.get(k.as_str()).map_or(false, |e| &e.path == path))
                .copied()
                .collect();
            if matching.len() == 1 {
                return Some(matching[0].clone());
            }
        }

        // 5. Slug of edit.title matching an existing entry ID
        let s = slug(title, kind_name(edit.kind.unwrap_or(RefinementKind::Memory)));
        if entries.contains_key(&s) {
            return Some(s);
        }

        // 6. First word of title matching existing entry key
        let first_word = title
            .trim()
            .split(|c: char| c.is_whitespace() || c == ':' || c == ',' || c == '(')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let cleaned_first = first_word
            .trim_start_matches(|c| c == '[' || c == '`' || c == '*')
            .trim_end_matches(|c| c == ']' || c == '`' || c == '*');
        let cleaned_first = cleaned_first
            .strip_prefix("local:")
            .or_else(|| cleaned_first.strip_prefix("global:"))
            .unwrap_or(cleaned_first);
        if entries.contains_key(cleaned_first) {
            return Some(cleaned_first.to_string());
        }
    }

    None
}

/// Validation errors mirror the TS messages exactly.
fn validate_edit(edit: &RefinementEdit, computed_id: Option<&str>) -> Option<String> {
    let Some(action) = edit.action else {
        return Some("unsupported action".to_string());
    };
    let Some(kind) = edit.kind else {
        return Some("unsupported kind".to_string());
    };
    match action {
        RefinementAction::Create | RefinementAction::Update | RefinementAction::Delete => {}
    }
    match kind {
        RefinementKind::Prompt
        | RefinementKind::Memory
        | RefinementKind::Skill
        | RefinementKind::Subagent
        | RefinementKind::Factory => {}
    }
    if kind == RefinementKind::Prompt
        && (edit.id.as_deref() == Some("base_system_prompt")
            || computed_id == Some("base_system_prompt"))
    {
        return Some("base system prompt is not editable".to_string());
    }
    if action != RefinementAction::Create && computed_id.is_none() {
        return Some(format!("{action:?} requires id").to_lowercase());
    }
    if action != RefinementAction::Delete && (edit.title.is_none() || edit.content.is_none()) {
        return Some(format!("{action:?} requires title and content").to_lowercase());
    }
    if action != RefinementAction::Delete && kind == RefinementKind::Skill {
        if edit.arguments.is_none() {
            return Some(format!("{action:?} skill requires arguments").to_lowercase());
        }
        let Some(reference) = &edit.reference else {
            return Some(format!("{action:?} skill requires python reference").to_lowercase());
        };
        if reference.get("type").and_then(|value| value.as_str()) != Some("python") {
            return Some(format!("{action:?} skill reference.type must be python").to_lowercase());
        }
        let has_import = reference
            .get("import")
            .and_then(|value| value.as_str())
            .is_some_and(|import| !import.is_empty())
            || reference
                .get("python_import")
                .and_then(|value| value.as_str())
                .is_some_and(|import| !import.is_empty());
        let has_callable = reference
            .get("callable")
            .and_then(|value| value.as_str())
            .is_some_and(|callable| !callable.is_empty())
            || reference
                .get("call_pattern")
                .and_then(|value| value.as_str())
                .is_some_and(|callable| !callable.is_empty());
        if !has_import {
            return Some(format!("{action:?} skill requires python import").to_lowercase());
        }
        if !has_callable {
            return Some(
                format!("{action:?} skill requires callable or call_pattern").to_lowercase(),
            );
        }
    }
    if action != RefinementAction::Delete
        && kind == RefinementKind::Factory
        && (action == RefinementAction::Create || edit.arguments.is_some())
    {
        // Structural check only: the kernel validator (`rlm.factory`) enforces
        // the full machine semantics at write time; do not reimplement it here.
        // A create requires its spec; an update may omit `arguments` entirely
        // and keep the stored spec (apply preserves `before.arguments`),
        // exactly like update_factory treats dag/machine.
        let arguments = edit.arguments.as_ref();
        // JSON null is treated as absent, exactly like the kernel's Python
        // writers (arguments.get("machine") returning None): a supplied
        // "machine": null never counts as the machine form.
        let dag = arguments
            .and_then(|args| args.get("dag"))
            .filter(|value| !value.is_null());
        let machine = arguments
            .and_then(|args| args.get("machine"))
            .filter(|value| !value.is_null());
        if dag.is_some() && machine.is_some() {
            return Some("pass either dag or machine form, not both".to_string());
        }
        let spec = machine.or(dag);
        if !matches!(spec, Some(serde_json::Value::Object(_))) {
            return Some("factory entry requires a dag or machine object in arguments".to_string());
        }
    }
    None
}

fn now_iso() -> String {
    crate::session::manager::format_iso_now()
}

/// Options for applying a proposal.
pub struct ApplyOptions {
    pub id: String,
    pub rollback_of: Option<String>,
    pub scope: Option<HarnessScope>,
    /// Target-scope state captured before planning; edits whose entry changed
    /// since the baseline are rejected.
    pub baseline_state: Option<HarnessState>,
    /// The resolved `factory.enabled` opt-in (default off). While it is off,
    /// factory create/update edits refuse with the one disabled message, the
    /// same gate the kernel-side factory writers raise
    /// (`rlm.factory.require_factory_enabled`).
    pub factory_enabled: bool,
}

/// Apply a proposal to the state (mutating entries and recording the event).
///
/// # Panics
///
/// The internal unwraps cannot fire: an edit without an action is rejected
/// by validation first, and the empty state pre-populates every per-kind
/// entry map.
pub fn apply_refinement_proposal(
    state: &mut HarnessState,
    proposal: &RefinementProposal,
    options: ApplyOptions,
) -> super::RefinementResult {
    let mut applied_edits: Vec<AppliedRefinementEdit> = Vec::new();
    let mut proposal_modified_keys: std::collections::HashSet<String> =
        std::collections::HashSet::default();
    for edit in &proposal.edits {
        let kind_opt = edit.kind;
        let resolved_id = match (&edit.id, edit.action) {
            (Some(id_str), _) if !id_str.trim().is_empty() => Some(id_str.trim().to_string()),
            (_, Some(RefinementAction::Create)) => {
                Some(slug(
                    edit.title
                        .as_deref()
                        .unwrap_or(kind_name(kind_opt.unwrap_or(RefinementKind::Memory))),
                    kind_name(kind_opt.unwrap_or(RefinementKind::Memory)),
                ))
            }
            (_, _) => {
                let kind_val = kind_opt.unwrap_or(RefinementKind::Memory);
                let entries_map = state.entries.get(&kind_val);
                resolve_target_id(entries_map, edit)
            }
        };
        let id = resolved_id.clone().unwrap_or_default();
        let validation_error = validate_edit(edit, resolved_id.as_deref());
        let Some(kind) = edit.kind else {
            let mut row = AppliedRefinementEdit::planned(
                edit,
                RefinementAction::Create,
                RefinementKind::Memory,
                id.clone(),
            );
            row.error = validation_error;
            applied_edits.push(row);
            continue;
        };
        if let Some(error) = validation_error {
            let mut row = AppliedRefinementEdit::planned(
                edit,
                edit.action.unwrap_or(RefinementAction::Create),
                kind,
                id.clone(),
            );
            row.error = Some(error);
            applied_edits.push(row);
            continue;
        }
        let action = edit.action.unwrap();
        let records = state.entries.get_mut(&kind).unwrap();
        let before = records.get(&id).cloned();
        let entry_key = format!("{}:{id}", kind_name(kind));
        let baseline = options.baseline_state.as_ref().and_then(|baseline| {
            baseline
                .entries
                .get(&kind)
                .and_then(|entries| entries.get(&id).cloned())
        });
        if options.baseline_state.is_some()
            && !proposal_modified_keys.contains(&entry_key)
            && serde_json::to_value(&before).ok() != serde_json::to_value(&baseline).ok()
        {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.before = before;
            row.error = Some("entry changed during refinement planning".to_string());
            applied_edits.push(row);
            continue;
        }
        // The opt-in gate, the host-side mirror of the kernel writers'
        // one refusal (`require_factory_enabled`): while `factory.enabled`
        // is off, a refinement cannot author or re-author factory entries,
        // exactly like every kernel factory write. The refusal precedes
        // the create/update existence checks, so the disabled message is
        // unconditional while off. A delete is not authoring: cleanup
        // stays available, the gate's documented split.
        if kind == RefinementKind::Factory
            && action != RefinementAction::Delete
            && !options.factory_enabled
        {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.before = before;
            row.error = Some(super::FACTORY_DISABLED_MESSAGE.to_string());
            applied_edits.push(row);
            continue;
        }
        if action == RefinementAction::Delete {
            if before.is_none() {
                let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
                row.error = Some("entry not found".to_string());
                applied_edits.push(row);
                continue;
            }
            records.remove(&id);
            proposal_modified_keys.insert(entry_key);
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id);
            row.before = before;
            row.applied = true;
            applied_edits.push(row);
            continue;
        }
        if action == RefinementAction::Create && before.is_some() {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.before = before;
            row.error = Some("entry already exists".to_string());
            applied_edits.push(row);
            continue;
        }
        if action == RefinementAction::Update && before.is_none() {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.error = Some("entry not found".to_string());
            applied_edits.push(row);
            continue;
        }
        let after = HarnessEntry {
            id: id.clone(),
            kind,
            title: edit
                .title
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.title.clone()))
                .unwrap_or_else(|| id.clone()),
            content: edit
                .content
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.content.clone()))
                .unwrap_or_default(),
            path: edit
                .path
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.path.clone()))
                .unwrap_or_else(|| "general".to_string()),
            scope: before
                .as_ref()
                .and_then(|entry| entry.scope)
                .or(options.scope)
                .or(Some(HarnessScope::Local)),
            reference: edit
                .reference
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.reference.clone()))
                .unwrap_or_default(),
            arguments: edit
                .arguments
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.arguments.clone()))
                .unwrap_or_default(),
            metadata: edit
                .metadata
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.metadata.clone()))
                .unwrap_or_default(),
            source: "refine".to_string(),
            created_at: before
                .as_ref()
                .map_or_else(now_iso, |entry| entry.created_at.clone()),
            updated_at: now_iso(),
            version: before.as_ref().map_or(1, |entry| entry.version + 1),
        };
        records.insert(id.clone(), after.clone());
        proposal_modified_keys.insert(entry_key);
        let mut row = AppliedRefinementEdit::planned(edit, action, kind, id);
        row.before = before;
        row.after = Some(after);
        row.applied = true;
        applied_edits.push(row);
    }
    let changes: Vec<String> = applied_edits
        .iter()
        .filter(|edit| edit.applied)
        .map(|edit| {
            format!(
                "{} {}:{}",
                action_name(edit.action),
                kind_name(edit.kind),
                edit.id
            )
        })
        .collect();
    state.refinements.push(HarnessRefinementEvent {
        id: options.id.clone(),
        trigger: proposal.summary.clone(),
        changes,
        evidence: proposal.rationale.clone(),
        outcome: proposal.expected_outcome.clone(),
        created_at: now_iso(),
    });
    super::RefinementResult {
        id: options.id,
        summary: proposal.summary.clone(),
        rationale: proposal.rationale.clone(),
        expected_outcome: proposal.expected_outcome.clone(),
        applied_edits,
        harness_state_path: String::new(),
        rollback_of: options.rollback_of,
        scope: options.scope,
    }
}

/// The proposal that reverts a previously applied result.
#[must_use]
pub fn rollback_proposal(target: &super::RefinementResult) -> RefinementProposal {
    let mut edits: Vec<RefinementEdit> = Vec::new();
    for edit in target.applied_edits.iter().rev() {
        if !edit.applied {
            continue;
        }
        if let Some(before) = &edit.before {
            edits.push(RefinementEdit {
                action: Some(if edit.after.is_some() {
                    RefinementAction::Update
                } else {
                    RefinementAction::Create
                }),
                kind: Some(edit.kind),
                id: Some(edit.id.clone()),
                title: Some(before.title.clone()),
                content: Some(before.content.clone()),
                path: Some(before.path.clone()),
                reference: Some(before.reference.clone()),
                arguments: Some(before.arguments.clone()),
                metadata: Some(before.metadata.clone()),
                reason: Some(format!("Rollback {}", target.id)),
            });
        } else if edit.after.is_some() {
            edits.push(RefinementEdit {
                action: Some(RefinementAction::Delete),
                kind: Some(edit.kind),
                id: Some(edit.id.clone()),
                reason: Some(format!("Rollback {}", target.id)),
                ..Default::default()
            });
        }
    }
    RefinementProposal {
        summary: format!("Rollback refinement {}", target.id),
        rationale: format!(
            "Restores continual harness state snapshots from refinement {}.",
            target.id
        ),
        expected_outcome: "Faulty refinement edits are reverted.".to_string(),
        edits,
    }
}

fn action_name(action: RefinementAction) -> &'static str {
    match action {
        RefinementAction::Create => "create",
        RefinementAction::Update => "update",
        RefinementAction::Delete => "delete",
    }
}

fn kind_name(kind: RefinementKind) -> &'static str {
    match kind {
        RefinementKind::Prompt => "prompt",
        RefinementKind::Memory => "memory",
        RefinementKind::Skill => "skill",
        RefinementKind::Subagent => "subagent",
        RefinementKind::Factory => "factory",
    }
}

/// Byte-based input token bound (one token per UTF-8 byte).
fn refinement_input_token_bound(text: &str) -> u64 {
    text.len() as u64
}

/// Fit the refinement request into the model context: trim conversation from
/// the front (binary search) and clamp output tokens.
///
/// # Errors
///
/// Returns an error when even the trimmed prompt leaves no room for output
/// tokens in the model's context window.
pub fn refinement_request(
    model: &pa_types::ai::Model,
    system_prompt: &str,
    conversation_text: &str,
    build_prompt: &dyn Fn(&str) -> String,
    output_reserve: u64,
) -> anyhow::Result<(u64, String)> {
    let system_reserve =
        refinement_input_token_bound(system_prompt) + REFINEMENT_CONTEXT_OVERHEAD_TOKENS;
    let input_budget = model.context_window.saturating_sub(
        model
            .max_tokens
            .min(output_reserve)
            .min(model.context_window / 2),
    );
    let mut user_prompt = build_prompt(conversation_text);
    if system_reserve + refinement_input_token_bound(&user_prompt) > input_budget
        && !conversation_text.is_empty()
    {
        let prompt_for_length = |length: usize| -> String {
            let start = conversation_text.len().saturating_sub(length);
            // Avoid splitting a UTF-8 sequence (the TS surrogate skip).
            let mut start = start.min(conversation_text.len());
            while start < conversation_text.len() && !conversation_text.is_char_boundary(start) {
                start += 1;
            }
            build_prompt(&format!(
                "[Earlier conversation omitted to fit the model context.]\n{}",
                &conversation_text[start..]
            ))
        };
        let mut low = 0usize;
        let mut high = conversation_text.len();
        while low < high {
            let length = (low + high).div_ceil(2);
            if system_reserve + refinement_input_token_bound(&prompt_for_length(length))
                <= input_budget
            {
                low = length;
            } else {
                high = length - 1;
            }
        }
        user_prompt = prompt_for_length(low);
    }
    let max_tokens = model.max_tokens.min(
        model
            .context_window
            .saturating_sub(system_reserve + refinement_input_token_bound(&user_prompt)),
    );
    if max_tokens == 0 {
        anyhow::bail!("Refinement prompt leaves no room for output in the model's context window; retry with a smaller request.");
    }
    Ok((max_tokens, user_prompt))
}

#[cfg(test)]
mod tests {
    use super::super::empty_harness_state;
    use super::*;

    fn create_memory_edit(id: &str, title: &str, content: &str) -> RefinementEdit {
        RefinementEdit {
            action: Some(RefinementAction::Create),
            kind: Some(RefinementKind::Memory),
            id: Some(id.to_string()),
            title: Some(title.to_string()),
            content: Some(content.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn json_extraction_diagnoses_truncation() {
        // Direct object.
        let parsed = parse_proposal(r#"{"summary":"ok","edits":[]}"#).unwrap();
        assert_eq!(parsed.summary, "ok");
        // Fenced block.
        let fenced = parse_proposal("```json\n{\"summary\":\"fenced\"}\n```").unwrap();
        assert_eq!(fenced.summary, "fenced");
        // Brace-sliced out of prose.
        let prose = parse_proposal("Here you go:\n{\"summary\":\"sliced\"}\nAll set.").unwrap();
        assert_eq!(prose.summary, "sliced");
        // Truncated JSON reports the output-budget cause.
        let error = parse_proposal(r#"{"summary":"cut","edits":[{"action":"cre"#).unwrap_err();
        assert_eq!(error, TRUNCATED_JSON_ERROR);
        // Non-JSON text reports missing JSON.
        assert_eq!(
            parse_proposal("no json here").unwrap_err(),
            "Refiner did not return a JSON object"
        );
    }

    #[test]
    fn validation_rules() {
        // Unsupported action.
        let mut edit = create_memory_edit("m", "t", "c");
        edit.action = None;
        assert!(validate_edit(&edit, None).is_some());
        // base_system_prompt is not editable.
        let mut prompt_edit = RefinementEdit {
            action: Some(RefinementAction::Update),
            kind: Some(RefinementKind::Prompt),
            id: Some("base_system_prompt".to_string()),
            title: Some("t".into()),
            content: Some("c".into()),
            ..Default::default()
        };
        assert_eq!(
            validate_edit(&prompt_edit, None),
            Some("base system prompt is not editable".to_string())
        );
        // Skill edits require python reference + arguments + callable.
        let mut skill_edit = RefinementEdit {
            action: Some(RefinementAction::Create),
            kind: Some(RefinementKind::Skill),
            title: Some("Skill".into()),
            content: Some("Does things".into()),
            ..Default::default()
        };
        assert!(validate_edit(&skill_edit, None)
            .unwrap()
            .contains("skill requires arguments"));
        skill_edit.arguments = Some(serde_json::Map::default());
        assert!(validate_edit(&skill_edit, None)
            .unwrap()
            .contains("skill requires python reference"));
        skill_edit.reference = Some(
            serde_json::from_value(
                serde_json::json!({ "type": "python", "import": "pkg.mod", "callable": "run" }),
            )
            .unwrap(),
        );
        assert_eq!(validate_edit(&skill_edit, None), None);
        // Wrong reference type.
        skill_edit.reference = Some(
            serde_json::from_value(
                serde_json::json!({ "type": "shell", "import": "pkg.mod", "callable": "run" }),
            )
            .unwrap(),
        );
        assert!(validate_edit(&skill_edit, None)
            .unwrap()
            .contains("reference.type must be python"));
        prompt_edit.id = Some("x".to_string());
    }

    #[test]
    fn factory_edits_accept_exactly_one_spec_form() {
        // Structural check only (TS shape): the kernel validator enforces
        // the full machine semantics at write time.
        let machine = serde_json::json!({
            "states": [{ "id": "collect", "entry": true, "subagent": "worker" }],
            "transitions": []
        });
        let dag = serde_json::json!({ "nodes": [{ "id": "collect", "subagent": "worker" }] });
        let mut edit = RefinementEdit {
            action: Some(RefinementAction::Create),
            kind: Some(RefinementKind::Factory),
            id: Some("sweep".to_string()),
            title: Some("Factory".into()),
            content: Some("Sweep review across changed files.".into()),
            ..Default::default()
        };
        // A dag object passes.
        edit.arguments = Some(serde_json::from_value(serde_json::json!({ "dag": dag })).unwrap());
        assert_eq!(validate_edit(&edit, None), None);
        // A machine object passes.
        edit.arguments =
            Some(serde_json::from_value(serde_json::json!({ "machine": machine })).unwrap());
        assert_eq!(validate_edit(&edit, None), None);
        // Both forms at once are rejected with the kernel wording.
        edit.arguments = Some(
            serde_json::from_value(serde_json::json!({ "dag": dag, "machine": machine })).unwrap(),
        );
        assert_eq!(
            validate_edit(&edit, None),
            Some("pass either dag or machine form, not both".to_string())
        );
        // Neither form (or a non-object spec) is rejected.
        edit.arguments = Some(serde_json::Map::default());
        assert_eq!(
            validate_edit(&edit, None),
            Some("factory entry requires a dag or machine object in arguments".to_string())
        );
        edit.arguments = Some(
            serde_json::from_value(serde_json::json!({ "machine": "not an object" })).unwrap(),
        );
        assert_eq!(
            validate_edit(&edit, None),
            Some("factory entry requires a dag or machine object in arguments".to_string())
        );
        edit.arguments = None;
        assert!(validate_edit(&edit, None)
            .unwrap()
            .contains("requires a dag or machine object"));
        // Delete edits carry no spec requirement.
        edit.action = Some(RefinementAction::Delete);
        assert_eq!(validate_edit(&edit, None), None);
        // An update that omits `arguments` keeps the stored spec (apply
        // preserves `before.arguments`), exactly like update_factory.
        edit.action = Some(RefinementAction::Update);
        edit.arguments = None;
        assert_eq!(validate_edit(&edit, None), None);
        // An update that does supply arguments gets the same shape checks.
        edit.arguments =
            Some(serde_json::from_value(serde_json::json!({ "machine": machine })).unwrap());
        assert_eq!(validate_edit(&edit, None), None);
        // JSON null is absent, exactly like the kernel's Python writers: a
        // valid dag with "machine": null is a dag-form edit, not both forms.
        edit.arguments = Some(
            serde_json::from_value(serde_json::json!({ "dag": dag, "machine": null })).unwrap(),
        );
        assert_eq!(validate_edit(&edit, None), None);
        edit.arguments = Some(
            serde_json::from_value(serde_json::json!({ "dag": dag, "machine": machine })).unwrap(),
        );
        assert_eq!(
            validate_edit(&edit, None),
            Some("pass either dag or machine form, not both".to_string())
        );
    }

    #[test]
    fn apply_create_update_delete() {
        let mut state = empty_harness_state();
        let proposal = RefinementProposal {
            summary: "add a memory".to_string(),
            rationale: "used twice".to_string(),
            expected_outcome: "faster".to_string(),
            edits: vec![create_memory_edit("m1", "Fact", "builds are green")],
        };
        let result = apply_refinement_proposal(
            &mut state,
            &proposal,
            ApplyOptions {
                id: "r1".to_string(),
                rollback_of: None,
                scope: Some(HarnessScope::Local),
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert_eq!(result.applied_edits.len(), 1);
        assert!(result.applied_edits[0].applied);
        let entry = &state.entries[&RefinementKind::Memory]["m1"];
        assert_eq!(entry.content, "builds are green");
        assert_eq!(entry.version, 1);
        assert_eq!(entry.scope, Some(HarnessScope::Local));
        // Duplicate create is rejected.
        let duplicate = apply_refinement_proposal(
            &mut state,
            &RefinementProposal {
                summary: "again".to_string(),
                rationale: String::new(),
                expected_outcome: String::new(),
                edits: vec![create_memory_edit("m1", "Fact", "again")],
            },
            ApplyOptions {
                id: "r2".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert!(!duplicate.applied_edits[0].applied);
        assert_eq!(
            duplicate.applied_edits[0].error.as_deref(),
            Some("entry already exists")
        );
        // Update bumps the version.
        let mut update_edit = create_memory_edit("m1", "Fact", "updated fact");
        update_edit.action = Some(RefinementAction::Update);
        apply_refinement_proposal(
            &mut state,
            &RefinementProposal {
                summary: "update".to_string(),
                rationale: String::new(),
                expected_outcome: String::new(),
                edits: vec![update_edit],
            },
            ApplyOptions {
                id: "r3".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert_eq!(state.entries[&RefinementKind::Memory]["m1"].version, 2);
        // Rollback restores the original content and keeps history.
        let rollback = rollback_proposal(&result);
        let rolled = apply_refinement_proposal(
            &mut state,
            &rollback,
            ApplyOptions {
                id: "r4".to_string(),
                rollback_of: Some("r1".to_string()),
                scope: None,
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert!(rolled.applied_edits[0].applied);
        // r1 created m1 with no before snapshot, so the rollback deletes it.
        assert!(!state.entries[&RefinementKind::Memory].contains_key("m1"));
    }

    #[test]
    fn resolves_update_id_from_target_property_or_rationale_when_id_omitted() {
        let mut state = empty_harness_state();
        let init_prop = RefinementProposal {
            summary: "Initial create".to_string(),
            rationale: String::new(),
            expected_outcome: String::new(),
            edits: vec![create_memory_edit(
                "manualbook_recheck_inflight",
                "Manual-book audit v8",
                "Status v8",
            )],
        };
        apply_refinement_proposal(
            &mut state,
            &init_prop,
            ApplyOptions {
                id: "refine_init".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );

        // 1. Model put id in rationale
        let prop1 = normalize_refinement_proposal(&serde_json::json!({
            "summary": "Refined state",
            "rationale": "Update manualbook_recheck_inflight to v9 recording the completed full-suite capture",
            "edits": [
                {
                    "action": "update",
                    "kind": "memory",
                    "title": "Manual-book audit v9",
                    "content": "Status v9 verified"
                }
            ]
        }));
        let res1 = apply_refinement_proposal(
            &mut state,
            &prop1,
            ApplyOptions {
                id: "refine_rat_match".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert_eq!(res1.applied_edits.len(), 1);
        assert!(res1.applied_edits[0].applied);
        assert_eq!(res1.applied_edits[0].id, "manualbook_recheck_inflight");
        assert_eq!(
            state.entries[&RefinementKind::Memory]["manualbook_recheck_inflight"].content,
            "Status v9 verified"
        );

        // 2. Model put id in target property
        let prop2 = normalize_refinement_proposal(&serde_json::json!({
            "edits": [
                {
                    "action": "update",
                    "kind": "memory",
                    "target": "manualbook_recheck_inflight",
                    "title": "Manual-book audit v10",
                    "content": "Status v10 verified"
                }
            ]
        }));
        let res2 = apply_refinement_proposal(
            &mut state,
            &prop2,
            ApplyOptions {
                id: "refine_target_match".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert_eq!(res2.applied_edits.len(), 1);
        assert!(res2.applied_edits[0].applied);
        assert_eq!(res2.applied_edits[0].id, "manualbook_recheck_inflight");

        // 3. Model wrote update with backtick ID in reason
        let prop3 = normalize_refinement_proposal(&serde_json::json!({
            "edits": [
                {
                    "action": "update",
                    "kind": "memory",
                    "reason": "Updating `manualbook_recheck_inflight` with latest verification findings",
                    "title": "Manual-book audit v11",
                    "content": "Status v11 verified"
                }
            ]
        }));
        let res3 = apply_refinement_proposal(
            &mut state,
            &prop3,
            ApplyOptions {
                id: "refine_reason_backtick_match".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert_eq!(res3.applied_edits.len(), 1);
        assert!(res3.applied_edits[0].applied);
        assert_eq!(res3.applied_edits[0].id, "manualbook_recheck_inflight");

        // 4. Model put bracket prefix in title
        let prop4 = normalize_refinement_proposal(&serde_json::json!({
            "edits": [
                {
                    "action": "update",
                    "kind": "memory",
                    "title": "[local:manualbook_recheck_inflight] Manual-book audit v12",
                    "content": "Status v12 verified"
                }
            ]
        }));
        let res4 = apply_refinement_proposal(
            &mut state,
            &prop4,
            ApplyOptions {
                id: "refine_title_bracket_match".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert_eq!(res4.applied_edits.len(), 1);
        assert!(res4.applied_edits[0].applied);
        assert_eq!(res4.applied_edits[0].id, "manualbook_recheck_inflight");

        // 5. Smart resolution: omitted ID but title prefix and word overlap matches existing entry
        let prop5 = normalize_refinement_proposal(&serde_json::json!({
            "edits": [
                {
                    "action": "update",
                    "kind": "memory",
                    "title": "Manual-book audit v13",
                    "content": "Status v13 verified"
                }
            ]
        }));
        let res5 = apply_refinement_proposal(
            &mut state,
            &prop5,
            ApplyOptions {
                id: "refine_smart_prefix_match".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert_eq!(res5.applied_edits.len(), 1);
        assert!(res5.applied_edits[0].applied);
        assert_eq!(res5.applied_edits[0].id, "manualbook_recheck_inflight");
        assert_eq!(
            state.entries[&RefinementKind::Memory]["manualbook_recheck_inflight"].content,
            "Status v13 verified"
        );
    }

    #[test]
    fn factory_edits_refuse_while_the_opt_in_is_disabled() {
        // The opt-in gate on the apply path: while `factory.enabled` is
        // off, a refinement cannot author or re-author factory entries —
        // the same refusal, byte for byte, the kernel-side factory
        // writers raise (`rlm.factory.require_factory_enabled`).
        let machine = serde_json::json!({
            "states": [{ "id": "collect", "entry": true, "subagent": "worker" }],
            "transitions": []
        });
        let factory_edit = |action: RefinementAction, id: &str| RefinementEdit {
            action: Some(action),
            kind: Some(RefinementKind::Factory),
            id: Some(id.to_string()),
            title: Some("Factory".into()),
            content: Some("Sweep review across changed files.".into()),
            arguments: Some(
                serde_json::from_value(serde_json::json!({ "machine": machine })).unwrap(),
            ),
            ..Default::default()
        };
        let mut state = empty_harness_state();
        let proposal = |edits: Vec<RefinementEdit>| RefinementProposal {
            summary: "sweep".to_string(),
            rationale: String::new(),
            expected_outcome: String::new(),
            edits,
        };
        let disabled = apply_refinement_proposal(
            &mut state,
            &proposal(vec![factory_edit(RefinementAction::Create, "sweep")]),
            ApplyOptions {
                id: "r1".to_string(),
                rollback_of: None,
                scope: Some(HarnessScope::Local),
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert!(!disabled.applied_edits[0].applied);
        assert_eq!(
            disabled.applied_edits[0].error.as_deref(),
            Some(super::super::FACTORY_DISABLED_MESSAGE)
        );
        assert!(state.entries[&RefinementKind::Factory].is_empty());
        // An update of a stored entry refuses too: cleanup is not
        // authoring, but re-authoring while disabled is.
        state
            .entries
            .get_mut(&RefinementKind::Factory)
            .unwrap()
            .insert(
                "sweep".to_string(),
                HarnessEntry {
                    id: "sweep".to_string(),
                    kind: RefinementKind::Factory,
                    title: "Factory".to_string(),
                    content: "Sweep.".to_string(),
                    path: "general".to_string(),
                    scope: Some(HarnessScope::Local),
                    reference: serde_json::Map::default(),
                    arguments: serde_json::Map::default(),
                    metadata: serde_json::Map::default(),
                    source: "refine".to_string(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    version: 1,
                },
            );
        let refused_update = apply_refinement_proposal(
            &mut state,
            &proposal(vec![factory_edit(RefinementAction::Update, "sweep")]),
            ApplyOptions {
                id: "r2".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert!(!refused_update.applied_edits[0].applied);
        assert_eq!(
            refused_update.applied_edits[0].error.as_deref(),
            Some(super::super::FACTORY_DISABLED_MESSAGE)
        );
        // A delete is not authoring: cleanup stays available while
        // disabled (the gate's documented split).
        let cleanup = apply_refinement_proposal(
            &mut state,
            &proposal(vec![{
                let mut edit = factory_edit(RefinementAction::Delete, "sweep");
                edit.arguments = None;
                edit
            }]),
            ApplyOptions {
                id: "r3".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
                factory_enabled: false,
            },
        );
        assert!(cleanup.applied_edits[0].applied);
        assert!(state.entries[&RefinementKind::Factory].is_empty());
    }

    #[test]
    fn factory_edits_apply_when_the_opt_in_is_enabled() {
        let machine = serde_json::json!({
            "states": [{ "id": "collect", "entry": true, "subagent": "worker" }],
            "transitions": []
        });
        let mut state = empty_harness_state();
        let result = apply_refinement_proposal(
            &mut state,
            &RefinementProposal {
                summary: "sweep".to_string(),
                rationale: String::new(),
                expected_outcome: String::new(),
                edits: vec![RefinementEdit {
                    action: Some(RefinementAction::Create),
                    kind: Some(RefinementKind::Factory),
                    id: Some("sweep".to_string()),
                    title: Some("Factory".into()),
                    content: Some("Sweep review across changed files.".into()),
                    arguments: Some(
                        serde_json::from_value(serde_json::json!({ "machine": machine })).unwrap(),
                    ),
                    ..Default::default()
                }],
            },
            ApplyOptions {
                id: "r1".to_string(),
                rollback_of: None,
                scope: Some(HarnessScope::Local),
                baseline_state: None,
                factory_enabled: true,
            },
        );
        assert!(result.applied_edits[0].applied);
        assert!(result.applied_edits[0].error.is_none());
        assert!(state.entries[&RefinementKind::Factory].contains_key("sweep"));
    }
}
