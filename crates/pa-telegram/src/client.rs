use std::path::PathBuf;
use anyhow::{Context, Result};
use serde_json::Value;

pub struct PrimeAgentClient {
    pub api_url: String,
    pub api_token: Option<String>,
    pub daemon_socket: Option<PathBuf>,
    http_client: reqwest::Client,
}

impl PrimeAgentClient {
    pub fn new(
        daemon_socket: Option<PathBuf>,
        api_url: String,
        api_token: Option<String>,
    ) -> Self {
        Self {
            daemon_socket,
            api_url: api_url.trim_end_matches('/').to_string(),
            api_token,
            http_client: reqwest::Client::new(),
        }
    }

    fn authed_get(&self, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.http_client.get(format!("{}{path}", self.api_url));
        if let Some(token) = &self.api_token {
            req = req.bearer_auth(token).header("x-prime-agent-token", token);
        }
        req
    }

    fn authed_post(&self, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.http_client.post(format!("{}{path}", self.api_url));
        if let Some(token) = &self.api_token {
            req = req.bearer_auth(token).header("x-prime-agent-token", token);
        }
        req
    }

    fn authed_delete(&self, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.http_client.delete(format!("{}{path}", self.api_url));
        if let Some(token) = &self.api_token {
            req = req.bearer_auth(token).header("x-prime-agent-token", token);
        }
        req
    }

    pub async fn get_meta(&self) -> Result<Value> {
        let res = self.authed_get("/api/meta").send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn list_sessions(&self) -> Result<Value> {
        let res = self.authed_get("/api/sessions").send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn open_session(&self, body: Option<Value>) -> Result<Value> {
        let payload = body.unwrap_or_else(|| serde_json::json!({}));
        let res = self.authed_post("/api/session").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn prompt(&self, session_id: &str, prompt: &str) -> Result<Value> {
        self.prompt_with_images(session_id, prompt, None).await
    }

    pub async fn prompt_with_images(
        &self,
        session_id: &str,
        prompt: &str,
        images: Option<Value>,
    ) -> Result<Value> {
        let mut payload = serde_json::json!({
            "sessionId": session_id,
            "message": prompt,
            "prompt": prompt,
            "wait": true,
        });
        if let Some(imgs) = images {
            payload["images"] = imgs;
        }

        let res = self.authed_post("/api/prompt")
            .json(&payload)
            .send()
            .await
            .context("Failed to send prompt to prime-agent-api")?;

        let val = res.json::<Value>().await?;
        Ok(val)
    }

    pub async fn steer(&self, session_id: &str, message: &str) -> Result<Value> {
        let payload = serde_json::json!({ "sessionId": session_id, "message": message });
        let res = self.authed_post("/api/steer").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn abort(&self, session_id: &str) -> Result<Value> {
        let payload = serde_json::json!({ "sessionId": session_id });
        let res = self.authed_post("/api/abort").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn get_state(&self, session_id: Option<&str>) -> Result<Value> {
        let path = match session_id {
            Some(id) => format!("/api/state?sessionId={id}"),
            None => "/api/state".to_string(),
        };
        let res = self.authed_get(&path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn create_session(&self, cwd: Option<&str>) -> Result<Value> {
        let mut payload = serde_json::json!({});
        if let Some(c) = cwd {
            payload["cwd"] = Value::String(c.to_string());
        }
        let res = self.authed_post("/api/session").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn get_models(&self, session_id: Option<&str>) -> Result<Value> {
        let path = match session_id {
            Some(id) => format!("/api/models?sessionId={id}"),
            None => "/api/models".to_string(),
        };
        let res = self.authed_get(&path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn set_model(&self, session_id: &str, provider: &str, model_id: &str) -> Result<Value> {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "provider": provider,
            "modelId": model_id,
        });
        let res = self.authed_post("/api/model").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn set_thinking(&self, session_id: &str, level: &str) -> Result<Value> {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "level": level,
        });
        let res = self.authed_post("/api/thinking").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn compact(&self, session_id: &str) -> Result<Value> {
        let payload = serde_json::json!({ "sessionId": session_id });
        let res = self.authed_post("/api/compact").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn git_diff(&self, session_id: Option<&str>) -> Result<Value> {
        let path = match session_id {
            Some(id) => format!("/api/git/diff?sessionId={id}"),
            None => "/api/git/diff".to_string(),
        };
        let res = self.authed_get(&path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn browse_fs(&self, path: Option<&str>) -> Result<Value> {
        let url_path = match path {
            Some(p) => format!("/api/fs/browse?path={}", url_encode(p)),
            None => "/api/fs/browse".to_string(),
        };
        let res = self.authed_get(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn list_workspace(&self, session_id: &str, path: &str) -> Result<Value> {
        let url_path = format!("/api/fs/list?sessionId={}&path={}", url_encode(session_id), url_encode(path));
        let res = self.authed_get(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn read_workspace_file(&self, session_id: &str, path: &str) -> Result<Value> {
        let url_path = format!("/api/fs/file?sessionId={}&path={}", url_encode(session_id), url_encode(path));
        let res = self.authed_get(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn list_cron_jobs(&self, session_id: &str) -> Result<Value> {
        let url_path = format!("/api/cron?sessionId={}&includeInactive=1", url_encode(session_id));
        let res = self.authed_get(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn cancel_cron_job(&self, session_id: &str, job_id: &str) -> Result<Value> {
        let url_path = format!("/api/cron?sessionId={}&jobId={}", url_encode(session_id), url_encode(job_id));
        let res = self.authed_delete(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn rename_session(&self, session_id: &str, name: &str) -> Result<Value> {
        let payload = serde_json::json!({ "sessionId": session_id, "name": name });
        let res = self.authed_post("/api/session-name").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<Value> {
        let url_path = format!("/api/session?sessionId={}", url_encode(session_id));
        let res = self.authed_delete(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn get_subagent_messages(&self, session_id: &str, child_id: &str) -> Result<Value> {
        let url_path = format!("/api/subagent-messages?sessionId={}&childId={}", url_encode(session_id), url_encode(child_id));
        let res = self.authed_get(&url_path).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn ask_side_question(&self, session_id: &str, id: &str, question: &str) -> Result<Value> {
        let payload = serde_json::json!({ "sessionId": session_id, "id": id, "question": question });
        let res = self.authed_post("/api/side-question").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn export_session(&self, session_id: &str) -> Result<Value> {
        let payload = serde_json::json!({ "sessionId": session_id });
        let res = self.authed_post("/api/export").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn respond_dialog(&self, session_id: &str, id: &str, confirmed: bool) -> Result<Value> {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "id": id,
            "confirmed": confirmed,
        });
        let res = self.authed_post("/api/dialog").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }

    pub async fn subscribe_events(
        &self,
        session_id: &str,
    ) -> Result<tokio::sync::mpsc::Receiver<Value>> {
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        let url_path = format!("/events?sessionId={}", url_encode(session_id));
        let req = self.authed_get(&url_path).header("accept", "text/event-stream");
        let resp = req.send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("SSE stream failed: HTTP {}", resp.status());
        }

        tokio::spawn(async move {
            use futures::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut buffer = String::new();
            while let Some(chunk_res) = stream.next().await {
                let Ok(chunk) = chunk_res else { break };
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(idx) = buffer.find("\n\n") {
                    let event_block = buffer[..idx].to_string();
                    buffer = buffer[idx + 2..].to_string();
                    for line in event_block.lines() {
                        let trimmed = line.trim();
                        if let Some(data) = trimmed.strip_prefix("data:") {
                            if let Ok(val) = serde_json::from_str::<Value>(data.trim()) {
                                if tx.send(val).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(rx)
    }

    pub async fn exec_terminal(&self, session_id: Option<&str>, command: &str) -> Result<Value> {
        let mut payload = serde_json::json!({ "command": command });
        if let Some(sid) = session_id { payload["sessionId"] = Value::String(sid.to_string()); }
        let res = self.authed_post("/api/terminal/exec").json(&payload).send().await?;
        Ok(res.json::<Value>().await?)
    }
}


fn url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}
