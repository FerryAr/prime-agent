//! Native Rust API Gateway for Prime Agent.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::Value;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../web"]
pub struct EmbeddedStatic;

async fn embedded_static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }
    match EmbeddedStatic::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            (
                [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
                content.data,
            )
                .into_response()
        }
        None => {
            if !path.contains('.') {
                if let Some(content) = EmbeddedStatic::get("index.html") {
                    return (
                        [(axum::http::header::CONTENT_TYPE, "text/html")],
                        content.data,
                    )
                        .into_response();
                }
            }
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

pub mod auth;
pub mod daemon_pool;
pub mod password;
pub mod pty_service;

use daemon_pool::DaemonBridge;

pub struct ApiState {
    pub token: String,
    pub static_dir: PathBuf,
    pub bridge: Option<Arc<DaemonBridge>>,
    pub event_tx: broadcast::Sender<Value>,
    pub gate: Option<Arc<password::PasswordGate>>,
}

#[derive(Clone, Debug, Default)]
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub static_dir: Option<PathBuf>,
    pub daemon_socket: Option<PathBuf>,
    pub auth_mode: Option<String>,
    pub password: Option<String>,
    pub data_dir: Option<PathBuf>,
}


async fn api_auth_and_origin_middleware(
    State(state): State<Arc<ApiState>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let path = req.uri().path();

    // 1. Origin check (Point 9): allow loopback or matching Host
    if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok()) {
        let host_header = req.headers().get("host").and_then(|v| v.to_str().ok());
        if !auth::is_allowed_origin(origin, host_header) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "Cross-origin request rejected" })),
            ));
        }
    }

    // Allow public / unauthenticated routes
    if path == "/api/login"
        || path == "/api/logout"
        || path == "/api/meta"
        || path.starts_with("/static")
        || path.starts_with("/vendor")
    {
        return Ok(next.run(req).await);
    }

    // 2. Auth check (Point 1)
    let token_param = req.uri().query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut s = pair.split('=');
            if s.next() == Some("token") { s.next() } else { None }
        })
    });

    if !auth::is_authorized_with_gate(&state.token, state.gate.as_deref(), req.headers(), token_param) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized: missing or invalid authentication token" })),
        ));
    }

    Ok(next.run(req).await)
}

pub fn create_router(state: Arc<ApiState>) -> Router {
    let cors = CorsLayer::permissive();

    let api_routes = Router::new()
        .route("/api/meta", get(get_meta))
        .route("/api/sessions", get(get_sessions))
        .route("/api/session", post(post_session))
        .route("/api/session", delete(delete_session))
        .route("/api/state", get(get_state))
        .route("/api/prompt", post(post_prompt))
        .route("/api/steer", post(post_steer))
        .route("/api/abort", post(post_abort))
        .route("/api/new", post(post_new))
        .route("/api/models", get(get_models))
        .route("/api/model", post(post_model))
        .route("/api/session-name", post(post_session_name))
        .route("/api/thinking", post(post_thinking))
        .route("/api/compact", post(post_compact))
        .route("/api/auto-compact", post(post_auto_compact))
        .route("/api/refine", post(post_refine))
        .route("/api/reload", post(post_reload))
        .route("/api/export", post(post_export))
        .route("/api/side-question", post(post_side_question))
        .route("/api/side-question-abort", post(post_side_question_abort))
        .route("/api/cron", get(get_cron).post(post_cron).delete(delete_cron))
        .route("/api/heartbeats", get(get_heartbeats))
        .route("/api/heartbeat", post(post_heartbeat))
        .route("/api/heartbeat-action", post(post_heartbeat_action))
        .route("/api/fork-messages", get(get_fork_messages))
        .route("/api/fork", post(post_fork))
        .route("/api/clone", post(post_clone))
        .route("/api/login", post(post_login))
        .route("/api/logout", post(post_logout))
        .route("/api/change-password", post(post_change_password))
        .route("/api/fs/browse", get(get_fs_browse))
        .route("/api/fs/list", get(get_fs_list))
        .route("/api/fs/file", get(get_fs_file).put(put_fs_file))
        .route("/api/dialog", post(post_dialog))
        .route("/api/commands", get(get_commands))
        .route("/api/subagent-messages", get(get_subagent_messages))
        .route("/api/git/diff", get(get_git_diff))
        .route("/events", get(sse_events))
        .route("/events/roster", get(sse_roster))
        .route("/api/terminal/ws", get(pty_service::ws_terminal_handler))
        .route("/api/terminal/exec", post(exec_terminal));

    let mut app = Router::new()
        .merge(api_routes)
        .layer(axum::middleware::from_fn_with_state(state.clone(), api_auth_and_origin_middleware))
        .layer(cors)
        .with_state(state.clone());

    if state.static_dir.exists() {
        app = app.fallback_service(
            ServeDir::new(&state.static_dir)
                .fallback(axum::routing::get(embedded_static_handler)),
        );
    } else {
        app = app.fallback(embedded_static_handler);
    }

    app
}

async fn get_meta() -> impl IntoResponse {
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string();
    let home = std::env::var("HOME").unwrap_or_default();

    Json(serde_json::json!({
        "name": "prime-agent-api-rust",
        "status": "running",
        "version": "0.9.8",
        "cwd": cwd,
        "home": home
    }))
}

async fn get_sessions(State(state): State<Arc<ApiState>>) -> Result<impl IntoResponse, StatusCode> {
    if let Some(bridge) = &state.bridge {
        if let Ok(resp) = bridge.list_saved_sessions().await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "sessions": [] })))
}

fn format_session_snapshot_response(data: &Value) -> Value {
    let mut result = serde_json::Map::new();
    let active_sid = data.get("activeSessionId")
        .or_else(|| data.get("snapshot").and_then(|s| s.get("activeSessionId")))
        .or_else(|| data.get("state").and_then(|s| s.get("activeSessionId")))
        .or_else(|| data.get("sessionId"))
        .or_else(|| data.get("snapshot").and_then(|s| s.get("sessionId")))
        .or_else(|| data.get("state").and_then(|s| s.get("sessionId")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    result.insert("activeSessionId".to_string(), Value::String(active_sid));

    if let Some(snapshot) = data.get("snapshot").and_then(Value::as_object) {
        for (k, v) in snapshot {
            result.insert(k.clone(), v.clone());
        }
    } else if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            result.insert(k.clone(), v.clone());
        }
    }



    Value::Object(result)
}

async fn enrich_snapshot_with_stats(mut snapshot_val: Value, bridge: &Arc<DaemonBridge>, active_sid: &str) -> Value {
    if let Ok(children_resp) = bridge.get_rlm_children(active_sid).await {
        let c_data = children_resp.get("data").unwrap_or(&children_resp);
        if let Some(children) = c_data.get("children").and_then(Value::as_array) {
            if let Some(obj) = snapshot_val.as_object_mut() {
                obj.insert("children".to_string(), Value::Array(children.clone()));
            }
        }
    }
    if let Ok(stats_resp) = bridge.get_session_stats(active_sid).await {
        let stats_data = stats_resp.get("data").unwrap_or(&stats_resp);
        if let Some(obj) = snapshot_val.as_object_mut() {
            if let Some(ctx_usage) = stats_data.get("contextUsage") {
                obj.insert("contextUsage".to_string(), ctx_usage.clone());
                if let Some(state_obj) = obj.get_mut("state").and_then(Value::as_object_mut) {
                    state_obj.insert("contextUsage".to_string(), ctx_usage.clone());
                }
            }
            if let Some(cost) = stats_data.get("cost") {
                let usage_val = serde_json::json!({
                    "cost": cost,
                    "inputTokens": stats_data.get("tokens").and_then(|t| t.get("input")).unwrap_or(&serde_json::json!(0)),
                    "outputTokens": stats_data.get("tokens").and_then(|t| t.get("output")).unwrap_or(&serde_json::json!(0)),
                });
                obj.insert("usage".to_string(), usage_val.clone());
                if let Some(state_obj) = obj.get_mut("state").and_then(Value::as_object_mut) {
                    state_obj.insert("usage".to_string(), usage_val);
                }
            }
        }
    }
    snapshot_val
}

#[derive(Deserialize)]
pub struct SessionQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

async fn get_state(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<SessionQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
        if let Ok(resp) = bridge.attach_session(sid).await {
            let data = resp.get("data").unwrap_or(&resp);
            let formatted = format_session_snapshot_response(data);
            let enriched = enrich_snapshot_with_stats(formatted, bridge, sid).await;
            return Ok(Json(enriched));
        } else if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            let formatted = format_session_snapshot_response(data);
            let enriched = enrich_snapshot_with_stats(formatted, bridge, sid).await;
            return Ok(Json(enriched));
        }
    }
    Ok(Json(serde_json::json!({
        "activeSessionId": query.session_id,
        "state": null,
        "messages": []
    })))
}

#[derive(Deserialize)]
pub struct PostSessionRequest {
    #[serde(default, rename = "activeSessionId")]
    pub active_session_id: Option<String>,
    #[serde(default, rename = "sessionPath")]
    pub session_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

async fn post_session(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<PostSessionRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let Some(bridge) = &state.bridge else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };

    let active_sid = payload.active_session_id.clone();
    let mut resolved_path = payload.session_path.clone();

    // If activeSessionId is provided, first try attaching to a live worker
    if let Some(sid) = &active_sid {
        if let Ok(resp) = bridge.attach_session(sid).await {
            if resp.get("success") == Some(&Value::Bool(true)) {
                let data = resp.get("data").unwrap_or(&resp);
                let formatted = format_session_snapshot_response(data);
                let enriched = enrich_snapshot_with_stats(formatted, bridge, sid).await;
                return Ok(Json(enriched));
            }
        }
    }

    // If not live yet, resolve the transcript path from catalog if needed
    if resolved_path.is_none() {
        if let Some(sid) = &active_sid {
            if let Ok(list_resp) = bridge.list_saved_sessions().await {
                let list_data = list_resp.get("data").unwrap_or(&list_resp);
                if let Some(sessions) = list_data.get("sessions").and_then(Value::as_array) {
                    for s in sessions {
                        let id_match = s.get("id")
                            .or_else(|| s.get("activeSessionId"))
                            .or_else(|| s.get("sessionId"))
                            .and_then(Value::as_str);
                        if id_match == Some(sid.as_str()) {
                            resolved_path = s.get("sessionFile")
                                .or_else(|| s.get("path"))
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            break;
                        }
                    }
                }
            }
        }
    }

    // Resume or create session
    let cwd_str = payload.cwd.as_deref();
    let path_str = resolved_path.as_deref();
    if let Ok(create_resp) = bridge.create_session(cwd_str, path_str).await {
        if create_resp.get("success") == Some(&Value::Bool(true)) {
            let c_data = create_resp.get("data").unwrap_or(&create_resp);
            let resumed_sid = c_data.get("activeSessionId")
                .or_else(|| c_data.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();

            if !resumed_sid.is_empty() {
                if let Ok(att_resp) = bridge.attach_session(resumed_sid).await {
                    let data = att_resp.get("data").unwrap_or(&att_resp);
                    let formatted = format_session_snapshot_response(data);
                    let enriched = enrich_snapshot_with_stats(formatted, bridge, resumed_sid).await;
                    return Ok(Json(enriched));
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "activeSessionId": null, "messages": [], "state": null })))
}

async fn delete_session(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<SessionQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let Some(sid) = &query.session_id else {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "sessionId is required" }))));
    };
    if let Some(bridge) = &state.bridge {
        let mut session_file = None;
        if let Ok(state_resp) = bridge.get_state(Some(sid)).await {
            let data = state_resp.get("data").unwrap_or(&state_resp);
            session_file = data.get("sessionFile").and_then(Value::as_str).map(str::to_string);
        }
        let _ = bridge.kill(sid).await;
        if session_file.is_none() {
            if let Ok(list_resp) = bridge.list_saved_sessions().await {
                let list_data = list_resp.get("data").unwrap_or(&list_resp);
                if let Some(sessions) = list_data.get("sessions").and_then(Value::as_array) {
                    for s in sessions {
                        let id_match = s.get("id").or_else(|| s.get("activeSessionId")).or_else(|| s.get("sessionId")).and_then(Value::as_str);
                        if id_match == Some(sid.as_str()) {
                            session_file = s.get("sessionFile").or_else(|| s.get("path")).and_then(Value::as_str).map(str::to_string);
                            break;
                        }
                    }
                }
            }
        }
        if let Some(path) = session_file {
            let _ = bridge.delete_saved_session(&path).await;
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct PromptRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(alias = "prompt")]
    pub message: String,
    #[serde(default)]
    pub images: Option<Value>,
    #[serde(default, rename = "streamingBehavior")]
    pub streaming_behavior: Option<String>,
    #[serde(default)]
    pub wait: Option<bool>,
}

fn extract_latest_assistant_response(data: &Value) -> String {
    let messages = data.get("messages")
        .or_else(|| data.get("snapshot").and_then(|s| s.get("messages")))
        .and_then(Value::as_array);

    if let Some(msgs) = messages {
        for m in msgs.iter().rev() {
            let role = m.get("role")
                .or_else(|| m.get("message").and_then(|sub| sub.get("role")))
                .and_then(Value::as_str);
            if role == Some("assistant") {
                let content = m.get("content")
                    .or_else(|| m.get("message").and_then(|sub| sub.get("content")));
                if let Some(text) = content.and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        return text.trim().to_string();
                    }
                } else if let Some(arr) = content.and_then(Value::as_array) {
                    let mut parts = Vec::new();
                    for item in arr {
                        if item.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(t) = item.get("text").and_then(Value::as_str) {
                                parts.push(t);
                            }
                        }
                    }
                    if !parts.is_empty() {
                        return parts.join("\n").trim().to_string();
                    }
                }
            }
        }
    }
    String::new()
}

async fn post_prompt(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<PromptRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        if payload.wait == Some(true) {
            let wait_res = bridge.prompt_and_wait(
                sid,
                &payload.message,
                payload.images.clone(),
            ).await;

            let is_suspended = match &wait_res {
                Ok(resp) if resp.get("success") == Some(&Value::Bool(false)) => {
                    let err = resp.get("error").and_then(Value::as_str).unwrap_or("");
                    err.contains("suspended") || err.contains("not accepted")
                }
                Err(e) => {
                    let err_str = e.to_string();
                    err_str.contains("suspended") || err_str.contains("not accepted")
                }
                _ => false,
            };

            if is_suspended {
                let _ = bridge.resume_queue(sid).await;
                let _ = bridge.prompt_and_wait(
                    sid,
                    &payload.message,
                    payload.images,
                ).await;
            }

            // Turn is finished; retrieve latest session snapshot with assistant response
            if let Ok(att) = bridge.attach_session(sid).await {
                let data = att.get("data").unwrap_or(&att);
                let response_text = extract_latest_assistant_response(data);
                return Ok(Json(serde_json::json!({
                    "ok": true,
                    "response": response_text,
                    "activeSessionId": sid,
                })));
            }
        } else {
            let mut res = bridge.prompt(
                sid,
                &payload.message,
                payload.images.clone(),
                payload.streaming_behavior.as_deref(),
            ).await;

            let is_suspended = match &res {
                Ok(resp) if resp.get("success") == Some(&Value::Bool(false)) => {
                    let err = resp.get("error").and_then(Value::as_str).unwrap_or("");
                    err.contains("suspended") || err.contains("not accepted")
                }
                Err(e) => {
                    let err_str = e.to_string();
                    err_str.contains("suspended") || err_str.contains("not accepted")
                }
                _ => false,
            };

            if is_suspended {
                let _ = bridge.resume_queue(sid).await;
                res = bridge.prompt(
                    sid,
                    &payload.message,
                    payload.images,
                    payload.streaming_behavior.as_deref(),
                ).await;
            }

            if let Ok(resp) = res {
                let data = resp.get("data").unwrap_or(&resp);
                return Ok(Json(data.clone()));
            }
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SteerRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub message: String,
}

async fn post_steer(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<SteerRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.steer(sid, &payload.message).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct AbortRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

async fn post_abort(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<AbortRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.abort(sid).await;
        // In web / API mode, immediately clear the input-pump suspension so subsequent prompts are accepted
        let _ = bridge.resume_queue(sid).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct NewSessionRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

async fn post_new(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<NewSessionRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let Some(bridge) = &state.bridge {
        if let Some(sid) = &payload.session_id {
            if let Ok(resp) = bridge.new_session(sid).await {
                let data = resp.get("data").unwrap_or(&resp);
                let mut result = data.as_object().cloned().unwrap_or_default();
                if let Ok(att) = bridge.attach_session(sid).await {
                    let att_data = att.get("data").unwrap_or(&att);
                    let formatted = format_session_snapshot_response(att_data);
                    let enriched = enrich_snapshot_with_stats(formatted, bridge, sid).await;
                    if let Some(s) = enriched.get("state") { result.insert("state".to_string(), s.clone()); }
                    if let Some(m) = enriched.get("messages") { result.insert("messages".to_string(), m.clone()); }
                }
                return Ok(Json(Value::Object(result)));
            }
        } else if let Ok(resp) = bridge.create_session(None, None).await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn get_models(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<SessionQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if let Some(bridge) = &state.bridge {
        if let Ok(resp) = bridge.get_available_models(query.session_id.as_deref()).await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "models": [] })))
}

#[derive(Deserialize)]
pub struct SetModelRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

async fn post_model(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<SetModelRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.set_model(sid, &payload.provider, &payload.model_id).await;
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            let formatted = format_session_snapshot_response(data);
            let enriched = enrich_snapshot_with_stats(formatted, bridge, sid).await;
            return Ok(Json(serde_json::json!({
                "ok": true,
                "state": enriched.get("state").cloned().unwrap_or(enriched)
            })));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RenameSessionRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub name: String,
}

async fn post_session_name(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<RenameSessionRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.rename(sid, &payload.name).await;
    }
    Ok(Json(serde_json::json!({ "ok": true, "name": payload.name })))
}

#[derive(Deserialize)]
pub struct ThinkingRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default, rename = "thinkingLevel")]
    pub thinking_level: Option<String>,
}

async fn post_thinking(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<ThinkingRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let level = payload.level.or(payload.thinking_level).unwrap_or_else(|| "off".to_string());
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.set_thinking_level(sid, &level).await;
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(serde_json::json!({ "ok": true, "state": data })));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct CompactRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
}

async fn post_compact(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<CompactRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let res = bridge.compact(sid, payload.instructions.as_deref()).await;
        if let Ok(resp) = res {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct AutoCompactRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

async fn post_auto_compact(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<AutoCompactRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.set_auto_compaction(sid, payload.enabled.unwrap_or(true)).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RefineRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default, rename = "rollbackId")]
    pub rollback_id: Option<String>,
    #[serde(default)]
    pub global: Option<bool>,
}

async fn post_refine(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<RefineRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let res = bridge.refine(
            sid,
            payload.instructions.as_deref(),
            payload.rollback_id.as_deref(),
            payload.global,
        ).await;
        if let Ok(resp) = res {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SessionOnlyRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ExportRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

async fn post_export(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<ExportRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let cmd = serde_json::json!({
            "type": "export_html",
            "activeSessionId": sid,
        });
        if let Ok(resp) = bridge.send_command(cmd).await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(serde_json::json!({ "ok": true, "data": data })));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn post_reload(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<SessionOnlyRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.reload(sid).await;
        let mut state_val = Value::Null;
        let mut commands_val = serde_json::json!([]);
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            state_val = data.clone();
        }
        if let Ok(cmds) = bridge.get_commands(Some(sid)).await {
            let data = cmds.get("data").unwrap_or(&cmds);
            commands_val = data.get("commands").cloned().unwrap_or_else(|| serde_json::json!([]));
        }
        return Ok(Json(serde_json::json!({ "ok": true, "state": state_val, "commands": commands_val })));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SideQuestionRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    pub question: String,
}

async fn post_side_question(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<SideQuestionRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let id = payload.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.start_side_question(sid, &id, &payload.question).await;
    }
    Ok(Json(serde_json::json!({ "id": id, "ok": true })))
}

#[derive(Deserialize)]
pub struct SideQuestionAbortRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub id: String,
}

async fn post_side_question_abort(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<SideQuestionAbortRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let _ = bridge.abort_side_question(sid, &payload.id).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct CronQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, rename = "jobId")]
    pub job_id: Option<String>,
}

#[derive(Deserialize)]
pub struct CronAddRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub schedule: String,
    pub prompt: String,
}

async fn get_cron(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<CronQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
        if let Ok(resp) = bridge.list_cron_jobs(sid).await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "jobs": [] })))
}

async fn post_cron(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<CronAddRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let res = bridge.add_cron_job(sid, &payload.schedule, &payload.prompt).await;
        if let Ok(resp) = res {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_cron(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<CronQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid), Some(jid)) = (&state.bridge, &query.session_id, &query.job_id) {
        let _ = bridge.cancel_cron_job(sid, jid).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct HeartbeatQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
pub struct HeartbeatSetRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub schedule: String,
    pub instruction: String,
    #[serde(default, rename = "deliveryMode")]
    pub delivery_mode: Option<String>,
}

async fn get_heartbeats(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<HeartbeatQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
        if let Ok(resp) = bridge.list_heartbeats(sid).await {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "heartbeats": [] })))
}

#[derive(Deserialize)]
pub struct HeartbeatActionRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, rename = "jobId")]
    pub job_id: String,
    pub action: String,
}

async fn post_heartbeat_action(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<HeartbeatActionRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let res = bridge.manage_heartbeat(sid, &payload.job_id, &payload.action).await;
        if let Ok(resp) = res {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn post_heartbeat(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<HeartbeatSetRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let res = bridge.set_heartbeat(
            sid,
            &payload.schedule,
            &payload.instruction,
            payload.delivery_mode.as_deref(),
        ).await;
        if let Ok(resp) = res {
            let data = resp.get("data").unwrap_or(&resp);
            return Ok(Json(data.clone()));
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ForkMessagesQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, rename = "activeSessionId")]
    pub active_session_id: Option<String>,
}

async fn get_fork_messages(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<ForkMessagesQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let sid = query.session_id.or(query.active_session_id);
    let Some(sid) = sid else {
        return Err(StatusCode::BAD_REQUEST);
    };

    if let Some(bridge) = &state.bridge {
        if let Ok(resp) = bridge.get_fork_messages(&sid).await {
            if let Some(data) = resp.get("data") {
                return Ok(Json(data.clone()));
            }
        }

        // Fallback: extract user messages from get_state
        if let Ok(resp) = bridge.get_state(Some(&sid)).await {
            let state_data = resp.get("data").unwrap_or(&resp);
            if let Some(messages) = state_data.get("messages").and_then(Value::as_array) {
                let mut user_messages = Vec::new();
                for (index, msg) in messages.iter().enumerate() {
                    let role = msg.get("role")
                        .or_else(|| msg.get("message").and_then(|m| m.get("role")))
                        .and_then(Value::as_str);
                    if role == Some("user") {
                        let text = msg.get("content")
                            .or_else(|| msg.get("message").and_then(|m| m.get("content")))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let entry_id = msg.get("entryId")
                            .or_else(|| msg.get("id"))
                            .and_then(Value::as_str)
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("msg-{index}"));
                        let ts = msg.get("timestamp")
                            .or_else(|| msg.get("message").and_then(|m| m.get("timestamp")))
                            .and_then(Value::as_u64);
                        user_messages.push(serde_json::json!({
                            "id": entry_id,
                            "entryId": entry_id,
                            "text": text.chars().take(300).collect::<String>(),
                            "timestamp": ts,
                        }));
                    }
                }
                return Ok(Json(serde_json::json!({ "messages": user_messages })));
            }
        }
    }

    Ok(Json(serde_json::json!({ "messages": [] })))
}

#[derive(Deserialize)]
pub struct ForkRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, rename = "activeSessionId")]
    pub active_session_id: Option<String>,
    #[serde(default, rename = "entryId")]
    pub entry_id: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub position: Option<String>,
}

async fn post_fork(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<ForkRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let sid = payload.session_id.or(payload.active_session_id);
    let Some(sid) = sid else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let entry_id = payload.entry_id.or(payload.id);
    let Some(entry_id) = entry_id else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let position = payload.position.unwrap_or_else(|| "before".to_string());
    if position != "before" && position != "at" {
        return Err(StatusCode::BAD_REQUEST);
    }

    if let Some(bridge) = &state.bridge {
        let fork_resp = bridge.fork(&sid, &entry_id, &position).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        let data = fork_resp.get("data").cloned().unwrap_or(serde_json::json!({ "cancelled": false }));
        let mut result = data.as_object().cloned().unwrap_or_default();

        if let Ok(att) = bridge.attach_session(&sid).await {
            let att_data = att.get("data").unwrap_or(&att);
            let formatted = format_session_snapshot_response(att_data);
            let enriched = enrich_snapshot_with_stats(formatted, bridge, &sid).await;
            if let Some(s) = enriched.get("state") { result.insert("state".to_string(), s.clone()); }
            if let Some(m) = enriched.get("messages") { result.insert("messages".to_string(), m.clone()); }
        }
        result.insert("activeSessionId".to_string(), serde_json::json!(sid));

        return Ok(Json(Value::Object(result)));
    }

    Err(StatusCode::SERVICE_UNAVAILABLE)
}

#[derive(Deserialize)]
pub struct CloneRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, rename = "activeSessionId")]
    pub active_session_id: Option<String>,
}

async fn post_clone(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<CloneRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let sid = payload.session_id.or(payload.active_session_id);
    let Some(sid) = sid else {
        return Err(StatusCode::BAD_REQUEST);
    };

    if let Some(bridge) = &state.bridge {
        let tree_resp = bridge.get_session_tree(&sid).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let leaf_id = tree_resp.get("data")
            .and_then(|d| d.get("leafId"))
            .or_else(|| tree_resp.get("leafId"))
            .and_then(Value::as_str)
            .ok_or(StatusCode::BAD_REQUEST)?;

        let fork_resp = bridge.fork(&sid, leaf_id, "at").await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        let data = fork_resp.get("data").cloned().unwrap_or(serde_json::json!({ "cancelled": false }));
        let mut result = data.as_object().cloned().unwrap_or_default();

        if let Ok(att) = bridge.attach_session(&sid).await {
            let att_data = att.get("data").unwrap_or(&att);
            let formatted = format_session_snapshot_response(att_data);
            let enriched = enrich_snapshot_with_stats(formatted, bridge, &sid).await;
            if let Some(s) = enriched.get("state") { result.insert("state".to_string(), s.clone()); }
            if let Some(m) = enriched.get("messages") { result.insert("messages".to_string(), m.clone()); }
        }
        result.insert("activeSessionId".to_string(), serde_json::json!(sid));

        return Ok(Json(Value::Object(result)));
    }

    Err(StatusCode::SERVICE_UNAVAILABLE)
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: Option<String>,
}

async fn post_login(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let Some(gate) = &state.gate else {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Password auth is disabled" }))));
    };

    let ip = headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");

    let locked = gate.locked_for_ms(ip);
    if locked > 0 {
        return Err((StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({
            "error": format!("Too many failed logins. Locked for {} seconds", (locked + 999) / 1000)
        }))));
    }

    let Some(pass) = payload.password else {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "password is required" }))));
    };

    if !gate.verify(&pass) {
        gate.record_failure(ip);
        return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Invalid password" }))));
    }

    gate.record_success(ip);
    let session_token = gate.create_login();
    let cookie_val = format!(
        "{}={}; HttpOnly; Path=/; SameSite=Lax; Max-Age={}",
        password::SESSION_COOKIE, session_token, 365 * 24 * 3600
    );

    let mut response_headers = HeaderMap::new();
    response_headers.insert(axum::http::header::SET_COOKIE, cookie_val.parse().unwrap());

    Ok((response_headers, Json(serde_json::json!({ "ok": true }))))
}

async fn post_logout(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(gate) = &state.gate {
        let cookie_val = auth::extract_cookie(&headers, password::SESSION_COOKIE);
        gate.logout(cookie_val.as_deref());
    }

    let cookie_val = format!(
        "{}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
        password::SESSION_COOKIE
    );

    let mut response_headers = HeaderMap::new();
    response_headers.insert(axum::http::header::SET_COOKIE, cookie_val.parse().unwrap());

    (response_headers, Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    #[serde(default, rename = "currentPassword")]
    pub current_password: Option<String>,
    #[serde(default, rename = "newPassword")]
    pub new_password: Option<String>,
}

async fn post_change_password(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<ChangePasswordRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let Some(gate) = &state.gate else {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Password auth is disabled" }))));
    };

    let (Some(curr), Some(new_pass)) = (payload.current_password, payload.new_password) else {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "currentPassword and newPassword are required" }))));
    };

    match gate.change_password(&curr, &new_pass) {
        Ok(()) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": err })))),
    }
}

#[derive(Deserialize)]
pub struct FsBrowseQuery {
    pub path: Option<String>,
}

async fn get_fs_browse(
    Query(query): Query<FsBrowseQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let target = query.path.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| home.clone());
    let target_path = PathBuf::from(&target);
    let target_path = if target_path.is_dir() { target_path } else { PathBuf::from(&home) };

    let mut entries = Vec::new();
    if let Ok(dir) = std::fs::read_dir(&target_path) {
        for entry in dir.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let p = entry.path().to_string_lossy().to_string();
                    entries.push(serde_json::json!({ "name": name, "path": p }));
                }
            }
        }
    }
    entries.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });

    let parent = target_path.parent().map(|p| p.to_string_lossy().to_string());
    Ok(Json(serde_json::json!({
        "path": target_path.to_string_lossy(),
        "home": home,
        "parent": parent,
        "entries": entries,
    })))
}

#[derive(Deserialize)]
pub struct GitDiffQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

async fn get_git_diff(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<GitDiffQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let cwd = if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            data.get("state")
                .and_then(|s| s.get("cwd"))
                .or_else(|| data.get("cwd"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
        } else {
            None
        }
    } else {
        None
    };

    let dir = cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    // 1. Check if inside work tree
    let check = tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&dir)
        .output()
        .await;

    match check {
        Ok(o) if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true" => {}
        _ => {
            return Ok(Json(serde_json::json!({
                "available": false,
                "status": "",
                "diff": "",
                "error": "Not a git work tree",
            })));
        }
    }

    // 2. Run git status --short
    let status_out = tokio::process::Command::new("git")
        .args(["status", "--short"])
        .current_dir(&dir)
        .output()
        .await;
    let status = match status_out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    };

    // 3. Run git diff HEAD
    let diff_out = tokio::process::Command::new("git")
        .args(["--no-pager", "diff", "HEAD"])
        .current_dir(&dir)
        .output()
        .await;
    let diff = match diff_out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(e) => format!("Error running git diff: {e}"),
    };

    Ok(Json(serde_json::json!({
        "available": true,
        "status": status,
        "diff": diff,
    })))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

async fn sse_events(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if !auth::is_authorized_with_gate(&state.token, state.gate.as_deref(), &headers, query.token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let session_id_opt = query.session_id.clone();
    let initial_snapshot = if let (Some(bridge), Some(sid)) = (&state.bridge, &session_id_opt) {
        if let Ok(resp) = bridge.attach_session(sid).await {
            let data = resp.get("data").unwrap_or(&resp);
            let formatted = format_session_snapshot_response(data);
            enrich_snapshot_with_stats(formatted, bridge, sid).await
        } else {
            serde_json::json!({ "activeSessionId": sid, "state": null, "messages": [] })
        }
    } else {
        serde_json::json!(null)
    };

    let mut rx = state.event_tx.subscribe();
    let sid_filter = session_id_opt.clone();

    let stream = async_stream::stream! {
        if let Some(ref sid) = sid_filter {
            let connected_event = serde_json::json!({
                "type": "connected",
                "sessionId": sid
            });
            yield Ok(Event::default().data(connected_event.to_string()));

            if !initial_snapshot.is_null() {
                let snapshot_payload = serde_json::json!({
                    "type": "snapshot",
                    "sessionId": sid,
                    "snapshot": initial_snapshot
                });
                yield Ok(Event::default().data(snapshot_payload.to_string()));
            }
        }

        let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(15));
        heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = heartbeat_interval.tick() => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let heartbeat = serde_json::json!({
                        "type": "heartbeat",
                        "timestamp": now
                    });
                    yield Ok(Event::default().comment("ping").data(heartbeat.to_string()));
                }
                msg_res = rx.recv() => {
                    match msg_res {
                        Ok(msg) => {
                            let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or_default();
                            // Never yield roster-only events into session event streams
                            if msg_type.starts_with("roster") {
                                continue;
                            }

                            let matches = match &sid_filter {
                                None => true,
                                Some(target_sid) => {
                                    let active_id = msg.get("activeSessionId")
                                        .or_else(|| msg.get("sessionId"))
                                        .and_then(Value::as_str);
                                    // Strictly match the target session ID! Never leak events across sessions!
                                    if let Some(aid) = active_id {
                                        aid == target_sid.as_str()
                                    } else {
                                        false
                                    }
                                }
                            };
                            if matches {
                                yield Ok(Event::default().data(msg.to_string()));
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn sse_roster(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if !auth::is_authorized_with_gate(&state.token, state.gate.as_deref(), &headers, query.token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let initial_sessions = if let Some(bridge) = &state.bridge {
        bridge.list_saved_sessions().await
            .ok()
            .and_then(|r| r.get("data").or(Some(&r)).cloned())
            .and_then(|d| d.get("sessions").cloned())
            .unwrap_or_else(|| serde_json::json!([]))
    } else {
        serde_json::json!([])
    };

    let mut rx = state.event_tx.subscribe();

    let stream = async_stream::stream! {
        yield Ok(Event::default().data(serde_json::json!({
            "type": "roster.connected",
            "available": true
        }).to_string()));

        yield Ok(Event::default().data(serde_json::json!({
            "type": "roster.snapshot",
            "available": true,
            "entries": initial_sessions,
            "roster": initial_sessions
        }).to_string()));

        let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(15));
        heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = heartbeat_interval.tick() => {
                    yield Ok(Event::default().comment("ping"));
                }
                msg_res = rx.recv() => {
                    match msg_res {
                        Ok(msg) => {
                            let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or_default();
                            // ONLY deliver roster-specific events to the global roster stream! Never session_event!
                            if msg_type.starts_with("roster") {
                                let mut out_msg = msg.clone();
                                if msg_type == "roster_update" {
                                    if let Some(obj) = out_msg.as_object_mut() {
                                        obj.insert("type".to_string(), Value::String("roster.update".to_string()));
                                    }
                                }
                                yield Ok(Event::default().data(out_msg.to_string()));
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[derive(serde::Deserialize)]
pub struct ExecCommandRequest {
    pub command: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

async fn exec_terminal(
    Json(payload): Json<ExecCommandRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let start = std::time::Instant::now();
    let cwd = payload
        .cwd
        .filter(|c| std::path::Path::new(c).is_dir())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .to_string()
        });

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let output = tokio::process::Command::new(shell)
        .arg("-c")
        .arg(&payload.command)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}{}", stdout, if !stderr.is_empty() { format!("\n{}", stderr) } else { String::new() });

    Ok(Json(serde_json::json!({
        "command": payload.command,
        "output": combined,
        "exitCode": output.status.code().unwrap_or(-1),
        "durationMs": start.elapsed().as_millis(),
        "cwd": cwd
    })))
}

#[derive(Deserialize)]
pub struct FsListQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

async fn get_fs_list(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<FsListQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let mut root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            if let Some(cwd) = data.get("cwd").or_else(|| data.get("state").and_then(|s| s.get("cwd"))).and_then(Value::as_str) {
                root = PathBuf::from(cwd);
            }
        }
    }

    let rel_req = query.path.unwrap_or_default();
    let target = if rel_req.trim().is_empty() { root.clone() } else { root.join(&rel_req) };
    let target = target.canonicalize().unwrap_or(target);

    // Reject escaping root if canonical root is known
    if let Ok(canonical_root) = root.canonicalize() {
        if !target.starts_with(&canonical_root) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&target) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = entry.file_type();
            let is_dir = ft.as_ref().map(|t| t.is_dir()).unwrap_or(false);
            let size = entry.metadata().ok().map(|m| m.len());
            entries.push(serde_json::json!({
                "name": name,
                "type": if is_dir { "dir" } else { "file" },
                "size": size,
            }));
        }
    }
    entries.sort_by(|a, b| {
        let a_dir = a.get("type").and_then(Value::as_str) == Some("dir");
        let b_dir = b.get("type").and_then(Value::as_str) == Some("dir");
        if a_dir != b_dir {
            return b_dir.cmp(&a_dir);
        }
        let a_name = a.get("name").and_then(Value::as_str).unwrap_or("");
        let b_name = b.get("name").and_then(Value::as_str).unwrap_or("");
        a_name.cmp(b_name)
    });

    let rel_display = if let Ok(canonical_root) = root.canonicalize() {
        target.strip_prefix(&canonical_root).unwrap_or(&target).to_string_lossy().to_string()
    } else {
        rel_req
    };

    Ok(Json(serde_json::json!({
        "path": rel_display,
        "entries": entries,
    })))
}

#[derive(Deserialize)]
pub struct FsFileQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub path: String,
}

#[derive(Deserialize)]
pub struct FsFilePutRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub path: String,
    pub content: String,
}

async fn get_fs_file(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<FsFileQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let mut root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            if let Some(cwd) = data.get("cwd").or_else(|| data.get("state").and_then(|s| s.get("cwd"))).and_then(Value::as_str) {
                root = PathBuf::from(cwd);
            }
        }
    }

    let target = root.join(&query.path);
    let target = target.canonicalize().unwrap_or(target);

    if let Ok(canonical_root) = root.canonicalize() {
        if !target.starts_with(&canonical_root) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    match std::fs::read(&target) {
        Ok(bytes) => {
            // Check if binary
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return Ok(Json(serde_json::json!({
                    "path": query.path,
                    "binary": true,
                    "size": bytes.len(),
                })));
            }
            let max_read = 1_000_000;
            let truncated = bytes.len() > max_read;
            let slice = if truncated { &bytes[..max_read] } else { &bytes[..] };
            let text = String::from_utf8_lossy(slice).to_string();
            Ok(Json(serde_json::json!({
                "path": query.path,
                "content": text,
                "truncated": truncated,
            })))
        }
        Err(_) => Err(StatusCode::NOT_FOUND),
    }
}

async fn put_fs_file(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<FsFilePutRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let mut root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        if let Ok(resp) = bridge.get_state(Some(sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            if let Some(cwd) = data.get("cwd").or_else(|| data.get("state").and_then(|s| s.get("cwd"))).and_then(Value::as_str) {
                root = PathBuf::from(cwd);
            }
        }
    }

    let target = root.join(&payload.path);
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&target, payload.content.as_bytes()) {
        Ok(()) => Ok(Json(serde_json::json!({ "path": payload.path, "ok": true }))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[derive(Deserialize)]
pub struct DialogRequest {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    pub id: String,
    pub confirmed: Option<bool>,
    pub value: Option<String>,
    pub cancelled: Option<bool>,
}

async fn post_dialog(
    State(state): State<Arc<ApiState>>,
    Json(payload): Json<DialogRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, &payload.session_id) {
        let mut response_obj = serde_json::Map::new();
        if let Some(c) = payload.confirmed { response_obj.insert("confirmed".to_string(), Value::Bool(c)); }
        if let Some(v) = payload.value { response_obj.insert("value".to_string(), Value::String(v)); }
        if let Some(c) = payload.cancelled { response_obj.insert("cancelled".to_string(), Value::Bool(c)); }

        let cmd = serde_json::json!({
            "type": "dialog_response",
            "activeSessionId": sid,
            "id": payload.id,
            "response": Value::Object(response_obj),
        });
        let _ = bridge.send_command(cmd).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn get_commands(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<SessionQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    if let (Some(bridge), Some(sid)) = (&state.bridge, query.session_id.as_deref()) {
        if let Ok(resp) = bridge.get_commands(Some(sid)).await {
            if resp.get("success") != Some(&serde_json::Value::Bool(false)) {
                let data = resp.get("data").unwrap_or(&resp);
                if data.get("commands").is_some() {
                    return Ok(Json(data.clone()));
                }
            }
        }
    }
    let default_commands = serde_json::json!({
        "commands": [
            { "name": "compact", "description": "Compact conversation context", "argumentHint": "[instructions]" },
            { "name": "clear", "description": "Clear conversation" },
            { "name": "model", "description": "Select or view model", "argumentHint": "[provider:model]" },
            { "name": "help", "description": "Show help" },
            { "name": "fork", "description": "Fork conversation from an earlier prompt" },
            { "name": "undo", "description": "Undo last message" },
            { "name": "status", "description": "Show status" },
            { "name": "diff", "description": "Show git diff" },
            { "name": "export", "description": "Export transcript to HTML" },
            { "name": "rename", "description": "Rename session", "argumentHint": "<title>" },
            { "name": "ctx-mode", "description": "Switch lean-ctx context profile", "argumentHint": "[coder|exploration|bugfix|review|hotfix|ci-debug|passthrough]" },
            { "name": "ctx-tools", "description": "Switch lean-ctx tool profile", "argumentHint": "[minimal|lean|standard|stage2|power]" }
        ]
    });
    Ok(Json(default_commands))
}

#[derive(Deserialize)]
pub struct SubagentMessagesQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, rename = "childId")]
    pub child_id: Option<String>,
}

async fn get_subagent_messages(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<SubagentMessagesQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let child_id = query.child_id.unwrap_or_default();
    let sid = query.session_id.unwrap_or_default();

    if let Some(bridge) = &state.bridge {
        if !child_id.is_empty() {
            let mut resolved_sid = child_id.clone();
            if let Ok(c_resp) = bridge.get_rlm_children(&sid).await {
                let c_data = c_resp.get("data").unwrap_or(&c_resp);
                if let Some(children) = c_data.get("children").and_then(Value::as_array) {
                    for c in children {
                        let id_match = c.get("id").or_else(|| c.get("rlmChildId")).and_then(Value::as_str);
                        if id_match == Some(&child_id) {
                            if let Some(asid) = c.get("activeSessionId").and_then(Value::as_str) {
                                resolved_sid = asid.to_string();
                                break;
                            }
                        }
                    }
                }
            }
            if let Ok(resp) = bridge.attach_session(&resolved_sid).await {
                let data = resp.get("data").unwrap_or(&resp);
                let formatted = format_session_snapshot_response(data);
                let messages = formatted.get("messages").cloned().unwrap_or_else(|| serde_json::json!([]));
                if !messages.as_array().map_or(true, |a| a.is_empty()) {
                    return Ok(Json(serde_json::json!({ "childId": child_id, "messages": messages })));
                }
            }
            if resolved_sid != child_id {
                if let Ok(resp) = bridge.attach_session(&child_id).await {
                    let data = resp.get("data").unwrap_or(&resp);
                    let formatted = format_session_snapshot_response(data);
                    let messages = formatted.get("messages").cloned().unwrap_or_else(|| serde_json::json!([]));
                    if !messages.as_array().map_or(true, |a| a.is_empty()) {
                        return Ok(Json(serde_json::json!({ "childId": child_id, "messages": messages })));
                    }
                }
            }
        }
        // Fallback: check on-disk session artifacts
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        let artifacts_dir = PathBuf::from(&home).join(".prime").join("agent").join("session-artifacts");
        if artifacts_dir.exists() {
            let search_dirs = vec![
                artifacts_dir.join(&sid).join(&child_id),
                artifacts_dir.join(&sid).join(format!("sub-{child_id}")),
                artifacts_dir.join(&child_id),
            ];
            for dir in search_dirs {
                if dir.is_dir() {
                    if let Ok(read_dir) = std::fs::read_dir(&dir) {
                        for entry in read_dir.flatten() {
                            let p = entry.path();
                            if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                                if let Ok(content) = std::fs::read_to_string(&p) {
                                    let mut msgs = Vec::new();
                                    for line in content.lines() {
                                        if let Ok(val) = serde_json::from_str::<Value>(line.trim()) {
                                            if val.get("role").is_some() || val.get("message").is_some() {
                                                msgs.push(val);
                                            }
                                        }
                                    }
                                    return Ok(Json(serde_json::json!({ "childId": child_id, "messages": msgs })));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(Json(serde_json::json!({ "childId": child_id, "messages": [] })))
}

pub fn resolve_static_dir(custom: Option<PathBuf>) -> PathBuf {
    if let Some(c) = custom {
        if c.exists() {
            return c;
        }
    }
    if let Ok(dir) = std::env::var("PRIME_AGENT_WEB_STATIC_DIR") {
        let p = PathBuf::from(dir);
        if p.exists() {
            return p;
        }
    }
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidates = [
        current.join("web"),
        current.join("static"),
    ];
    for cand in candidates {
        if cand.exists() {
            return cand;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            let cand = parent.join("web");
            if cand.exists() {
                return cand;
            }
        }
    }
    current.join("web")
}

pub async fn start_api_server(options: ServerOptions) -> anyhow::Result<()> {
    let host = if options.host.trim().is_empty() {
        std::env::var("PRIME_AGENT_API_HOST").unwrap_or_else(|_| "0.0.0.0".to_string())
    } else {
        options.host
    };

    let port: u16 = if options.port != 0 {
        options.port
    } else {
        std::env::var("PRIME_AGENT_API_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(4677)
    };

    let token = options.token.unwrap_or_else(auth::get_or_create_dedicated_token);
    let static_dir = resolve_static_dir(options.static_dir);

    let socket_path = options.daemon_socket.unwrap_or_else(daemon_pool::get_default_socket_path);
    let (bridge_opt, event_tx) = match DaemonBridge::connect_to(socket_path).await {
        Ok((bridge, _rx)) => {
            println!("🔗 Connected to local Prime Agent daemon socket!");
            let tx = bridge.event_tx.clone();
            (Some(bridge), tx)
        }
        Err(e) => {
            println!("⚠️ Notice: Daemon socket not yet answering ({e}), starting in standalone mode.");
            let (tx, _) = broadcast::channel(1000);
            (None, tx)
        }
    };

    let auth_mode = options.auth_mode.clone()
        .or_else(|| std::env::var("PRIME_AGENT_WEB_AUTH").ok())
        .unwrap_or_else(|| "token".to_string());

    let gate = if auth_mode == "password" {
        let data_dir = options.data_dir.clone().unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".prime").join("agent").join("prime-agent-web")
        });
        let env_pass = options.password.clone().or_else(|| std::env::var("PRIME_AGENT_WEB_PASSWORD").ok());
        Some(Arc::new(password::PasswordGate::new(data_dir, env_pass)))
    } else {
        None
    };

    let state = Arc::new(ApiState {
        token: token.clone(),
        static_dir: static_dir.clone(),
        bridge: bridge_opt,
        event_tx,
        gate,
    });

    let app = create_router(state);
    let addr: SocketAddr = format!("{host}:{port}").parse()?;

    println!("⚡ Prime Agent Native Rust API Gateway running at http://{addr}");
    println!("🔑 Token: {token}");
    if static_dir.exists() {
        println!("📁 Web UI static root: {}", static_dir.display());
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

pub fn run_server_blocking(options: ServerOptions) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(start_api_server(options))
}
