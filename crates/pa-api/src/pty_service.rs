//! WebSocket PTY terminal service.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Deserialize)]
pub struct WsQuery {
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};

pub async fn ws_terminal_handler(
    State(state): State<Arc<crate::ApiState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    axum::extract::Query(query): axum::extract::Query<WsQuery>,
) -> impl IntoResponse {
    if !crate::auth::is_authorized_with_gate(&state.token, state.gate.as_deref(), &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let mut resolved_cwd = query
        .cwd
        .filter(|c| std::path::Path::new(c).is_dir())
        .map(PathBuf::from);

    if resolved_cwd.is_none() {
        if let (Some(bridge), Some(sid)) = (&state.bridge, &query.session_id) {
            if let Ok(resp) = bridge.get_state(Some(sid)).await {
                let data = resp.get("data").unwrap_or(&resp);
                if let Some(c) = data.get("cwd").or_else(|| data.get("state").and_then(|s| s.get("cwd"))).and_then(serde_json::Value::as_str) {
                    let p = PathBuf::from(c);
                    if p.is_dir() {
                        resolved_cwd = Some(p);
                    }
                }
            }
        }
    }

    let cwd = resolved_cwd.unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });

    ws.on_upgrade(move |socket| handle_terminal_socket(socket, cwd))
}

async fn handle_terminal_socket(mut socket: WebSocket, cwd: PathBuf) {
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(_) => return,
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(_) => return,
    };
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(_) => return,
    };

    let (out_tx, mut out_rx) = mpsc::channel::<String>(100);

    // Read thread from PTY -> WS channel
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            if out_tx.blocking_send(text).is_err() {
                break;
            }
        }
    });

    let pair_master = Arc::new(std::sync::Mutex::new(pair.master));

    loop {
        tokio::select! {
            Some(output) = out_rx.recv() => {
                let msg = serde_json::json!({
                    "type": "output",
                    "data": output
                });
                if socket.send(Message::Text(msg.to_string().into())).await.is_err() {
                    break;
                }
            }
            Some(Ok(msg)) = socket.recv() => {
                if let Message::Text(text) = msg {
                    if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                        match client_msg {
                            ClientMessage::Input { data } => {
                                let _ = writer.write_all(data.as_bytes());
                                let _ = writer.flush();
                            }
                            ClientMessage::Resize { cols, rows } => {
                                if let Ok(master) = pair_master.lock() {
                                    let _ = master.resize(PtySize {
                                        rows: rows.max(5).min(200),
                                        cols: cols.max(10).min(500),
                                        pixel_width: 0,
                                        pixel_height: 0,
                                    });
                                }
                            }
                        }
                    } else {
                        let _ = writer.write_all(text.as_bytes());
                        let _ = writer.flush();
                    }
                }
            }
            else => break,
        }
    }

    let _ = child.kill();
}
