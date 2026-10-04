//! Single-user password gate: one password, persistent browser sessions.
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SESSION_COOKIE: &str = "prime_agent_session";
pub const DEFAULT_WEB_PASSWORD: &str = "primeagent";
const LOGIN_TTL_SECS: u64 = 365 * 24 * 3600;
const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_FAILURE_WINDOW_SECS: u64 = 600;
const LOGIN_BASE_LOCK_SECS: u64 = 30;
const LOGIN_MAX_LOCK_SECS: u64 = 900;

#[derive(Serialize, Deserialize, Clone)]
struct StoredPassword {
    salt: String,
    hash: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredSession {
    token: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

pub struct PasswordGate {
    data_dir: PathBuf,
    logins: Mutex<HashMap<String, u64>>,
    failures: Mutex<HashMap<String, (u32, u64)>>,
    lockouts: Mutex<HashMap<String, u64>>,
    pub generated_password: Option<String>,
}

impl PasswordGate {
    pub fn new(data_dir: PathBuf, env_password: Option<String>) -> Self {
        let _ = fs::create_dir_all(&data_dir);
        let mut logins = HashMap::new();
        let logins_path = data_dir.join("sessions.json");
        if let Ok(content) = fs::read_to_string(&logins_path) {
            if let Ok(parsed) = serde_json::from_str::<Vec<StoredSession>>(&content) {
                let now = now_secs();
                for s in parsed {
                    if s.expires_at > now {
                        logins.insert(s.token, s.expires_at);
                    }
                }
            }
        }

        let password_path = data_dir.join("password.json");
        let mut generated_password = None;

        let needs_store = env_password.is_some() || !password_path.exists();
        let gate = Self {
            data_dir,
            logins: Mutex::new(logins),
            failures: Mutex::new(HashMap::new()),
            lockouts: Mutex::new(HashMap::new()),
            generated_password: None,
        };

        if needs_store {
            let pass = env_password.unwrap_or_else(|| DEFAULT_WEB_PASSWORD.to_string());
            gate.store_password(&pass);
            generated_password = Some(pass);
        }

        Self {
            generated_password,
            ..gate
        }
    }

    fn password_path(&self) -> PathBuf {
        self.data_dir.join("password.json")
    }

    fn logins_path(&self) -> PathBuf {
        self.data_dir.join("sessions.json")
    }

    fn store_password(&self, password: &str) {
        let salt = format!("{:x}_{:x}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let hash = hash_password(password, &salt);
        let stored = StoredPassword { salt, hash };
        if let Ok(json) = serde_json::to_string_pretty(&stored) {
            let _ = fs::write(self.password_path(), json);
        }
    }

    pub fn verify(&self, password: &str) -> bool {
        let Ok(content) = fs::read_to_string(self.password_path()) else {
            return false;
        };
        let Ok(stored) = serde_json::from_str::<StoredPassword>(&content) else {
            return false;
        };
        let candidate_hash = hash_password(password, &stored.salt);
        tokens_match(&stored.hash, &candidate_hash)
    }

    pub fn change_password(&self, current: &str, new_pass: &str) -> Result<(), &'static str> {
        if !self.verify(current) {
            return Err("Current password is incorrect");
        }
        if new_pass.trim().len() < 4 {
            return Err("New password must be at least 4 characters");
        }
        self.store_password(new_pass.trim());
        Ok(())
    }

    pub fn create_login(&self) -> String {
        let token = format!("{:x}_{:x}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let expires_at = now_secs() + LOGIN_TTL_SECS;
        {
            let mut logins = self.logins.lock().unwrap();
            logins.insert(token.clone(), expires_at);
        }
        self.persist_logins();
        token
    }

    pub fn resolve_login(&self, token: Option<&str>) -> bool {
        let Some(t) = token else { return false; };
        let mut logins = self.logins.lock().unwrap();
        let now = now_secs();
        if let Some(&expires_at) = logins.get(t) {
            if expires_at >= now {
                return true;
            }
            logins.remove(t);
        }
        false
    }

    pub fn logout(&self, token: Option<&str>) {
        if let Some(t) = token {
            let mut logins = self.logins.lock().unwrap();
            if logins.remove(t).is_some() {
                drop(logins);
                self.persist_logins();
            }
        }
    }

    pub fn locked_for_ms(&self, ip: &str) -> u64 {
        let lockouts = self.lockouts.lock().unwrap();
        let now = now_secs();
        if let Some(&until) = lockouts.get(ip) {
            if until > now {
                return (until - now) * 1000;
            }
        }
        0
    }

    pub fn record_failure(&self, ip: &str) {
        let now = now_secs();
        let mut failures = self.failures.lock().unwrap();
        let entry = failures.entry(ip.to_string()).or_insert((0, now));
        if now - entry.1 > LOGIN_FAILURE_WINDOW_SECS {
            *entry = (1, now);
        } else {
            entry.0 += 1;
        }

        if entry.0 >= LOGIN_MAX_FAILURES {
            let exponent = (entry.0 - LOGIN_MAX_FAILURES).min(5);
            let duration = (LOGIN_BASE_LOCK_SECS * 2u64.pow(exponent)).min(LOGIN_MAX_LOCK_SECS);
            let mut lockouts = self.lockouts.lock().unwrap();
            lockouts.insert(ip.to_string(), now + duration);
        }
    }

    pub fn record_success(&self, ip: &str) {
        self.failures.lock().unwrap().remove(ip);
        self.lockouts.lock().unwrap().remove(ip);
    }

    fn persist_logins(&self) {
        let logins = self.logins.lock().unwrap();
        let list: Vec<StoredSession> = logins
            .iter()
            .map(|(t, exp)| StoredSession {
                token: t.clone(),
                expires_at: *exp,
            })
            .collect();
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = fs::write(self.logins_path(), json);
        }
    }
}

fn hash_password(password: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(password.as_bytes());
    let result = hasher.finalize();
    format!("{result:x}")
}

fn tokens_match(expected: &str, candidate: &str) -> bool {
    if expected.len() != candidate.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.bytes().zip(candidate.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}
