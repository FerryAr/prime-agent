//! Native Rust bridge for the local lean-ctx toolset.
//!
//! Exposes the complete lean-ctx tool suite (`ctx_*`) as native model-facing tools,
//! querying the local `lean-ctx` MCP server over stdio based on the active tool profile
//! (`minimal`, `standard`, `stage2`, `power`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock, RwLock};
use tokio::process::Command;

use crate::tools::tool_definition::{
    AbortSignal, ExecutionMode, ToolContentBlock, ToolDefinition, ToolExecutionResult,
};

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LeanCtxToolInfo {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "inputSchema")]
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct McpListToolsResult {
    #[serde(default)]
    tools: Vec<LeanCtxToolInfo>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct McpRpcResponse {
    result: Option<McpListToolsResult>,
}

/// The Stage-2 toolset matching the TypeScript `lean-ctx-hybrid` extension.
pub const STAGE2_TOOLS: &[&str] = &[
    "ctx_read", "ctx_shell", "ctx_search", "ctx_glob", "ctx_tree", "ctx_call",
    "ctx_compose", "ctx_overview", "ctx_graph", "ctx_callgraph", "ctx_patch", "ctx_expand",
    "ctx_session", "ctx_outline", "ctx_explore", "ctx_plan", "ctx_index", "ctx_impact",
    "ctx_routes", "ctx_execute", "ctx_review", "ctx_quality", "ctx_fill", "ctx_compile",
    "ctx_url_read", "ctx_git_read", "ctx_context", "ctx_retrieve", "ctx_memory", "ctx_knowledge",
    "ctx_summary", "ctx_handoff",
];

static DISCOVERED_CACHE: OnceLock<RwLock<HashMap<String, Vec<LeanCtxToolInfo>>>> = OnceLock::new();

pub fn resolve_lean_ctx_binary() -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("LEAN_CTX_BIN") {
        let p = PathBuf::from(bin.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let default_candidate = PathBuf::from(&home).join(".local").join("bin").join("lean-ctx");
    if default_candidate.is_file() {
        return Some(default_candidate);
    }
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("lean-ctx");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[allow(dead_code)]
pub fn is_available() -> bool {
    resolve_lean_ctx_binary().is_some()
}

fn query_mcp_tools(binary: &Path, mcp_profile: &str) -> Option<Vec<LeanCtxToolInfo>> {
    use std::io::{BufRead, BufReader, Write};

    let mut child = std::process::Command::new(binary)
        .env("LEAN_CTX_TOOL_PROFILE", mcp_profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let mut reader = BufReader::new(stdout);

    // 1. Send initialize
    let init_req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"pa-core","version":"0.9.8"}}}"#;
    writeln!(stdin, "{}", init_req).ok()?;
    stdin.flush().ok()?;

    let mut line = String::new();
    reader.read_line(&mut line).ok()?;

    // 2. Send notifications/initialized
    writeln!(stdin, "{}", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).ok()?;

    // 3. Send tools/list
    writeln!(stdin, "{}", r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#).ok()?;
    stdin.flush().ok()?;

    line.clear();
    reader.read_line(&mut line).ok()?;

    let _ = child.kill();

    let resp: McpRpcResponse = serde_json::from_str(&line).ok()?;
    let tools = resp.result?.tools;
    Some(tools)
}

pub fn create_lean_ctx_tools(cwd: &str) -> Vec<ToolDefinition> {
    let Some(binary) = resolve_lean_ctx_binary() else {
        return Vec::new();
    };

    let profile = get_tool_profile().trim().to_lowercase();
    let cache_guard = DISCOVERED_CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    let cached = {
        let read = cache_guard.read().ok();
        read.and_then(|m| m.get(&profile).cloned())
    };

    let tools_info = if let Some(t) = cached {
        t
    } else {
        let mcp_profile = if profile == "stage2" { "power" } else { &profile };
        let mut discovered = query_mcp_tools(&binary, mcp_profile).unwrap_or_default();
        if profile == "stage2" {
            let stage2_set: HashSet<&str> = STAGE2_TOOLS.iter().copied().collect();
            discovered.retain(|t| stage2_set.contains(t.name.as_str()));
        }
        if let Ok(mut write) = cache_guard.write() {
            write.insert(profile.clone(), discovered.clone());
        }
        discovered
    };

    let mut definitions = Vec::new();
    let mut seen_names = HashSet::new();

    for info in tools_info {
        let name = info.name.trim();
        if name == "shell" {
            continue; // Skip alias to avoid colliding with bash/ctx_shell
        }
        seen_names.insert(name.to_string());

        if name == "ctx_shell" {
            definitions.push(create_ctx_shell_tool(binary.clone(), cwd));
        } else if name == "ctx_read" {
            definitions.push(create_ctx_read_tool(binary.clone(), cwd));
        } else if name == "ctx_search" {
            definitions.push(create_ctx_search_tool(binary.clone(), cwd));
        } else {
            definitions.push(create_generic_mcp_tool(
                binary.clone(),
                cwd,
                name,
                info.description.as_deref().unwrap_or(""),
                info.input_schema.unwrap_or_else(|| serde_json::json!({
                    "type": "object",
                    "properties": {}
                })),
            ));
        }
    }

    // Always ensure ctx_skill_read is present for verbatim skill file inspections:
    if !seen_names.contains("ctx_skill_read") {
        definitions.push(create_ctx_skill_read_tool(binary.clone(), cwd));
    }

    // Fallback if MCP discovery failed:
    if definitions.is_empty() {
        definitions.push(create_ctx_shell_tool(binary.clone(), cwd));
        definitions.push(create_ctx_read_tool(binary.clone(), cwd));
        definitions.push(create_ctx_search_tool(binary.clone(), cwd));
        definitions.push(create_ctx_skill_read_tool(binary, cwd));
    }

    definitions
}

fn create_generic_mcp_tool(
    binary: PathBuf,
    cwd: &str,
    name: &str,
    description: &str,
    parameters: serde_json::Value,
) -> ToolDefinition {
    let cwd = cwd.to_string();
    let tool_name = name.to_string();
    let desc = if description.is_empty() {
        format!("Call lean-ctx {}", tool_name)
    } else {
        description.to_string()
    };

    ToolDefinition {
        name: tool_name.clone(),
        label: tool_name.clone(),
        description: desc,
        prompt_snippet: format!("Execute {}", tool_name),
        parameters,
        execution_mode: None,
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, signal, _on_update| {
            let binary = binary.clone();
            let cwd = cwd.clone();
            let tool_name = tool_name.clone();
            Box::pin(async move {
                let json_params = serde_json::to_string(&params).unwrap_or_else(|_| "{}".to_string());
                let mut cmd = Command::new(&binary);
                cmd.args([
                    "call",
                    &tool_name,
                    "--project-root",
                    &cwd,
                    "--json",
                    &json_params,
                ])
                .current_dir(&cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

                run_process_with_signal(cmd, signal).await
            })
        }),
    }
}

fn create_ctx_shell_tool(binary: PathBuf, cwd: &str) -> ToolDefinition {
    let cwd = cwd.to_string();
    ToolDefinition {
        name: "ctx_shell".to_string(),
        label: "ctx_shell".to_string(),
        description: "Run a shell command with lean-ctx compression. Use for builds, tests, git, and scripts. Output is token-optimized.".to_string(),
        prompt_snippet: "Run compressed shell commands through lean-ctx".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to execute with compression"
                }
            },
            "required": ["command"]
        }),
        execution_mode: Some(ExecutionMode::Sequential),
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, signal, _on_update| {
            let binary = binary.clone();
            let cwd = cwd.clone();
            Box::pin(async move {
                let command = params.get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if command.trim().is_empty() {
                    anyhow::bail!("command cannot be empty");
                }

                let mut cmd = Command::new(&binary);
                cmd.args(["-c", &command])
                    .current_dir(&cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                run_process_with_signal(cmd, signal).await
            })
        }),
    }
}

fn create_ctx_read_tool(binary: PathBuf, cwd: &str) -> ToolDefinition {
    let cwd = cwd.to_string();
    ToolDefinition {
        name: "ctx_read".to_string(),
        label: "ctx_read".to_string(),
        description: "Read file content with lean-ctx compression (signatures, full, lines:N-M, auto). Saves tokens by eliminating repetitive boilerplates.".to_string(),
        prompt_snippet: "Read compressed file contents".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read"
                },
                "mode": {
                    "type": "string",
                    "description": "Read mode: 'signatures', 'full', 'lines:N-M', or 'auto'",
                    "enum": ["signatures", "full", "auto"]
                }
            },
            "required": ["path"]
        }),
        execution_mode: None,
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, signal, _on_update| {
            let binary = binary.clone();
            let cwd = cwd.clone();
            Box::pin(async move {
                let path = params.get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let mode = params.get("mode").and_then(|v| v.as_str());

                let mut cmd = Command::new(&binary);
                cmd.arg("read").arg(path);
                if let Some(m) = mode {
                    cmd.arg("--mode").arg(m);
                }
                cmd.current_dir(&cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                run_process_with_signal(cmd, signal).await
            })
        }),
    }
}

fn create_ctx_search_tool(binary: PathBuf, cwd: &str) -> ToolDefinition {
    let cwd = cwd.to_string();
    ToolDefinition {
        name: "ctx_search".to_string(),
        label: "ctx_search".to_string(),
        description: "Search text patterns across the codebase using lean-ctx grep with compressed results.".to_string(),
        prompt_snippet: "Search code patterns with compression".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Text or regex pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "Optional directory or file path to constrain search"
                }
            },
            "required": ["pattern"]
        }),
        execution_mode: None,
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, signal, _on_update| {
            let binary = binary.clone();
            let cwd = cwd.clone();
            Box::pin(async move {
                let pattern = params.get("pattern")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let path = params.get("path").and_then(|v| v.as_str());

                let mut cmd = Command::new(&binary);
                cmd.arg("grep").arg(pattern);
                if let Some(p) = path {
                    cmd.arg(p);
                }
                cmd.current_dir(&cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                run_process_with_signal(cmd, signal).await
            })
        }),
    }
}

fn create_ctx_skill_read_tool(binary: PathBuf, cwd: &str) -> ToolDefinition {
    let cwd = cwd.to_string();
    ToolDefinition {
        name: "ctx_skill_read".to_string(),
        label: "ctx_skill_read".to_string(),
        description: "Read Prime Agent SKILL.md or reference files verbatim without compression.".to_string(),
        prompt_snippet: "Read skill instructions verbatim".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to SKILL.md"
                }
            },
            "required": ["path"]
        }),
        execution_mode: None,
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, signal, _on_update| {
            let binary = binary.clone();
            let cwd = cwd.clone();
            Box::pin(async move {
                let path = params.get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();

                let mut cmd = Command::new(&binary);
                cmd.args(["raw", "cat", path])
                    .current_dir(&cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                run_process_with_signal(cmd, signal).await
            })
        }),
    }
}

pub fn get_context_profile() -> String {
    std::env::var("LEAN_CTX_PROFILE").unwrap_or_else(|_| "coder".to_string())
}

pub fn set_context_profile(profile: &str) {
    std::env::set_var("LEAN_CTX_PROFILE", profile);
}

pub fn get_tool_profile() -> String {
    std::env::var("LEAN_CTX_TOOL_PROFILE").unwrap_or_else(|_| "stage2".to_string())
}

pub fn set_tool_profile(profile: &str) {
    std::env::set_var("LEAN_CTX_TOOL_PROFILE", profile);
}

async fn run_process_with_signal(
    mut cmd: Command,
    signal: Option<AbortSignal>,
) -> anyhow::Result<ToolExecutionResult> {
    cmd.env("LEAN_CTX_COMPRESS", "1");
    cmd.env("LEAN_CTX_PROFILE", get_context_profile());
    cmd.env("LEAN_CTX_TOOL_PROFILE", get_tool_profile());

    let mut child = cmd.spawn()?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let output_future = async {
        let stdout_data = if let Some(mut pipe) = stdout_pipe {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf).await;
            buf
        } else {
            Vec::new()
        };

        let stderr_data = if let Some(mut pipe) = stderr_pipe {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf).await;
            buf
        } else {
            Vec::new()
        };

        let status = child.wait().await?;
        Ok::<_, anyhow::Error>((status, stdout_data, stderr_data))
    };

    let result = if let Some(sig) = signal {
        tokio::select! {
            _ = sig.cancelled() => {
                let _ = child.kill().await;
                anyhow::bail!("operation aborted");
            }
            res = output_future => res?
        }
    } else {
        output_future.await?
    };

    let (status, stdout_bytes, stderr_bytes) = result;
    let stdout_str = String::from_utf8_lossy(&stdout_bytes);
    let stderr_str = String::from_utf8_lossy(&stderr_bytes);

    let output = if stdout_str.is_empty() && !stderr_str.is_empty() {
        stderr_str.to_string()
    } else if !stderr_str.is_empty() {
        format!("{stdout_str}\n{stderr_str}")
    } else {
        stdout_str.to_string()
    };

    Ok(ToolExecutionResult {
        content: vec![ToolContentBlock::text(output)],
        details: None,
        is_error: !status.success(),
    })
}
