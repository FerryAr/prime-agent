//! Token resolution and constant-time validation.

use std::fs;
use std::path::PathBuf;

use axum::http::HeaderMap;

pub fn get_or_create_dedicated_token() -> String {
    if let Ok(tok) = std::env::var("PRIME_AGENT_API_TOKEN") {
        if !tok.trim().is_empty() {
            return tok.trim().to_string();
        }
    }

    let token_path = get_token_file_path();
    if let Ok(existing) = fs::read_to_string(&token_path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    let new_token = format!("{}_{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    if let Some(parent) = token_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&token_path, format!("{}
", new_token));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600));
    }

    new_token
}

pub fn get_token_file_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".prime")
        .join("agent")
        .join("prime-agent-api")
        .join("api-token.txt")
}

pub fn tokens_match(expected: &str, candidate: &str) -> bool {
    if expected.len() != candidate.len() {
        return false;
    }
    let mut result = 0u8;
    for (a, b) in expected.bytes().zip(candidate.bytes()) {
        result |= a ^ b;
    }
    result == 0
}

pub fn extract_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_hdr = headers.get("cookie").and_then(|v| v.to_str().ok())?;
    for pair in cookie_hdr.split(';') {
        let mut parts = pair.trim().splitn(2, '=');
        if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
            if k == name {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn is_authorized(expected_token: &str, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    if expected_token.trim().is_empty() {
        return true;
    }

    if let Some(qt) = query_token {
        if tokens_match(expected_token, qt) {
            return true;
        }
    }

    if let Some(auth_hdr) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(bearer) = auth_hdr.strip_prefix("Bearer ") {
            if tokens_match(expected_token, bearer.trim()) {
                return true;
            }
        }
        if tokens_match(expected_token, auth_hdr.trim()) {
            return true;
        }
    }

    if let Some(custom) = headers.get("x-prime-agent-token").and_then(|v| v.to_str().ok()) {
        if tokens_match(expected_token, custom.trim()) {
            return true;
        }
    }

    if let Some(custom) = headers.get("x-prime-web-token").and_then(|v| v.to_str().ok()) {
        if tokens_match(expected_token, custom.trim()) {
            return true;
        }
    }

    false
}

pub fn is_authorized_with_gate(
    expected_token: &str,
    gate: Option<&crate::password::PasswordGate>,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> bool {
    if let Some(g) = gate {
        if let Some(cookie_val) = extract_cookie(headers, crate::password::SESSION_COOKIE) {
            if g.resolve_login(Some(&cookie_val)) {
                return true;
            }
        }
    }

    is_authorized(expected_token, headers, query_token)
}

pub fn is_allowed_origin(origin: &str, host_header: Option<&str>) -> bool {
    // Strip scheme
    let without_scheme = origin.strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    let host_only = host.split(':').next().unwrap_or(host);

    if host_only == "127.0.0.1" || host_only == "localhost" || host_only == "::1" || host_only == "0.0.0.0" {
        return true;
    }
    if let Some(hh) = host_header {
        let expected_host = hh.split(':').next().unwrap_or(hh);
        if host_only == expected_host {
            return true;
        }
    }
    false
}
