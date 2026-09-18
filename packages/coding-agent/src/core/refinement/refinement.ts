import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import { realpathIfPresentSync, writeFileAtomicSync } from "../../utils/atomic-file.js";
import { serializeConversation } from "../compaction/utils.js";
import { convertToLlm } from "../messages.js";
import { completeWithProviderRetry, type ProviderRetryPolicy } from "../provider-retry.js";
import type { CustomEntry } from "../session-manager.js";
import { getAuxiliaryThinkingLevel } from "../thinking-levels.js";

export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";

export const REFINE_SKILL_NAME = "refine";
const HARNESS_STATE_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;

/**
 * Bump when the fingerprinted material or its canonical serialization changes,
 * so fingerprints minted under different versions never compare equal.
 * Normalizing a render-ignored flag out of the material does not need a
 * bump: fingerprint equality still implies identical renders (with IPython
 * examples off the normalization is a no-op; with them on, equality means
 * the shell flag was already false, i.e. identical renders), so equality
 * across the change is render-safe.
 */
const HARNESS_DIGEST_FINGERPRINT_VERSION = 1;

export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessState {
	schema: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	reason?: string;
}

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

export interface RefineOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
	retry?: ProviderRetryPolicy;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

const REFINEMENT_SYSTEM_PROMPT = `You are Prime Agent's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets Prime Agent improve reusable behavior
outside the token history.
Use "continual harness" for that persistent artifact layer; keep "RLM" for the
runtime, Python REPL kernel, and native call interface that executes those artifacts.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the Python callable truly needs no external inputs. Include the RLM-native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \`handle = await rlm.spawn("sub-task", name="worker")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- For update and delete actions, you MUST include the exact \`id\` field of the target entry from <current_harness_state> (e.g. \`"id": "local_pi_web_mvp_state"\`). Never omit the \`id\` field on update or delete edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are Prime Agent's automatic /refine review gate.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

// These caps apply only with reasoning off; thinking and JSON otherwise share the model's output budget.
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;
const REFINEMENT_CONTEXT_OVERHEAD_TOKENS = 1_024;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function refinementInputTokenBound(text: string): number {
	// One token per UTF-8 byte bounds byte-based tokenizers, including dense or unusual text.
	return Buffer.byteLength(text, "utf8");
}

function refinementRequest(
	model: Model<Api>,
	systemPrompt: string,
	conversationText: string,
	buildPrompt: (conversation: string) => string,
	outputReserve: number,
): { model: Model<Api>; userPrompt: string } {
	const systemReserve = refinementInputTokenBound(systemPrompt) + REFINEMENT_CONTEXT_OVERHEAD_TOKENS;
	const inputBudget =
		model.contextWindow - Math.min(model.maxTokens, outputReserve, Math.floor(model.contextWindow / 2));
	let userPrompt = buildPrompt(conversationText);
	if (systemReserve + refinementInputTokenBound(userPrompt) > inputBudget && conversationText.length > 0) {
		const promptForLength = (length: number): string => {
			let start = conversationText.length - length;
			const first = conversationText.charCodeAt(start);
			if (first >= 0xdc00 && first <= 0xdfff) start++;
			return buildPrompt(
				`[Earlier conversation omitted to fit the model context.]\n${conversationText.slice(start)}`,
			);
		};
		let low = 0;
		let high = conversationText.length;
		while (low < high) {
			const length = Math.ceil((low + high) / 2);
			if (systemReserve + refinementInputTokenBound(promptForLength(length)) <= inputBudget) low = length;
			else high = length - 1;
		}
		userPrompt = promptForLength(low);
	}
	const maxTokens = Math.min(
		model.maxTokens,
		model.contextWindow - systemReserve - refinementInputTokenBound(userPrompt),
	);
	if (maxTokens <= 0) {
		throw new Error(
			"Refinement prompt leaves no room for output in the model's context window; retry with a smaller request.",
		);
	}
	// Bound the request's model ceiling too: some adapters add thinking tokens before clamping to it.
	return { model: { ...model, maxTokens }, userPrompt };
}

function now(): string {
	return new Date().toISOString();
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? JSON.parse(JSON.stringify(entry)) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function normalizeHarnessScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

export function inferRefinementResultScope(result: RefinementResult): HarnessScope | undefined {
	if (result.scope) {
		return result.scope;
	}

	const scopes = new Set<HarnessScope>();
	for (const edit of result.appliedEdits) {
		const scope = edit.after?.scope ?? edit.before?.scope;
		if (scope) {
			scopes.add(scope);
		}
	}
	return scopes.size === 1 ? [...scopes][0] : undefined;
}

function withDefaultRefinementScope(result: RefinementResult, scope: HarnessScope): RefinementResult {
	const inferred = inferRefinementResultScope(result);
	return { ...result, scope: inferred ?? scope };
}

export function getGlobalHarnessStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

export function getHarnessStatePath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, "harness_state.json");
}

export function loadHarnessState(
	harnessStateDir: string = getGlobalHarnessStateDir(),
	scope: HarnessScope = "global",
): HarnessState {
	const statePath = getHarnessStatePath(harnessStateDir);
	if (!existsSync(statePath)) {
		return emptyHarnessState();
	}
	let parsed: Partial<HarnessState>;
	try {
		const raw = JSON.parse(readFileSync(statePath, "utf8"));
		// loadHarnessState runs on every system-prompt build and before each /refine, so
		// a corrupt or unreadable (or non-object) state file must degrade to empty rather
		// than throw and break the session. The next saveHarnessState rewrites it cleanly.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return emptyHarnessState();
		}
		parsed = raw as Partial<HarnessState>;
	} catch {
		return emptyHarnessState();
	}
	const state = emptyHarnessState();
	state.schema = typeof parsed.schema === "number" ? parsed.schema : 1;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const records = parsed.entries?.[kind];
		if (records && typeof records === "object") {
			for (const [id, rawEntry] of Object.entries(records)) {
				const entry = objectRecord(rawEntry);
				if (!entry) continue;
				state.entries[kind][id] = {
					...(entry as unknown as HarnessEntry),
					scope: normalizeHarnessScope(entry.scope, scope),
					reference: objectRecord(entry.reference) ?? {},
					arguments: objectRecord(entry.arguments) ?? {},
					metadata: objectRecord(entry.metadata) ?? {},
				};
			}
		}
	}
	if (Array.isArray(parsed.refinements)) {
		state.refinements = parsed.refinements;
	}
	return state;
}

export function mergeHarnessStates(globalState: HarnessState, localState?: HarnessState): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			const cloned = cloneEntry(entry)!;
			merged.entries[kind][id] = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "global") };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const cloned = cloneEntry(entry)!;
			const scopedEntry = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `${scopedEntry.scope}:${id}` : id;
			merged.entries[kind][mergedId] = scopedEntry;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

export function saveHarnessState(harnessStateDir: string, state: HarnessState): string {
	const statePath = getHarnessStatePath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	const targetPath = realpathIfPresentSync(statePath);
	const mode = existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : 0o600;
	writeFileAtomicSync(targetPath, `${JSON.stringify(state, null, 2)}\n`, { mode });
	return statePath;
}

export function getRefinementHistoryPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

function isRefinementResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}

/**
 * Append a global-scope refinement to the cross-session history log so it can be
 * rolled back from any session. Local-scope refinements are recorded only in the
 * session JSONL and roll back via their recorded harnessStatePath.
 */
export function appendGlobalRefinement(harnessStateDir: string, result: RefinementResult): string {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	appendFileSync(historyPath, `${JSON.stringify(result)}\n`, "utf8");
	return historyPath;
}

export function loadGlobalRefinementHistory(harnessStateDir: string = getGlobalHarnessStateDir()): RefinementResult[] {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	if (!existsSync(historyPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	for (const line of readFileSync(historyPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRefinementResult(parsed)) {
				results.push(withDefaultRefinementScope(parsed, "global"));
			}
		} catch {
			// Skip malformed lines so a single bad append cannot break rollback.
		}
	}
	return results;
}

/**
 * Merge global and session refinement history, de-duplicating by id. Session entries
 * win on conflict so a session that is mid-flight still resolves its own latest result.
 */
export function mergeRefinementHistory(
	global: readonly RefinementResult[],
	session: readonly RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const result of global) {
		byId.set(result.id, result);
	}
	for (const result of session) {
		const existing = byId.get(result.id);
		byId.set(result.id, result.scope || !existing?.scope ? result : { ...result, scope: existing.scope });
	}
	return [...byId.values()];
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** Notice body in digest notation: trigger line plus applied edits as `action kind [scope:id] title: content`; rollbacks print via their rollback summaries. */
export function formatRefinementNoticeBody(result: RefinementResult): string {
	const lines = [compactText(result.summary, DEFAULT_OVERVIEW_CONTENT_LIMIT)];
	for (const edit of result.appliedEdits) {
		if (!edit.applied) continue;
		const entry = edit.after ?? edit.before;
		const scope = entry?.scope ?? result.scope ?? "local";
		lines.push(
			`- ${edit.action} ${edit.kind} [${scope}:${edit.id}] ${entry?.title ?? edit.id}: ${compactText(
				entry?.content ?? "",
				DEFAULT_OVERVIEW_CONTENT_LIMIT,
			)}`,
		);
	}
	return lines.join("\n");
}

/**
 * Query terms for relevance-ranked harness digests: term -> weight.
 * Built by the caller from task signal (goal objective, recent
 * messages). The ranking is weighted term overlap over the entry's
 * searchable fields, discounted per term by document frequency in the
 * ranked corpus, so rare distinctive terms outweigh ubiquitous ones.
 */
export type HarnessQueryTerms = Map<string, number>;

/** Lowercase a possibly malformed persisted field. */
function searchableField(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

/** CJK ideographs, kana, and Hangul: scripts that do not mark word
 * boundaries with spaces. */
const CJK_TERM_RANGES =
	"\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af" +
	"\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}" +
	"\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{2ebf0}-\u{2ee5f}" +
	"\u{2f800}-\u{2fa1f}\u{30000}-\u{3134f}\u{31350}-\u{323af}\u{323b0}-\u{3347f}";
const CJK_TERM_PATTERN = new RegExp(`[${CJK_TERM_RANGES}]`, "u");
const CJK_TERM_SPLIT = new RegExp(`[${CJK_TERM_RANGES}]+|[^${CJK_TERM_RANGES}]+`, "gu");

/**
 * Tokenize text into lowercase query terms for harness relevance ranking.
 * Letters, digits, and combining marks of any script form terms; punctuation only
 * separate them, so a query like `worktree?` never ranks entries by their
 * question marks. CJK runs carry no spaces between words, so each run
 * becomes overlapping bigrams: `修复登录` yields 修复/复登/登录 and still
 * matches an entry containing 登录故障. Each distinct term is returned once.
 */
export function harnessQueryTerms(text: string): string[] {
	const terms: string[] = [];
	// \p{M} keeps combining marks inside their run so mark-heavy scripts
	// spell whole words (Devanagari किताब stays one run).
	for (const run of text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
		// Runs break only at CJK boundaries: accented Latin stays whole
		// (naïve) while spacing-free CJK is cut from adjacent words.
		for (const segment of run.match(CJK_TERM_SPLIT) ?? []) {
			if (CJK_TERM_PATTERN.test(segment)) {
				// Code points, not UTF-16 units, keep astral ideographs whole.
				const chars = Array.from(segment);
				if (chars.length === 1) terms.push(segment);
				else for (let i = 0; i < chars.length - 1; i += 1) terms.push(chars[i] + chars[i + 1]);
			} else if (segment.length >= 4) {
				// Short runs are noise (the, and, ids) and are dropped.
				terms.push(segment);
			}
		}
	}
	return [...new Set(terms)];
}

/**
 * Inverse document frequency per query term over the entries being
 * ranked: `log(1 + documents / matches)`. A term present in every entry
 * still weighs `log(2)`, while a term in one entry of N weighs
 * `log(1 + N)`, so rare distinctive terms outrank ubiquitous ones.
 * Terms matching no entry are absent (they cannot score anything).
 */
export function harnessQueryTermIdf(entries: HarnessEntry[], terms: HarnessQueryTerms): Map<string, number> {
	const idf = new Map<string, number>();
	if (terms.size === 0) return idf;
	let documents = 0;
	const matches = new Map<string, number>();
	for (const entry of entries) {
		documents += 1;
		const title = searchableField(entry.title);
		const content = searchableField(entry.content);
		const identifier = `${searchableField(entry.path)} ${searchableField(entry.id)}`;
		for (const term of terms.keys()) {
			if (title.includes(term) || content.includes(term) || identifier.includes(term)) {
				matches.set(term, (matches.get(term) ?? 0) + 1);
			}
		}
	}
	for (const [term, documentFrequency] of matches) {
		idf.set(term, Math.log(1 + documents / documentFrequency));
	}
	return idf;
}

/**
 * Score one harness entry against query terms: weighted term overlap,
 * with each matched term's weight discounted by its document frequency
 * in the ranked corpus (`idf`; a missing map weights every term at 1).
 */
export function scoreHarnessEntryForQuery(
	entry: HarnessEntry,
	terms: HarnessQueryTerms,
	idf?: Map<string, number>,
): number {
	if (terms.size === 0) return 0;
	const title = searchableField(entry.title);
	const content = searchableField(entry.content);
	const identifier = `${searchableField(entry.path)} ${searchableField(entry.id)}`;
	let score = 0;
	for (const [term, weight] of terms) {
		// One match per field counts once per term: coverage over distinct
		// fields matters more than repetition inside a single field. Path
		// and id form a single identifier slot: the id is often embedded in
		// the path, so matching both is one signal, not two.
		let fields = 0;
		if (title.includes(term)) fields += 1;
		if (content.includes(term)) fields += 1;
		if (identifier.includes(term)) fields += 1;
		if (fields > 0) {
			score += weight * (idf?.get(term) ?? 1) * (1 + (fields - 1) * 0.5);
		}
	}
	return score;
}

function compareRankedHarnessEntries(
	a: HarnessEntry,
	b: HarnessEntry,
	terms: HarnessQueryTerms,
	idf?: Map<string, number>,
): number {
	const scoreDifference = scoreHarnessEntryForQuery(b, terms, idf) - scoreHarnessEntryForQuery(a, terms, idf);
	if (scoreDifference !== 0) return scoreDifference;
	// Equal scores tie on stable identifier order (path, title, id), so
	// touching unrelated entries never reshuffles equal-score siblings and the
	// rendered digest keeps a stable prefix for provider prompt-cache reuse.
	return [a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0"));
}

export function formatHarnessStateForPrompt(
	state: HarnessState,
	options: {
		maxEntriesPerKind?: number;
		maxRefinements?: number;
		maxContentLength?: number;
		includeIpythonExamples?: boolean;
		includeShellExamples?: boolean;
		includeRefineExamples?: boolean;
		/** Select entries by relevance to these terms instead of
		 * alphabetical order. */
		queryTerms?: HarnessQueryTerms;
	} = {},
): string {
	const maxEntriesPerKind = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
	const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
	const maxContentLength = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
	const includeIpythonExamples = options.includeIpythonExamples ?? true;
	const includeRefineExamples = options.includeRefineExamples ?? includeIpythonExamples;
	const lines = [
		"# Continual Harness State",
		"",
		"Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
		"The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
		"Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
		"Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
		"",
		includeRefineExamples
			? "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed."
			: "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.",
		"",
		includeIpythonExamples
			? "Call contract: read each installed Python skill's SKILL.md and call its documented module function in the Python REPL; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm.spawn('sub-task', name='worker')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries."
			: options.includeShellExamples
				? "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without the Python REPL; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents a Python kernel."
				: "Call contract: continual harness entries are routing/context hints only in sessions without the Python REPL or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.",
		"",
	];

	const queryTerms = options.queryTerms;
	let totalEntries = 0;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		// The ranked corpus is the kind's own entries: they compete for the
		// same top-k slots, so document frequency discounts terms ubiquitous
		// within the kind rather than across unrelated kinds.
		const ranked = Object.values(state.entries[kind]);
		const idf = queryTerms !== undefined && queryTerms.size > 0 ? harnessQueryTermIdf(ranked, queryTerms) : undefined;
		const entries = ranked.sort((a, b) =>
			queryTerms !== undefined && queryTerms.size > 0
				? compareRankedHarnessEntries(a, b, queryTerms, idf)
				: [a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")),
		);
		totalEntries += entries.length;
		// Render subagent specs as a task-shaped roster the model can match against — the
		// analogue of Claude Code's agent-type menu — rather than a bare count. In
		// REPL sessions, include the native `rlm` invocation hint.
		if (kind === "subagent" && entries.length > 0 && includeIpythonExamples) {
			lines.push(
				`${kind}: ${entries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm.spawn('<task>', name='<worker>')\`; admission returns a child handle, never the answer)`,
			);
		} else {
			lines.push(`${kind}: ${entries.length}`);
		}
		if (queryTerms !== undefined && queryTerms.size > 0 && entries.length > maxEntriesPerKind) {
			lines.push("(entries ranked by relevance to the current task; see harness.search)");
		}
		for (const entry of entries.slice(0, maxEntriesPerKind)) {
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${compactText(
					entry.content,
					maxContentLength,
				)}`,
			);
		}
		const overflow = entries.length - Math.min(entries.length, maxEntriesPerKind);
		if (overflow > 0) {
			lines.push(`- +${overflow} more ${kind} entries`);
		}
		lines.push("");
	}

	if (totalEntries === 0) {
		lines.push("No saved harness entries yet.", "");
	}

	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
		lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
	}
	const refinementOverflow = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
	if (refinementOverflow > 0) {
		lines.push(`- +${refinementOverflow} older refinement events`);
	}

	return lines.join("\n").trim();
}

/**
 * Stable fingerprint of the harness material a digest renders. Equal states
 * (per the fields the digest actually prints) produce equal fingerprints, so
 * cold boundaries can skip digest re-delivery with a state comparison instead
 * of a rendered-text comparison that query-term relevance keeps invalidating.
 *
 * Covered: entry identity and content (entry order is normalized away, as is
 * the call contract on non-skill entries, which the formatter never prints),
 * plus the render flags and each refinement's printed fields in stored order,
 * since the formatter renders a positional newest tail. The shell-examples
 * flag participates only when IPython examples are not rendered: the formatter
 * never reads it then, so it is normalized out of the fingerprint to keep an
 * unchanged digest fresh. Excluded: `metadata`, `source`, and the invisible
 * `created_at`/`updated_at` bookkeeping, and relevance query terms (the
 * digest stays frozen per delivery; see `compareRankedHarnessEntries`).
 */
export function harnessDigestFingerprint(
	state: HarnessState,
	renderFlags: {
		includeIpythonExamples: boolean;
		includeShellExamples: boolean;
		includeRefineExamples: boolean;
	},
): string {
	const entries = (Object.keys(state.entries) as RefinementKind[])
		.flatMap((kind) => Object.values(state.entries[kind]))
		.map((entry) => ({
			scope: entry.scope ?? "global",
			kind: entry.kind,
			id: entry.id,
			title: entry.title,
			path: entry.path,
			version: entry.version,
			content: entry.content,
			// Only skills render the kernel call contract, so another kind can
			// change these fields without changing a single digest byte.
			reference: entry.kind === "skill" ? entry.reference : undefined,
			arguments: entry.kind === "skill" ? entry.arguments : undefined,
		}))
		.sort((a, b) => [a.scope, a.kind, a.id].join("\0").localeCompare([b.scope, b.kind, b.id].join("\0")));
	// Refinements keep their stored order: the formatter renders the newest
	// tail of the array, so an order-only change renders differently and must
	// not reuse the previous digest.
	const refinements = state.refinements.map((event) => ({
		id: event.id,
		trigger: event.trigger,
		changes: event.changes,
		outcome: event.outcome,
	}));
	// The formatter renders the shell call-contract only when IPython examples
	// are absent, so the shell flag cannot change the digest while IPython
	// examples take precedence; fingerprint only the flags the render reads.
	const effectiveRenderFlags = renderFlags.includeIpythonExamples
		? { ...renderFlags, includeShellExamples: false }
		: renderFlags;
	const material = JSON.stringify({
		version: HARNESS_DIGEST_FINGERPRINT_VERSION,
		renderFlags: effectiveRenderFlags,
		entries,
		refinements,
	});
	return createHash("sha256").update(material).digest("hex");
}

function overviewForPrompt(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, 40)) {
			const content = entry.content.replace(/\s+/g, " ").slice(0, 240);
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${content}`,
			);
		}
		if (entries.length > 40) {
			lines.push(`- +${entries.length - 40} more ${kind} entries`);
		}
	}
	return lines.join("\n");
}

function historyForPrompt(history: RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map((item) => {
			const edits = item.appliedEdits
				.map((edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
				.join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete in
 * this sense, while a complete-but-malformed reply is balanced. Brace slicing can
 * also produce a balanced fragment, so callers treat "balanced" as malformed.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	const startBrace = trimmed.indexOf("{");
	const endBrace = trimmed.lastIndexOf("}");
	const startBracket = trimmed.indexOf("[");
	const endBracket = trimmed.lastIndexOf("]");

	if (startBracket !== -1 && endBracket > startBracket && (startBrace === -1 || startBracket < startBrace)) {
		try {
			return JSON.parse(trimmed.slice(startBracket, endBracket + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(startBracket));
		}
	}
	if (startBrace !== -1 && endBrace > startBrace) {
		try {
			return JSON.parse(trimmed.slice(startBrace, endBrace + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(startBrace));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object or array");
}

/**
 * Normalizes an untrusted refinement proposal while preserving invalid edit
 * fields for apply-time validation.
 */
function normalizeAction(raw: unknown): RefinementAction {
	if (typeof raw !== "string") return "create";
	const lower = raw.trim().toLowerCase();
	if (lower === "add" || lower === "insert" || lower === "new" || lower === "create" || lower === "make" || lower === "append") return "create";
	if (lower === "edit" || lower === "modify" || lower === "patch" || lower === "update" || lower === "change" || lower === "put" || lower === "set") return "update";
	if (lower === "remove" || lower === "del" || lower === "delete" || lower === "drop" || lower === "rm" || lower === "clear") return "delete";
	return lower as RefinementAction;
}

function extractAction(edit: Record<string, unknown>): RefinementAction {
	const raw = edit.action ?? (edit as any).op ?? (edit as any).operation ?? (edit as any).verb ?? (edit as any).command;
	return normalizeAction(raw);
}

function normalizeKind(raw: unknown): { kind: RefinementKind; suggestedPath?: string } {
	if (typeof raw !== "string") return { kind: "memory" };
	const lower = raw.trim().toLowerCase();
	if (lower === "prompts" || lower === "prompt" || lower === "instruction" || lower === "policy" || lower === "rule" || lower === "rules" || lower === "system") {
		return { kind: "prompt" };
	}
	if (lower === "skills" || lower === "skill" || lower === "tool" || lower === "tools" || lower === "function" || lower === "functions") {
		return { kind: "skill" };
	}
	if (lower === "subagents" || lower === "subagent" || lower === "agent" || lower === "agents") {
		return { kind: "subagent" };
	}
	if (lower === "memories" || lower === "memory" || lower === "facts" || lower === "knowledge") {
		return { kind: "memory" };
	}
	// Models often output categories like "general", "fact", "decision", "lesson", "preference" as the kind
	return { kind: "memory", suggestedPath: lower };
}

function extractId(edit: Record<string, unknown>, contextText?: string): string | undefined {
	const raw =
		edit.id ??
		(edit as any).name ??
		(edit as any).key ??
		(edit as any).slug ??
		(edit as any).identifier ??
		(edit as any).target ??
		(edit as any).entry ??
		(edit as any).entryId ??
		(edit as any).entry_id ??
		(edit as any).targetId ??
		(edit as any).target_id ??
		(edit as any).itemId ??
		(edit as any).item_id ??
		(edit as any).item ??
		(edit as any).ref ??
		(typeof (edit as any).reference === "string" ? (edit as any).reference : undefined) ??
		(edit as any).originalId ??
		(edit as any).original_id ??
		(edit as any).existingId ??
		(edit as any).existing_id ??
		(edit as any).sourceId ??
		(edit as any).source_id;

	let idCandidate: string | undefined;

	if (typeof raw === "string") {
		idCandidate = raw;
	} else if (typeof raw === "object" && raw !== null) {
		idCandidate = (raw as any).id ?? (raw as any).name ?? (raw as any).key ?? (raw as any).slug;
	}

	// Nested entry or target objects
	if (!idCandidate && typeof (edit as any).entry === "object" && (edit as any).entry !== null) {
		idCandidate = (edit as any).entry.id ?? (edit as any).entry.name ?? (edit as any).entry.key;
	}
	if (!idCandidate && typeof (edit as any).target === "object" && (edit as any).target !== null) {
		idCandidate = (edit as any).target.id ?? (edit as any).target.name ?? (edit as any).target.key;
	}

	// Check if path was used as a bare snake_case ID
	if (!idCandidate && typeof edit.path === "string") {
		const p = edit.path.trim();
		if (p && !p.includes("/") && /^[a-zA-Z0-9_-]+$/.test(p)) {
			if (p.includes("_") || p.startsWith("local:") || p.startsWith("global:")) {
				idCandidate = p;
			}
		}
	}

	// Check title for [local:xxx] or (local:xxx) or [global:xxx] or (global:xxx)
	if (!idCandidate && typeof edit.title === "string") {
		const match = edit.title.match(/[\[\(](?:local|global):([a-zA-Z0-9_-]+)[\]\)]/);
		if (match) idCandidate = match[1];
	}

	// Check content for [local:xxx] or (local:xxx) in first 200 chars
	if (!idCandidate && typeof (edit as any).content === "string") {
		const match = ((edit as any).content as string).slice(0, 200).match(/[\[\(](?:local|global):([a-zA-Z0-9_-]+)[\]\)]/);
		if (match) idCandidate = match[1];
	}

	// Improved regex that matches identifiers enclosed in backticks, brackets, bold, quotes
	const actionMentionRegex = /(?:update|updating|modify|modifying|patch|patching|delete|deleting|remove|removing|refine|refining)\s+(?:the\s+)?(?:entry\s+|memory\s+|prompt\s+|skill\s+|subagent\s+)?[\`\[\*\"]*(?:local:|global:)?([a-zA-Z0-9_-]{3,60})[\`\]\*\"]*/i;
	const ignoredWords = new Set(["the", "a", "an", "this", "that", "entry", "entries", "memory", "memories", "prompt", "prompts", "skill", "skills", "subagent", "subagents", "to", "from", "harness", "continual", "state", "with", "for", "and"]);

	// Check edit reason / notes / explanation / rationale
	if (!idCandidate) {
		const candidateTexts = [(edit as any).reason, (edit as any).notes, (edit as any).explanation, (edit as any).rationale];
		for (const ct of candidateTexts) {
			if (typeof ct === "string") {
				const match = ct.match(actionMentionRegex);
				if (match && !ignoredWords.has(match[1].toLowerCase())) {
					idCandidate = match[1];
					break;
				}
			}
		}
	}

	// Check proposal summary / rationale context text
	if (!idCandidate && typeof contextText === "string" && contextText.trim().length > 0) {
		const match = contextText.match(actionMentionRegex);
		if (match && !ignoredWords.has(match[1].toLowerCase())) {
			idCandidate = match[1];
		}
	}

	if (typeof idCandidate !== "string") return undefined;
	const trimmed = idCandidate.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("local:")) return trimmed.slice(6).trim();
	if (trimmed.startsWith("global:")) return trimmed.slice(7).trim();
	return trimmed;
}

function extractTitle(edit: Record<string, unknown>): string | undefined {
	const candidates = [
		edit.title,
		(edit as any).header,
		(edit as any).subject,
		(edit as any).label,
		(edit as any).heading,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	if (typeof (edit as any).name === "string" && (edit as any).name.trim().length > 0 && edit.id && (edit as any).name !== edit.id) {
		return (edit as any).name.trim();
	}
	return undefined;
}

function extractContent(edit: Record<string, unknown>): string | undefined {
	const candidates = [
		edit.content,
		(edit as any).value,
		(edit as any).text,
		(edit as any).body,
		(edit as any).description,
		(edit as any).desc,
		(edit as any).note,
		(edit as any).notes,
		(edit as any).details,
		(edit as any).detail,
		(edit as any).data,
		(edit as any).instruction,
		(edit as any).instructions,
		(edit as any).rule,
		(edit as any).rules,
		(edit as any).statement,
		(edit as any).memory,
		(edit as any).prompt,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
		if (Array.isArray(candidate) && candidate.length > 0) {
			const joined = candidate
				.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
				.join("\n")
				.trim();
			if (joined.length > 0) return joined;
		}
		if (typeof candidate === "object" && candidate !== null) {
			const inner = (candidate as any).text ?? (candidate as any).content ?? (candidate as any).value;
			if (typeof inner === "string" && inner.trim().length > 0) {
				return inner.trim();
			}
			try {
				const str = JSON.stringify(candidate, null, 2);
				if (str && str !== "{}") return str;
			} catch {}
		}
	}
	return undefined;
}

function deriveTitle(rawTitle: unknown, content: unknown, id: unknown, kind: RefinementKind): string {
	if (typeof rawTitle === "string" && rawTitle.trim().length > 0) return rawTitle.trim();
	if (typeof id === "string" && id.trim().length > 0) return id.trim().replace(/_/g, " ");
	if (typeof content === "string" && content.trim().length > 0) {
		const firstLine = content.trim().split("\n")[0].replace(/^[#*\-\s]+/, "").trim();
		if (firstLine.length > 0) return firstLine.slice(0, 60);
	}
	return `${kind} item`;
}

export function normalizeRefinementProposal(value: unknown): RefinementProposal {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const rawEdits =
		Array.isArray(record.edits) ? record.edits :
		Array.isArray((record as any).changes) ? (record as any).changes :
		Array.isArray((record as any).items) ? (record as any).items :
		Array.isArray((record as any).entries) ? (record as any).entries :
		Array.isArray((record as any).proposals) ? (record as any).proposals :
		[];
	const summary = typeof record.summary === "string" ? record.summary : "Refined continual harness state";
	const rationale =
		typeof record.rationale === "string"
			? record.rationale
			: typeof (record as any).reason === "string"
				? (record as any).reason
				: "";

	return {
		summary,
		rationale,
		expectedOutcome:
			typeof record.expectedOutcome === "string"
				? record.expectedOutcome
				: typeof (record as any).outcome === "string"
					? (record as any).outcome
					: "",
		edits: rawEdits
			.filter((edit: unknown): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
			.map((edit: Record<string, unknown>) => {
				const action = extractAction(edit);
				const rawKind = edit.kind ?? (edit as any).layer ?? (edit as any).type ?? (edit as any).component ?? (edit as any).category;
				const { kind, suggestedPath } = normalizeKind(rawKind);
				const contextText = `${summary} ${rationale}`.trim() || undefined;
				const rawId = extractId(edit, contextText);
				const rawTitle = extractTitle(edit);
				const content = extractContent(edit);
				const title = deriveTitle(rawTitle, content, rawId, kind);

				return {
					action,
					kind,
					id: rawId,
					title,
					content,
					path: typeof edit.path === "string" ? edit.path : suggestedPath,
					reference: objectRecord(edit.reference),
					arguments: objectRecord(edit.arguments),
					metadata:
						typeof edit.metadata === "object" && edit.metadata !== null && !Array.isArray(edit.metadata)
							? (edit.metadata as Record<string, unknown>)
							: undefined,
					reason: typeof edit.reason === "string" ? edit.reason : undefined,
				};
			}),
	};
}

function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	if (Array.isArray(value)) {
		return normalizeRefinementProposal({ edits: value });
	}
	if (typeof value !== "object" || value === null) {
		throw new Error("Refiner JSON must be an object or array");
	}
	const rec = value as Record<string, unknown>;
	if (
		!Array.isArray(rec.edits) &&
		!Array.isArray((rec as any).changes) &&
		!Array.isArray((rec as any).items) &&
		!Array.isArray((rec as any).entries) &&
		!Array.isArray((rec as any).proposals) &&
		Boolean(rec.action || (rec as any).op || (rec as any).operation || rec.content || (rec as any).value || (rec as any).text || (rec as any).component || rec.kind || (rec as any).name || (rec as any).key)
	) {
		return normalizeRefinementProposal({ edits: [rec] });
	}
	return normalizeRefinementProposal(value);
}

function validateEdit(edit: RefinementEdit, computedId?: string, beforeEntry?: HarnessEntry): string | undefined {
	if (!["create", "update", "delete"].includes(edit.action)) {
		return `unsupported action ${String(edit.action)}`;
	}
	if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {
		return `unsupported kind ${String(edit.kind)}`;
	}
	if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {
		return "base system prompt is not editable";
	}
	if (edit.action !== "create" && !edit.id) {
		return `${edit.action} requires id`;
	}
	if (edit.action !== "delete" && (!edit.title || !edit.content)) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill" && edit.arguments === undefined) {
		return `${edit.action} skill requires arguments`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		const reference = edit.reference;
		if (!reference) {
			return `${edit.action} skill requires python reference`;
		}
		if (reference.type !== "python") {
			return `${edit.action} skill reference.type must be python`;
		}
		const hasImport =
			(typeof reference.import === "string" && reference.import.length > 0) ||
			(typeof reference.python_import === "string" && reference.python_import.length > 0);
		const hasCallable =
			(typeof reference.callable === "string" && reference.callable.length > 0) ||
			(typeof reference.call_pattern === "string" && reference.call_pattern.length > 0);
		if (!hasImport) {
			return `${edit.action} skill requires python import`;
		}
		if (!hasCallable) {
			return `${edit.action} skill requires callable or call_pattern`;
		}
	}
	return undefined;
}

export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
): RefinementResult {
	const appliedEdits: AppliedRefinementEdit[] = [];
	const proposalModifiedKeys = new Set<string>();
	for (const edit of proposal.edits) {
		let currentAction = edit.action;
		let id = edit.id ?? (currentAction === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
		const records = state.entries[edit.kind];

		// If action is update/delete but no ID was extracted, attempt smart resolution against state records
		if (!id && currentAction !== "create") {
			if (records && Object.keys(records).length > 0) {
				const recordKeys = Object.keys(records);
				const normTitle = (edit.title || "").toLowerCase();
				const normContent = (edit.content || "").toLowerCase();

				// 1. Check if an existing entry ID appears in edit.title or edit.content
				let matchedKey: string | undefined;
				for (const key of recordKeys) {
					const kNorm = key.toLowerCase();
					const kWords = kNorm.replace(/[^a-z0-9]/g, " ").split(" ").filter((w) => w.length >= 3);
					if (normTitle.includes(kNorm) || normContent.includes(kNorm)) {
						matchedKey = key;
						break;
					}
					// Also check if entry title is contained in edit.title
					const existingTitle = (records[key]?.title || "").toLowerCase();
					if (existingTitle && (normTitle.includes(existingTitle) || existingTitle.includes(normTitle))) {
						matchedKey = key;
						break;
					}
					// Check for word overlap with key parts
					const titleWords = new Set(normTitle.replace(/[^a-z0-9]/g, " ").split(" ").filter((w) => w.length >= 3));
					const overlap = kWords.filter((w) => titleWords.has(w));
					if (overlap.length >= 2) {
						matchedKey = key;
						break;
					}
				}

				// 2. Check title prefix before version/colon/parenthesis (e.g. "pi-web build state", "manual-book audit")
				if (!matchedKey && edit.title) {
					const getTitlePrefix = (t: string): string => {
						const clean = t.replace(/^[\[\(].*?[\]\)]\s*/, "");
						const m = /^(.*?)(?:\s+v\d+|\s*:\s*|\s*\()/i.exec(clean);
						const p = m ? m[1].trim() : clean.trim();
						return p.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
					};
					const editPrefix = getTitlePrefix(edit.title);
					if (editPrefix.length >= 5) {
						for (const key of recordKeys) {
							const entryPrefix = getTitlePrefix(records[key]?.title || "");
							if (entryPrefix.length >= 5 && (editPrefix === entryPrefix || editPrefix.includes(entryPrefix) || entryPrefix.includes(editPrefix))) {
								matchedKey = key;
								break;
							}
						}
					}
				}

				// 3. Check significant word overlap between edit title and existing entry title (>= 3 words)
				if (!matchedKey && edit.title) {
					const stopWords = new Set(["for", "and", "the", "with", "from", "state", "into", "that", "this"]);
					const editWords = new Set(
						normTitle
							.replace(/[^a-z0-9]/g, " ")
							.split(" ")
							.filter((w) => w.length >= 3 && !stopWords.has(w)),
					);
					let bestOverlap = 0;
					for (const key of recordKeys) {
						const entryTitle = (records[key]?.title || "").toLowerCase();
						const entryWords = entryTitle
							.replace(/[^a-z0-9]/g, " ")
							.split(" ")
							.filter((w) => w.length >= 3 && !stopWords.has(w));
						const overlap = entryWords.filter((w) => editWords.has(w)).length;
						if (overlap >= 3 && overlap > bestOverlap) {
							bestOverlap = overlap;
							matchedKey = key;
						}
					}
				}

				// 4. Check unique path match
				if (!matchedKey && edit.path) {
					const pathMatches = recordKeys.filter((key) => records[key]?.path === edit.path);
					if (pathMatches.length === 1) {
						matchedKey = pathMatches[0];
					}
				}

				// 5. Check if slug of edit.title matches an existing entry
				if (!matchedKey && edit.title) {
					const s = slug(edit.title, edit.kind);
					if (records[s]) matchedKey = s;
				}

				if (matchedKey) {
					id = matchedKey;
				}
			}

			// 3. Check if title starts with an existing key (e.g. "local_pi_web_mvp_state: ...")
			if (!id && edit.title) {
				const firstWord = edit.title.trim().split(/[\s:,\(]/)[0].toLowerCase().replace(/^\[?(?:local|global):/, "").replace(/[\`\]\*]/g, "");
				if (records && records[firstWord]) {
					id = firstWord;
				}
			}
		}

		const finalId = id ?? "";
		let effectiveEdit = currentAction !== edit.action ? { ...edit, action: currentAction, id: finalId } : { ...edit, id: finalId };
		const before = records ? cloneEntry(records[finalId]) : undefined;

		const validationError = validateEdit(effectiveEdit, finalId, before);
		if (validationError) {
			appliedEdits.push({ ...effectiveEdit, id: finalId, applied: false, error: validationError });
			continue;
		}
		const entryKey = `${effectiveEdit.kind}:${finalId}`;
		const baseline = cloneEntry(options.baselineState?.entries[effectiveEdit.kind][finalId]);
		if (
			options.baselineState &&
			!proposalModifiedKeys.has(entryKey) &&
			JSON.stringify(before) !== JSON.stringify(baseline)
		) {
			appliedEdits.push({
				...effectiveEdit,
				id: finalId,
				before,
				applied: false,
				error: "entry changed during refinement planning",
			});
			continue;
		}
		if (effectiveEdit.action === "delete") {
			if (!before) {
				appliedEdits.push({ ...effectiveEdit, id: finalId, applied: false, error: "entry not found" });
				continue;
			}
			delete records[finalId];
			proposalModifiedKeys.add(entryKey);
			appliedEdits.push({ ...effectiveEdit, id: finalId, before, applied: true });
			continue;
		}
		if (effectiveEdit.action === "create" && before) {
			appliedEdits.push({ ...effectiveEdit, id: finalId, before, applied: false, error: "entry already exists" });
			continue;
		}
		if (effectiveEdit.action === "update" && !before) {
			appliedEdits.push({ ...effectiveEdit, id: finalId, applied: false, error: "entry not found" });
			continue;
		}

		const createdAt = before?.created_at ?? now();
		const version = before ? before.version + 1 : 1;
		const after: HarnessEntry = {
			id: finalId,
			kind: effectiveEdit.kind,
			title: effectiveEdit.title ?? before?.title ?? finalId,
			content: effectiveEdit.content ?? before?.content ?? "",
			path: effectiveEdit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: effectiveEdit.reference ?? before?.reference ?? {},
			arguments: effectiveEdit.arguments ?? before?.arguments ?? {},
			metadata: effectiveEdit.metadata ?? before?.metadata ?? {},
			source: "refine",
			created_at: createdAt,
			updated_at: now(),
			version,
		};
		records[finalId] = after;
		proposalModifiedKeys.add(entryKey);
		appliedEdits.push({ ...effectiveEdit, id: finalId, before, after: cloneEntry(after), applied: true });
	}

	const changes = appliedEdits.filter((edit) => edit.applied).map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now(),
	});

	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		harnessStatePath: "",
		rollbackOf: options.rollbackOf,
		scope: options.scope,
	};
}

function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			edits.push({
				action: edit.after ? "update" : "create",
				kind: edit.kind,
				id: edit.id,
				title: edit.before.title,
				content: edit.before.content,
				path: edit.before.path,
				reference: edit.before.reference,
				arguments: edit.before.arguments,
				metadata: edit.before.metadata,
				reason: `Rollback ${target.id}`,
			});
		} else if (edit.after) {
			edits.push({
				action: "delete",
				kind: edit.kind,
				id: edit.id,
				reason: `Rollback ${target.id}`,
			});
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}

export function getRefinementHistory(entries: readonly CustomEntry[]): RefinementResult[] {
	return entries
		.filter((entry) => entry.customType === REFINEMENT_CUSTOM_TYPE)
		.map((entry) => entry.data)
		.filter((data): data is RefinementResult => {
			return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
		});
}

export interface RefinementPlan {
	proposal: RefinementProposal;
	id: string;
	rollbackOf?: string;
	rollbackScope?: HarnessScope;
	/** Target-scope state captured before planning, used to reject conflicting edits at apply time. */
	baselineState?: HarnessState;
}

/**
 * Produce a refinement proposal (the LLM pass, or a rollback proposal) without
 * mutating any harness state. Separated from {@link applyRefinementProposal} so
 * callers can re-read the harness file immediately before applying — the LLM call
 * here can take many seconds, during which the kernel or another session may write
 * the shared `harness_state.json`.
 */
/** Mint a refinement id in the canonical `refine_<timestamp>` format. */
export function generateRefinementId(): string {
	return `refine_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
}

export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	sessionId?: string,
): Promise<RefinementPlan> {
	const id = generateRefinementId();
	if (options.rollbackId) {
		const target = history.find((item) => item.id === options.rollbackId);
		if (!target) {
			throw new Error(`Refinement ${options.rollbackId} not found`);
		}
		const fallbackScope: HarnessScope = options.global ? "global" : "local";
		return {
			proposal: rollbackProposal(target),
			id,
			rollbackOf: target.id,
			rollbackScope: inferRefinementResultScope(target) ?? fallbackScope,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages)).slice(-80_000);
	const scopeInstruction = options.global
		? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
		: "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
	const buildPrompt = (conversation: string): string =>
		[
			`<current_harness_state>\n${overviewForPrompt(state)}\n</current_harness_state>`,
			`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
			`<conversation>\n${conversation}\n</conversation>`,
			`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
			options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
			"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
		]
			.filter(Boolean)
			.join("\n\n");
	const reasoning = getAuxiliaryThinkingLevel(model, thinkingLevel);
	const { model: requestModel, userPrompt } = refinementRequest(
		model,
		REFINEMENT_SYSTEM_PROMPT,
		conversationText,
		buildPrompt,
		reasoning === "off" ? REFINEMENT_MAX_OUTPUT_TOKENS : model.maxTokens,
	);
	const maxTokens =
		reasoning === "off" ? Math.min(requestModel.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS) : requestModel.maxTokens;

	const response = await completeWithProviderRetry(
		() =>
			completeSimple(
				requestModel,
				{
					systemPrompt: REFINEMENT_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				},
				{
					reasoning,
					maxTokens,
					signal,
					apiKey,
					headers,
					sessionId,
				},
			),
		{ policy: options.retry, signal },
	);

	if (response.stopReason === "error") {
		throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return { proposal: parseProposal(text), id };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Auto-refine review JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const shouldRefine =
		record.shouldRefine === true ||
		(record as any).should_refine === true ||
		record.shouldRefine === "true" ||
		(record as any).should_refine === "true";
	const rationale =
		typeof record.rationale === "string"
			? record.rationale
			: typeof (record as any).reason === "string"
				? (record as any).reason
				: "No rationale provided.";
	const instructions =
		typeof record.instructions === "string"
			? record.instructions
			: typeof (record as any).instruction === "string"
				? (record as any).instruction
				: undefined;
	return {
		shouldRefine,
		rationale,
		instructions,
	};
}

export async function reviewAutoRefine(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	context: AutoRefineReviewContext,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: ProviderRetryPolicy,
	sessionId?: string,
): Promise<AutoRefineReview> {
	const conversationText = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const buildPrompt = (conversation: string): string =>
		[
			`<trigger>
${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review
</trigger>`,
			`<current_harness_state>
${overviewForPrompt(state)}
</current_harness_state>`,
			`<refinement_history>
${historyForPrompt(history)}
</refinement_history>`,
			`<conversation>
${conversation}
</conversation>`,
			"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
		].join("\n\n");
	const reasoning = getAuxiliaryThinkingLevel(model, thinkingLevel);
	const { model: requestModel, userPrompt } = refinementRequest(
		model,
		AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
		conversationText,
		buildPrompt,
		reasoning === "off" ? AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS : model.maxTokens,
	);
	const maxTokens =
		reasoning === "off"
			? Math.min(requestModel.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS)
			: requestModel.maxTokens;
	const response = await completeWithProviderRetry(
		() =>
			completeSimple(
				requestModel,
				{
					systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				},
				{
					reasoning,
					maxTokens,
					signal,
					apiKey,
					headers,
					sessionId,
				},
			),
		{ policy: retry, signal },
	);
	if (response.stopReason === "error") {
		throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseAutoRefineReview(text);
}

export async function refineHarness(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	sessionId?: string,
): Promise<RefinementResult> {
	const plan = await planRefinement(
		messages,
		state,
		history,
		model,
		apiKey,
		options,
		headers,
		signal,
		thinkingLevel,
		sessionId,
	);
	return applyRefinementProposal(state, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? (options.global ? "global" : "local"),
	});
}
