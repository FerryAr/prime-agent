//! Async daemon connection and request dispatcher.

use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{broadcast, oneshot, Mutex};

pub struct DaemonBridge {
    writer: Arc<Mutex<tokio::io::WriteHalf<UnixStream>>>,
    request_id: AtomicU64,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    pub event_tx: broadcast::Sender<Value>,
}

impl DaemonBridge {
    pub async fn connect() -> Result<(Arc<Self>, broadcast::Receiver<Value>)> {
        let socket_path = get_default_socket_path();
        Self::connect_to(socket_path).await
    }

    pub async fn connect_to(socket_path: PathBuf) -> Result<(Arc<Self>, broadcast::Receiver<Value>)> {
        let stream = UnixStream::connect(&socket_path)
            .await
            .map_err(|e| anyhow!("Failed to connect to daemon socket at {}: {}", socket_path.display(), e))?;

        let (reader_half, writer_half) = tokio::io::split(stream);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, event_rx) = broadcast::channel(1000);

        let bridge = Arc::new(Self {
            writer: Arc::new(Mutex::new(writer_half)),
            request_id: AtomicU64::new(1),
            pending: pending.clone(),
            event_tx: event_tx.clone(),
        });

        // Background reader task: routes JSON lines to matching request or broadcasts events
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader_half);
            let mut line = String::new();
            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 {
                    break;
                }
                let trimmed = line.trim();
                if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                        let mut map = pending.lock().await;
                        if let Some(tx) = map.remove(id) {
                            let _ = tx.send(val.clone());
                        }
                    }
                    let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                    if msg_type != "response" && msg_type != "daemon_hello" {
                        let _ = event_tx.send(val);
                    }
                }
                line.clear();
            }
        });

        Ok((bridge, event_rx))
    }

    pub async fn send_command(&self, command: Value) -> Result<Value> {
        let req_id = format!("api_{}", self.request_id.fetch_add(1, Ordering::SeqCst));

        let envelope = serde_json::json!({
            "type": "command",
            "id": req_id.clone(),
            "protocol": {
                "name": "prime-agent.daemon",
                "version": 7
            },
            "command": command
        });

        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().await;
            map.insert(req_id, tx);
        }

        let mut payload = envelope.to_string();
        payload.push('\n');

        {
            let mut writer = self.writer.lock().await;
            writer.write_all(payload.as_bytes()).await?;
            writer.flush().await?;
        }

        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => Err(anyhow!("Connection closed before response")),
            Err(_) => Err(anyhow!("Daemon request timed out")),
        }
    }

    pub async fn attach_session(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "attach",
            "activeSessionId": active_session_id,
            "capabilities": ["attach_snapshot", "event_sequence", "extension_ui"]
        });
        self.send_command(cmd).await
    }

    pub async fn create_session(&self, cwd: Option<&str>, session_file: Option<&str>) -> Result<Value> {
        let mut config = serde_json::json!({
            "telemetryDisabled": true
        });
        if let Some(c) = cwd {
            config["cwd"] = Value::String(c.to_string());
        }
        let mut cmd = serde_json::json!({
            "type": "create",
            "config": config,
            "lifecycle": "resident"
        });
        if let Some(sf) = session_file {
            cmd["sessionPath"] = Value::String(sf.to_string());
        }
        self.send_command(cmd).await
    }

    pub async fn list_saved_sessions(&self) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "list",
            "all": true
        });
        self.send_command(cmd).await
    }

    pub async fn get_session_stats(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "get_session_stats",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn get_state(&self, active_session_id: Option<&str>) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "get_state",
            "activeSessionId": active_session_id
        });
        self.send_command(cmd).await
    }

    pub async fn prompt(
        &self,
        active_session_id: &str,
        message: &str,
        images: Option<Value>,
        streaming_behavior: Option<&str>,
    ) -> Result<Value> {
        let mut cmd = serde_json::json!({
            "type": "prompt",
            "activeSessionId": active_session_id,
            "message": message,
            "queueIfBusy": true,
        });
        if let Some(imgs) = images {
            cmd["images"] = imgs;
        }
        if let Some(sb) = streaming_behavior {
            cmd["streamingBehavior"] = Value::String(sb.to_string());
        }
        self.send_command(cmd).await
    }

    pub async fn prompt_and_wait(
        &self,
        active_session_id: &str,
        message: &str,
        images: Option<Value>,
    ) -> Result<Value> {
        let mut cmd = serde_json::json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_session_id,
            "message": message,
            "queueIfBusy": true,
        });
        if let Some(imgs) = images {
            cmd["images"] = imgs;
        }
        self.send_command(cmd).await
    }

    pub async fn steer(&self, active_session_id: &str, message: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "steer",
            "activeSessionId": active_session_id,
            "message": message
        });
        self.send_command(cmd).await
    }

    pub async fn resume_queue(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "resume_queue",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn abort(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "abort",
            "activeSessionId": active_session_id
        });
        self.send_command(cmd).await
    }

    pub async fn kill(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "kill",
            "activeSessionId": active_session_id
        });
        self.send_command(cmd).await
    }

    pub async fn rename(&self, active_session_id: &str, title: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "rename",
            "activeSessionId": active_session_id,
            "title": title
        });
        self.send_command(cmd).await
    }

    pub async fn get_available_models(&self, active_session_id: Option<&str>) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "get_available_models",
            "activeSessionId": active_session_id
        });
        self.send_command(cmd).await
    }

    pub async fn set_model(&self, active_session_id: &str, provider: &str, model_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "set_model",
            "activeSessionId": active_session_id,
            "model": {
                "provider": provider,
                "id": model_id
            }
        });
        self.send_command(cmd).await
    }

    pub async fn get_fork_messages(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "get_user_messages_for_forking",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn fork(&self, active_session_id: &str, entry_id: &str, position: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "fork",
            "activeSessionId": active_session_id,
            "entryId": entry_id,
            "position": position,
        });
        self.send_command(cmd).await
    }

    pub async fn new_session(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "new_session",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn get_session_tree(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "get_session_tree",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }
    pub async fn set_thinking_level(&self, active_session_id: &str, level: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "set_thinking_level",
            "activeSessionId": active_session_id,
            "level": level,
        });
        self.send_command(cmd).await
    }

    pub async fn compact(&self, active_session_id: &str, instructions: Option<&str>) -> Result<Value> {
        let mut cmd = serde_json::json!({
            "type": "compact",
            "activeSessionId": active_session_id,
        });
        if let Some(inst) = instructions {
            cmd["customInstructions"] = Value::String(inst.to_string());
        }
        self.send_command(cmd).await
    }

    pub async fn set_auto_compaction(&self, active_session_id: &str, enabled: bool) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "set_auto_compaction",
            "activeSessionId": active_session_id,
            "enabled": enabled,
        });
        self.send_command(cmd).await
    }

    pub async fn refine(
        &self,
        active_session_id: &str,
        instructions: Option<&str>,
        rollback_id: Option<&str>,
        global: Option<bool>,
    ) -> Result<Value> {
        let mut cmd = serde_json::json!({
            "type": "refine",
            "activeSessionId": active_session_id,
        });
        if let Some(i) = instructions { cmd["instructions"] = Value::String(i.to_string()); }
        if let Some(r) = rollback_id { cmd["rollbackId"] = Value::String(r.to_string()); }
        if let Some(g) = global { cmd["global"] = Value::Bool(g); }
        self.send_command(cmd).await
    }

    pub async fn reload(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "reload",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn start_side_question(&self, active_session_id: &str, id: &str, question: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": active_session_id,
            "sideQuestionId": id,
            "question": question,
        });
        self.send_command(cmd).await
    }

    pub async fn abort_side_question(&self, active_session_id: &str, id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "abort_side_question",
            "activeSessionId": active_session_id,
            "sideQuestionId": id,
        });
        self.send_command(cmd).await
    }

    pub async fn get_rlm_children(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "get_rlm_children",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn list_cron_jobs(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "cron_list",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn add_cron_job(&self, active_session_id: &str, schedule: &str, prompt: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "cron_add",
            "activeSessionId": active_session_id,
            "schedule": schedule,
            "prompt": prompt,
        });
        self.send_command(cmd).await
    }

    pub async fn cancel_cron_job(&self, active_session_id: &str, job_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "cron_cancel",
            "activeSessionId": active_session_id,
            "jobId": job_id,
        });
        self.send_command(cmd).await
    }

    pub async fn list_heartbeats(&self, active_session_id: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "heartbeats_list",
            "activeSessionId": active_session_id,
        });
        self.send_command(cmd).await
    }

    pub async fn manage_heartbeat(
        &self,
        active_session_id: &str,
        job_id: &str,
        action: &str,
    ) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "heartbeat_manage",
            "activeSessionId": active_session_id,
            "jobId": job_id,
            "action": action,
        });
        self.send_command(cmd).await
    }

    pub async fn set_heartbeat(
        &self,
        active_session_id: &str,
        schedule: &str,
        instruction: &str,
        delivery_mode: Option<&str>,
    ) -> Result<Value> {
        let mut cmd = serde_json::json!({
            "type": "heartbeat_set",
            "activeSessionId": active_session_id,
            "schedule": schedule,
            "instruction": instruction,
        });
        if let Some(dm) = delivery_mode {
            cmd["deliveryMode"] = Value::String(dm.to_string());
        }
        self.send_command(cmd).await
    }

    pub async fn delete_saved_session(&self, session_path: &str) -> Result<Value> {
        let cmd = serde_json::json!({
            "type": "delete_saved_session",
            "sessionPath": session_path,
        });
        self.send_command(cmd).await
    }

    pub async fn get_commands(&self, active_session_id: Option<&str>) -> Result<Value> {
        let mut cmd = serde_json::json!({
            "type": "get_commands",
        });
        if let Some(sid) = active_session_id {
            cmd["activeSessionId"] = serde_json::Value::String(sid.to_string());
        }
        self.send_command(cmd).await
    }
}


pub fn get_default_socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("PRIME_AGENT_API_DAEMON_SOCKET") {
        if !p.trim().is_empty() {
            return PathBuf::from(p.trim());
        }
    }
    if let Ok(p) = std::env::var("PRIME_AGENT_WEB_DAEMON_SOCKET") {
        if !p.trim().is_empty() {
            return PathBuf::from(p.trim());
        }
    }
    pa_daemon::socket::default_daemon_socket_path()
}
