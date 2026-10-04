use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct BotConfig {
    pub bot_token: String,
    pub allowed_user_ids: Vec<i64>,
    pub api_url: String,
    pub api_token: Option<String>,
    pub daemon_socket: Option<PathBuf>,
    pub whisper_api_key: Option<String>,
    pub whisper_base_url: Option<String>,
}

impl BotConfig {
    pub fn from_env_and_args(args: &[String]) -> Result<Self, String> {
        auto_load_env();

        let bot_token = find_flag(args, "--token")
            .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok())
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| "Telegram bot token is required (--token or TELEGRAM_BOT_TOKEN)".to_string())?;

        let user_id_str = find_flag(args, "--user-id")
            .or_else(|| std::env::var("TELEGRAM_ALLOWED_USER_ID").ok())
            .or_else(|| std::env::var("TELEGRAM_ALLOWED_USERS").ok())
            .or_else(|| std::env::var("TELEGRAM_USER_ID").ok())
            .unwrap_or_default();

        let allowed_user_ids: Vec<i64> = user_id_str
            .split(',')
            .filter_map(|s| s.trim().parse::<i64>().ok())
            .collect();

        let api_url = find_flag(args, "--api-url")
            .or_else(try_read_gateway_url)
            .unwrap_or_else(|| "http://127.0.0.1:4677".to_string());

        let api_token = find_flag(args, "--api-token")
            .or_else(try_read_gateway_token);

        let daemon_socket = find_flag(args, "--daemon-socket")
            .map(PathBuf::from)
            .or_else(|| std::env::var("PRIME_AGENT_DAEMON_SOCKET").ok().map(PathBuf::from));

        let whisper_api_key = find_flag(args, "--whisper-key")
            .or_else(|| std::env::var("WHISPER_API_KEY").ok())
            .or_else(|| std::env::var("OPENAI_API_KEY").ok());

        let whisper_base_url = find_flag(args, "--whisper-base-url")
            .or_else(|| std::env::var("WHISPER_BASE_URL").ok());

        Ok(Self {
            bot_token,
            allowed_user_ids,
            api_url,
            api_token,
            daemon_socket,
            whisper_api_key,
            whisper_base_url,
        })
    }
}

pub fn try_read_gateway_token() -> Option<String> {
    if let Ok(tok) = std::env::var("PRIME_AGENT_API_TOKEN") {
        if !tok.trim().is_empty() {
            return Some(tok.trim().to_string());
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let home_path = PathBuf::from(home);

    // 1. Try reading the permanent dedicated API token first
    let api_tok_file = home_path.join(".prime").join("agent").join("prime-agent-api").join("api-token.txt");
    if let Ok(tok) = std::fs::read_to_string(api_tok_file) {
        let trimmed = tok.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    // 2. Check gateway.json from prime-agent-api or prime-agent-web
    for sub in &["prime-agent-api", "prime-agent-web"] {
        let gw = home_path.join(".prime").join("agent").join(sub).join("gateway.json");
        if let Ok(content) = std::fs::read_to_string(gw) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(t) = val.get("token").and_then(|v| v.as_str()) {
                    if !t.trim().is_empty() {
                        return Some(t.trim().to_string());
                    }
                }
            }
        }
    }

    None
}

pub fn try_read_gateway_url() -> Option<String> {
    if let Ok(url) = std::env::var("PRIME_AGENT_API_URL") {
        if !url.trim().is_empty() {
            return Some(url.trim().to_string());
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let home_path = PathBuf::from(home);
    for sub in &["prime-agent-api", "prime-agent-web"] {
        let gw = home_path.join(".prime").join("agent").join(sub).join("gateway.json");
        if let Ok(content) = std::fs::read_to_string(gw) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(u) = val.get("url").and_then(|v| v.as_str()) {
                    if !u.trim().is_empty() {
                        return Some(u.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

fn find_flag(args: &[String], flag: &str) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        if a == flag {
            return args.get(i + 1).cloned();
        }
        if let Some(val) = a.strip_prefix(&format!("{flag}=")) {
            return Some(val.to_string());
        }
    }
    None
}


pub fn auto_load_env() {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let agent_dir = PathBuf::from(&home).join(".prime").join("agent");
    let candidates = [
        agent_dir.join("prime-agent-telegram").join(".env"),
        agent_dir.join(".env"),
        PathBuf::from(&home).join(".prime").join("prime-agent-telegram").join(".env"),
        PathBuf::from(&home).join(".prime").join(".env"),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            if let Ok(content) = std::fs::read_to_string(candidate) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    if let Some(eq_idx) = trimmed.find('=') {
                        let key = trimmed[..eq_idx].trim();
                        let mut val = trimmed[eq_idx + 1..].trim();
                        if (val.starts_with('"') && val.ends_with('"'))
                            || (val.starts_with('\'') && val.ends_with('\''))
                        {
                            val = &val[1..val.len() - 1];
                        }
                        if std::env::var(key).is_err() {
                            std::env::set_var(key, val);
                        }
                    }
                }
            }
        }
    }
}
