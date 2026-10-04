pub mod client;
pub mod commands;
pub mod config;
pub mod formatters;
pub mod stream_throttle;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use teloxide::net::Download;
use teloxide::prelude::*;
use teloxide::types::{
    CallbackQuery, ChatAction, ChatId, InlineKeyboardButton, InlineKeyboardMarkup, InputFile,
    KeyboardButton, KeyboardMarkup, MessageId, ParseMode,
};
use tokio::sync::Mutex;

use base64::Engine;
use client::PrimeAgentClient;
use commands::Command;
pub use config::BotConfig;
use formatters::{
    escape_html, format_detailed_error, format_message_for_chat, format_model_identifier,
    format_session_item_label, markdown_to_telegram_html, split_message,
};

pub struct BotState {
    pub client: Arc<PrimeAgentClient>,
    pub config: BotConfig,
    pub user_sessions: Arc<Mutex<HashMap<i64, String>>>,
    pub pinned_messages: Arc<Mutex<HashMap<i64, (ChatId, MessageId)>>>,
    pub active_trackers: Arc<Mutex<HashMap<i64, tokio::task::JoinHandle<()>>>>,
    pub allowed_users: Vec<i64>,
    pub dir_cache: Arc<Mutex<HashMap<String, String>>>,
    pub dir_counter: Arc<Mutex<u64>>,
    pub model_cache: Arc<Mutex<HashMap<String, (String, String)>>>,
    pub model_counter: Arc<Mutex<u64>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct InflightTurn {
    #[serde(rename = "chatId")]
    pub chat_id: i64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "promptText")]
    pub prompt_text: String,
    pub timestamp: u64,
}

impl BotState {
    pub async fn store_dir_key(&self, path: &str) -> String {
        let mut cache = self.dir_cache.lock().await;
        for (k, v) in cache.iter() {
            if v == path {
                return k.clone();
            }
        }
        let mut counter = self.dir_counter.lock().await;
        *counter += 1;
        let key = format!("d_{}", *counter);
        cache.insert(key.clone(), path.to_string());
        key
    }

    pub async fn get_dir_key(&self, key: &str) -> Option<String> {
        let cache = self.dir_cache.lock().await;
        cache.get(key).cloned()
    }

    pub async fn store_model_key(&self, provider: &str, model_id: &str) -> String {
        let mut cache = self.model_cache.lock().await;
        for (k, (p, m)) in cache.iter() {
            if p == provider && m == model_id {
                return k.clone();
            }
        }
        let mut counter = self.model_counter.lock().await;
        *counter += 1;
        let key = format!("m_{}", *counter);
        cache.insert(key.clone(), (provider.to_string(), model_id.to_string()));
        key
    }

    pub async fn get_model_key(&self, key: &str) -> Option<(String, String)> {
        let cache = self.model_cache.lock().await;
        cache.get(key).cloned()
    }

    pub async fn get_or_create_user_session(&self, user_id: i64) -> String {
        let mut sessions = self.user_sessions.lock().await;
        if let Some(sid) = sessions.get(&user_id) {
            return sid.clone();
        }

        // Try to pick the first live session from the daemon
        if let Ok(resp) = self.client.list_sessions().await {
            let list = resp.get("data").or_else(|| resp.get("sessions")).and_then(|v| v.as_array());
            if let Some(arr) = list {
                let live_match = arr.iter().find(|s| s.get("isSessionActive") == Some(&serde_json::json!(true)) || s.get("workerPid").is_some());
                let target = live_match.or_else(|| arr.first());
                if let Some(target_session) = target {
                    let sid = target_session.get("activeSessionId")
                        .or_else(|| target_session.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if !sid.is_empty() {
                        sessions.insert(user_id, sid.to_string());
                        save_user_sessions_to_disk(&sessions);
                        return sid.to_string();
                    }
                }
            }
        }

        // Fallback: create a new session
        if let Ok(resp) = self.client.create_session(None).await {
            let data = resp.get("data").unwrap_or(&resp);
            let sid = data.get("activeSessionId")
                .or_else(|| data.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("default");
            sessions.insert(user_id, sid.to_string());
            save_user_sessions_to_disk(&sessions);
            return sid.to_string();
        }

        "default".to_string()
    }

    pub async fn set_user_session(&self, user_id: i64, session_id: &str) {
        let mut sessions = self.user_sessions.lock().await;
        sessions.insert(user_id, session_id.to_string());
        save_user_sessions_to_disk(&sessions);
    }
}

fn get_inflight_journal_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".prime").join("agent").join("prime-agent-telegram").join("inflight-journal.json")
}

fn record_inflight_turn(chat_id: i64, session_id: &str, prompt_text: &str) {
    let path = get_inflight_journal_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let turn = InflightTurn {
        chat_id,
        session_id: session_id.to_string(),
        prompt_text: prompt_text.to_string(),
        timestamp: now,
    };
    if let Ok(serialized) = serde_json::to_string_pretty(&turn) {
        let _ = fs::write(&path, serialized);
    }
}

fn clear_inflight_turn() {
    let path = get_inflight_journal_path();
    let _ = fs::remove_file(path);
}

fn read_inflight_turn() -> Option<InflightTurn> {
    let path = get_inflight_journal_path();
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn get_user_sessions_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".prime").join("agent").join("user-sessions.json")
}

fn load_user_sessions_from_disk() -> HashMap<i64, String> {
    let path = get_user_sessions_path();
    let mut map = HashMap::new();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(data) = serde_json::from_str::<HashMap<String, String>>(&content) {
            for (k, v) in data {
                if let Ok(uid) = k.parse::<i64>() {
                    map.insert(uid, v);
                }
            }
        }
    }
    map
}

fn save_user_sessions_to_disk(map: &HashMap<i64, String>) {
    let path = get_user_sessions_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let string_map: HashMap<String, &String> = map.iter().map(|(k, v)| (k.to_string(), v)).collect();
    if let Ok(serialized) = serde_json::to_string_pretty(&string_map) {
        let _ = fs::write(&path, serialized);
    }
}

pub fn build_main_reply_keyboard() -> KeyboardMarkup {
    KeyboardMarkup::new(vec![
        vec![KeyboardButton::new("📊 Status"), KeyboardButton::new("📋 Sessions")],
        vec![KeyboardButton::new("➕ New Session"), KeyboardButton::new("⚙️ Menu")],
    ])
    .resize_keyboard()
    .persistent()
}

pub fn build_full_menu() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(vec![
        vec![
            InlineKeyboardButton::callback("📜 History", "menu_action:history"),
            InlineKeyboardButton::callback("🤖 Model", "menu_action:model"),
            InlineKeyboardButton::callback("💭 Thinking", "menu_action:thinking"),
        ],
        vec![
            InlineKeyboardButton::callback("📂 Files (/ls)", "menu_action:ls"),
            InlineKeyboardButton::callback("🔍 Git Diff", "menu_action:diff"),
            InlineKeyboardButton::callback("📡 Pantau Sesi", "menu_action:track"),
        ],
        vec![
            InlineKeyboardButton::callback("🤖 Subagents", "menu_action:subagents"),
            InlineKeyboardButton::callback("💻 Shell (/sh)", "menu_action:sh"),
            InlineKeyboardButton::callback("📄 Export", "menu_action:export"),
        ],
        vec![
            InlineKeyboardButton::callback("❓ Side Question", "menu_action:side"),
            InlineKeyboardButton::callback("🧹 Compact", "menu:compact"),
            InlineKeyboardButton::callback("🛑 Abort Sesi", "menu_action:abort"),
        ],
    ])
}

pub async fn build_new_session_menu(state: &BotState) -> (String, InlineKeyboardMarkup) {
    let mut unique_dirs: Vec<String> = Vec::new();
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    unique_dirs.push(cwd.clone());

    if let Ok(resp) = state.client.list_sessions().await {
        let sessions = resp.get("data").or_else(|| resp.get("sessions")).and_then(|v| v.as_array());
        if let Some(arr) = sessions {
            for s in arr {
                if let Some(dir) = s.get("cwd").and_then(|v| v.as_str()) {
                    if !unique_dirs.contains(&dir.to_string()) {
                        unique_dirs.push(dir.to_string());
                    }
                }
            }
        }
    }

    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    for dir in unique_dirs.iter().take(5) {
        let folder_name = Path::new(dir)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.clone());
        let key = state.store_dir_key(dir).await;
        rows.push(vec![InlineKeyboardButton::callback(
            format!("📂 {}", folder_name),
            format!("create_in:{}", key),
        )]);
    }

    let key_root = state.store_dir_key(&cwd).await;
    rows.push(vec![
        InlineKeyboardButton::callback("📁 Browse Folder Lain...", format!("browse_dir:{}:0:0", key_root)),
    ]);

    (
        "📂 <b>Buat Sesi Baru:</b>
Pilih folder kerja untuk sesi coding baru:".to_string(),
        InlineKeyboardMarkup::new(rows),
    )
}

pub async fn build_browse_dir_menu(
    state: &BotState,
    current_path: Option<&str>,
    page: usize,
    show_hidden: bool,
) -> (String, InlineKeyboardMarkup) {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let target_dir = current_path.unwrap_or(&home);

    let mut dirs: Vec<String> = Vec::new();
    if let Ok(resp) = state.client.browse_fs(Some(target_dir)).await {
        if let Some(entries) = resp.get("entries").and_then(|v| v.as_array()) {
            for e in entries {
                if let Some(p) = e.get("path").and_then(|v| v.as_str()) {
                    let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if !show_hidden && name.starts_with('.') {
                        continue;
                    }
                    dirs.push(p.to_string());
                }
            }
        }
    }

    let total = dirs.len();
    let per_page = 6;
    let total_pages = (total + per_page - 1) / per_page;
    let page = if total_pages == 0 { 0 } else { page.min(total_pages - 1) };
    let start = page * per_page;
    let end = (start + per_page).min(total);

    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    let target_key = state.store_dir_key(target_dir).await;

    rows.push(vec![InlineKeyboardButton::callback(
        "✅ Gunakan Folder Ini",
        format!("create_in:{}", target_key),
    )]);

    if let Some(parent) = Path::new(target_dir).parent() {
        if parent != Path::new("") {
            let parent_str = parent.to_string_lossy().to_string();
            let parent_key = state.store_dir_key(&parent_str).await;
            rows.push(vec![InlineKeyboardButton::callback(
                "⬆️ Naik Satu Folder",
                format!("browse_dir:{}:{}:0", parent_key, if show_hidden { 1 } else { 0 }),
            )]);
        }
    }

    for d in &dirs[start..end] {
        let name = Path::new(d)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| d.clone());
        let key = state.store_dir_key(d).await;
        rows.push(vec![InlineKeyboardButton::callback(
            format!("📁 {}", name),
            format!("browse_dir:{}:{}:0", key, if show_hidden { 1 } else { 0 }),
        )]);
    }

    let mut nav_row = Vec::new();
    if page > 0 {
        nav_row.push(InlineKeyboardButton::callback(
            "⬅️",
            format!("browse_page:{}:{}:{}", target_key, if show_hidden { 1 } else { 0 }, page - 1),
        ));
    }
    nav_row.push(InlineKeyboardButton::callback(
        if show_hidden { "🙈 Sembunyikan Hidden" } else { "👁️ Tampilkan Hidden" },
        format!("browse_toggle:{}:{}:{}", target_key, if show_hidden { 0 } else { 1 }, page),
    ));
    if page + 1 < total_pages {
        nav_row.push(InlineKeyboardButton::callback(
            "➡️",
            format!("browse_page:{}:{}:{}", target_key, if show_hidden { 1 } else { 0 }, page + 1),
        ));
    }
    if !nav_row.is_empty() {
        rows.push(nav_row);
    }

    let text = format!(
        "📁 <b>Jelajah Direktori:</b>
<code>{}</code>

<i>Halaman {}/{} ({} folder)</i>",
        escape_html(target_dir),
        if total_pages == 0 { 1 } else { page + 1 },
        total_pages.max(1),
        total
    );

    (text, InlineKeyboardMarkup::new(rows))
}

pub fn build_sessions_menu(
    sessions: &[serde_json::Value],
    page: usize,
    current_id: Option<&str>,
) -> (String, InlineKeyboardMarkup) {
    let per_page = 6;
    let total = sessions.len();
    let total_pages = (total + per_page - 1) / per_page;
    let page = if total_pages == 0 { 0 } else { page.min(total_pages - 1) };
    let start = page * per_page;
    let end = (start + per_page).min(total);

    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();

    for (i, s) in sessions[start..end].iter().enumerate() {
        let is_current = current_id.map_or(false, |cid| {
            s.get("id").or_else(|| s.get("activeSessionId")).or_else(|| s.get("sessionId")).and_then(|v| v.as_str()) == Some(cid)
        });
        let label = format_session_item_label(s, start + i, is_current);
        let id = s.get("activeSessionId").or_else(|| s.get("id")).and_then(|v| v.as_str()).unwrap_or("?");
        rows.push(vec![InlineKeyboardButton::callback(label, format!("switch:{}", id))]);
    }

    let mut nav_row = Vec::new();
    if page > 0 {
        nav_row.push(InlineKeyboardButton::callback("⬅️ Prev", format!("sessions_page:{}", page - 1)));
    }
    if page + 1 < total_pages {
        nav_row.push(InlineKeyboardButton::callback("Next ➡️", format!("sessions_page:{}", page + 1)));
    }
    if !nav_row.is_empty() {
        rows.push(nav_row);
    }

    let header = format!(
        "📋 <b>Active & Saved Sessions</b> (Halaman {}/{})
Total Sessions: <b>{}</b>

Klik sesi di bawah untuk beralih dan memantau sesi tersebut:",
        if total_pages == 0 { 1 } else { page + 1 },
        total_pages.max(1),
        total
    );

    (header, InlineKeyboardMarkup::new(rows))
}

pub async fn build_provider_menu(state: &BotState, session_id: &str) -> (String, InlineKeyboardMarkup) {
    let mut providers: Vec<String> = Vec::new();
    let mut model_counts: HashMap<String, usize> = HashMap::new();
    let mut current_model = "default".to_string();

    if let Ok(resp) = state.client.get_models(Some(session_id)).await {
        if let Some(models) = resp.get("data").or_else(|| resp.get("models")).and_then(|v| v.as_array()) {
            for m in models {
                let prov = m.get("provider").and_then(|v| v.as_str()).unwrap_or("default").to_string();
                if !providers.contains(&prov) {
                    providers.push(prov.clone());
                }
                *model_counts.entry(prov).or_insert(0) += 1;
            }
        }
    }
    providers.sort();

    if let Ok(resp) = state.client.get_state(Some(session_id)).await {
        let data = resp.get("data").unwrap_or(&resp);
        current_model = format_model_identifier(data.get("state").and_then(|s| s.get("model")));
    }

    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    for p in &providers {
        let count = model_counts.get(p).copied().unwrap_or(0);
        rows.push(vec![InlineKeyboardButton::callback(
            format!("👉 {} ({} models)", p, count),
            format!("model_prov:{}:0", p),
        )]);
    }

    let header = format!(
        "🤖 <b>Pilih Model Provider:</b>
Model saat ini: <b>{}</b>

Pilih salah satu provider untuk melihat daftar model:",
        escape_html(&current_model)
    );

    (header, InlineKeyboardMarkup::new(rows))
}

pub async fn build_model_list_menu(
    state: &BotState,
    session_id: &str,
    provider: &str,
    page: usize,
) -> (String, InlineKeyboardMarkup) {
    let mut provider_models: Vec<serde_json::Value> = Vec::new();
    let mut current_model_id = String::new();

    if let Ok(resp) = state.client.get_models(Some(session_id)).await {
        if let Some(models) = resp.get("data").or_else(|| resp.get("models")).and_then(|v| v.as_array()) {
            for m in models {
                if m.get("provider").and_then(|v| v.as_str()) == Some(provider) {
                    provider_models.push(m.clone());
                }
            }
        }
    }

    if let Ok(resp) = state.client.get_state(Some(session_id)).await {
        let data = resp.get("data").unwrap_or(&resp);
        if let Some(m) = data.get("state").and_then(|s| s.get("model")) {
            current_model_id = m.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        }
    }

    let per_page = 8;
    let total = provider_models.len();
    let total_pages = (total + per_page - 1) / per_page;
    let page = if total_pages == 0 { 0 } else { page.min(total_pages - 1) };
    let start = page * per_page;
    let end = (start + per_page).min(total);

    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();

    for m in &provider_models[start..end] {
        let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
        let is_current = id == current_model_id;
        let marker = if is_current { "🟢 " } else { "" };
        let key = state.store_model_key(provider, id).await;
        rows.push(vec![InlineKeyboardButton::callback(
            format!("{}{}", marker, name),
            format!("set_model:{}", key),
        )]);
    }

    let mut nav_row = Vec::new();
    if page > 0 {
        nav_row.push(InlineKeyboardButton::callback("⬅️ Prev", format!("model_prov:{}:{}", provider, page - 1)));
    }
    if page + 1 < total_pages {
        nav_row.push(InlineKeyboardButton::callback("Next ➡️", format!("model_prov:{}:{}", provider, page + 1)));
    }
    if !nav_row.is_empty() {
        rows.push(nav_row);
    }
    rows.push(vec![InlineKeyboardButton::callback("🔙 Kembali ke Provider", "model_providers")]);

    let header = format!(
        "🤖 <b>Pilih Model ({})</b> - Halaman {}/{}
Total: <b>{} models</b>

Klik model yang ingin digunakan untuk sesi ini:",
        escape_html(provider),
        if total_pages == 0 { 1 } else { page + 1 },
        total_pages.max(1),
        total
    );

    (header, InlineKeyboardMarkup::new(rows))
}

pub fn is_authorized(state: &BotState, user_id: i64) -> bool {
    if state.allowed_users.is_empty() {
        return true;
    }
    state.allowed_users.contains(&user_id)
}

pub async fn run_bot(config: BotConfig) -> anyhow::Result<()> {
    let client = PrimeAgentClient::new(
        config.daemon_socket.clone(),
        config.api_url.clone(),
        config.api_token.clone(),
    );

    let saved_sessions = load_user_sessions_from_disk();
    let state = Arc::new(BotState {
        client: Arc::new(client),
        config: config.clone(),
        user_sessions: Arc::new(Mutex::new(saved_sessions)),
        pinned_messages: Arc::new(Mutex::new(HashMap::new())),
        active_trackers: Arc::new(Mutex::new(HashMap::new())),
        allowed_users: config.allowed_user_ids,
        dir_cache: Arc::new(Mutex::new(HashMap::new())),
        dir_counter: Arc::new(Mutex::new(0)),
        model_cache: Arc::new(Mutex::new(HashMap::new())),
        model_counter: Arc::new(Mutex::new(0)),
    });

    let bot = Bot::new(config.bot_token);

    // Save bot info to gateway.json if possible
    if let Ok(me) = bot.get_me().await {
        let username = me.username();
        println!("✨ Prime Agent Telegram bot is live as @{}!", username);
        let info_path = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
            .join(".prime").join("agent").join("prime-agent-telegram").join("gateway.json");
        if let Ok(content) = fs::read_to_string(&info_path) {
            if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("botUsername".to_string(), serde_json::Value::String(username.to_string()));
                    obj.insert("botId".to_string(), serde_json::json!(me.id.0));
                }
                let _ = fs::write(&info_path, serde_json::to_string_pretty(&val).unwrap_or_default());
            }
        }
    }

    // Run startup recovery
    run_startup_recovery(bot.clone(), state.clone()).await;

    let handler = dptree::entry()
        .branch(
            Update::filter_message()
                .filter_command::<Command>()
                .endpoint(handle_command),
        )
        .branch(
            Update::filter_callback_query()
                .endpoint(handle_callback),
        )
        // Media & Text branches
        .branch(
            Update::filter_message()
                .filter(|msg: Message| msg.photo().is_some())
                .endpoint(handle_photo),
        )
        .branch(
            Update::filter_message()
                .filter(|msg: Message| msg.document().is_some())
                .endpoint(handle_document),
        )
        .branch(
            Update::filter_message()
                .filter(|msg: Message| msg.voice().is_some())
                .endpoint(handle_voice),
        )
        .branch(
            Update::filter_message()
                .filter(|msg: Message| msg.text().is_some())
                .endpoint(handle_message),
        );

    Dispatcher::builder(bot, handler)
        .dependencies(dptree::deps![state])
        .enable_ctrlc_handler()
        .build()
        .dispatch()
        .await;

    Ok(())
}

async fn run_startup_recovery(bot: Bot, state: Arc<BotState>) {
    if let Some(turn) = read_inflight_turn() {
        println!("[STARTUP RECOVERY] Found uncompleted turn for session {}, checking status...", turn.session_id);
        let chat_id = ChatId(turn.chat_id);
        let sid = turn.session_id.clone();

        tokio::spawn(async move {
            let mut busy = false;
            if let Ok(resp) = state.client.list_sessions().await {
                if let Some(arr) = resp.get("data").or_else(|| resp.get("sessions")).and_then(|v| v.as_array()) {
                    if let Some(s) = arr.iter().find(|x| x.get("id").or_else(|| x.get("activeSessionId")).and_then(|v| v.as_str()) == Some(&sid)) {
                        busy = s.get("isSessionActive") == Some(&serde_json::json!(true)) || s.get("activity") == Some(&serde_json::json!("working"));
                    }
                }
            }

            if busy {
                println!("[STARTUP RECOVERY] Session {} is still working, tracking till completion...", sid);
                start_tracking_session(bot, state, chat_id, &sid).await;
            } else {
                clear_inflight_turn();
            }
        });
    }
}

async fn update_pinned_status(bot: &Bot, state: &BotState, user_id: i64) {
    let pin_opt = {
        let pins = state.pinned_messages.lock().await;
        pins.get(&user_id).cloned()
    };
    let Some((chat_id, msg_id)) = pin_opt else {
        return;
    };

    let sid = state.get_or_create_user_session(user_id).await;
    if let Ok(resp) = state.client.get_state(Some(&sid)).await {
        let data = resp.get("data").unwrap_or(&resp);
        let active_sid = data.get("activeSessionId").and_then(|v| v.as_str()).unwrap_or(&sid);
        let model = data.get("state").and_then(|s| s.get("model")).and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap_or("default");
        let thinking = data.get("state").and_then(|s| s.get("thinkingLevel")).and_then(|v| v.as_str()).unwrap_or("off");
        let mut lines = vec![
            "📌 <b>Prime Agent Live Status</b>".to_string(),
            "".to_string(),
            format!("🆔 <b>Session:</b> <code>{}</code>", escape_html(&active_sid.chars().take(8).collect::<String>())),
            format!("📂 <b>Directory:</b> <code>{}</code>", escape_html(data.get("state").and_then(|s| s.get("cwd")).and_then(|v| v.as_str()).unwrap_or("default"))),
            format!("🤖 <b>Model:</b> <code>{}</code>", escape_html(model)),
            format!("💭 <b>Thinking:</b> <code>{}</code>", escape_html(thinking)),
        ];

        if let Some(u) = data.get("state").and_then(|s| s.get("usage")) {
            let in_tok = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let out_tok = u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            lines.push(format!("📈 <b>Tokens:</b> In: {} | Out: {}", in_tok, out_tok));
            if let Some(cost) = u.get("cost").and_then(|v| v.as_f64()) {
                lines.push(format!("💰 <b>Cost:</b> ${:.4}", cost));
            }
        }
        lines.push(format!("⏱️ <i>Updated: {}</i>", chrono_time_str()));
        let text = lines.join("
");
        let _ = bot.edit_message_text(chat_id, msg_id, text).parse_mode(ParseMode::Html).await;
    }
}

fn chrono_time_str() -> String {
    let now = std::time::SystemTime::now();
    let dur = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() % 86400;
    let hours = (secs / 3600 + 7) % 24; // WIB offset
    let mins = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", hours, mins, s)
}

pub async fn start_tracking_session(
    bot: Bot,
    state: Arc<BotState>,
    chat_id: ChatId,
    session_id: &str,
) -> bool {
    {
        let mut trackers = state.active_trackers.lock().await;
        if let Some(handle) = trackers.remove(&chat_id.0) {
            handle.abort();
        }
    }

    let mut is_working = false;
    if let Ok(resp) = state.client.list_sessions().await {
        if let Some(arr) = resp.get("data").or_else(|| resp.get("sessions")).and_then(|v| v.as_array()) {
            if let Some(s) = arr.iter().find(|x| x.get("id").or_else(|| x.get("activeSessionId")).and_then(|v| v.as_str()) == Some(session_id)) {
                is_working = s.get("isSessionActive") == Some(&serde_json::json!(true))
                    || s.get("activity") == Some(&serde_json::json!("working"))
                    || s.get("isStreaming") == Some(&serde_json::json!(true))
                    || s.get("isRunningTools") == Some(&serde_json::json!(true));
            }
        }
    }

    if !is_working {
        return false;
    }

    let bot_for_typing = bot.clone();
    let typing_handle = tokio::spawn(async move {
        loop {
            let _ = bot_for_typing.send_chat_action(chat_id, ChatAction::Typing).await;
            tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;
        }
    });

    let bot_clone = bot.clone();
    let state_clone = Arc::clone(&state);
    let sid = session_id.to_string();

    let tracker_handle = tokio::spawn(async move {
        let mut current_text = String::new();
        let start_time = std::time::Instant::now();

        if let Ok(mut rx) = state_clone.client.subscribe_events(&sid).await {
            while let Some(msg) = rx.recv().await {
                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let event = msg.get("event");
                let inner_type = event.and_then(|e| e.get("type")).and_then(|v| v.as_str()).unwrap_or("");

                if msg_type == "session_event" {
                    if inner_type == "message_update" {
                        if let Some(delta) = event.and_then(|e| e.get("assistantMessageEvent")).and_then(|a| a.get("delta")).and_then(|v| v.as_str()) {
                            current_text.push_str(delta);
                        }
                    } else if inner_type == "agent_end" {
                        break;
                    }
                }
            }
        }

        typing_handle.abort();

        // Deliver answer
        let mut deliver_text = current_text.trim().to_string();
        if deliver_text.is_empty() {
            if let Ok(st) = state_clone.client.get_state(Some(&sid)).await {
                let data = st.get("data").unwrap_or(&st);
                if let Some(msgs) = data.get("messages").and_then(|v| v.as_array()) {
                    for m in msgs.iter().rev() {
                        let role = m.get("role").or_else(|| m.get("message").and_then(|sub| sub.get("role"))).and_then(|v| v.as_str());
                        if role == Some("assistant") {
                            let c = m.get("content").or_else(|| m.get("message").and_then(|sub| sub.get("content")));
                            if let Some(text) = c.and_then(|v| v.as_str()) {
                                deliver_text = text.to_string();
                                break;
                            }
                        }
                    }
                }
                if deliver_text.is_empty() {
                    let tools = (data.get("messages").and_then(|v| v.as_array()))
                        .map(|arr| arr.iter().filter(|m| m.get("type") == Some(&serde_json::json!("toolCall"))).count())
                        .unwrap_or(0);
                    if tools > 0 {
                        deliver_text = "⚙️ <i>Aksi tool selesai diproses di latar belakang.</i>".to_string();
                    }
                }
            }
        }

        if !deliver_text.is_empty() {
            let elapsed = start_time.elapsed().as_secs().max(1);
            let footer = format!("

`⏱️ {}s`", elapsed);
            let final_reply = format!("{}{}", deliver_text, footer);
            let html = markdown_to_telegram_html(&final_reply);
            for chunk in split_message(&html, 3800) {
                let _ = bot_clone.send_message(chat_id, chunk).parse_mode(ParseMode::Html).reply_markup(build_main_reply_keyboard()).await;
            }
        }

        let mut trackers = state_clone.active_trackers.lock().await;
        trackers.remove(&chat_id.0);
    });

    let mut trackers = state.active_trackers.lock().await;
    trackers.insert(chat_id.0, tracker_handle);

    true
}

async fn run_prompt_and_stream(
    bot: Bot,
    state: Arc<BotState>,
    chat_id: ChatId,
    user_id: i64,
    session_id: String,
    prompt_text: String,
    images: Option<serde_json::Value>,
) {
    let bot_for_typing = bot.clone();
    let typing_handle = tokio::spawn(async move {
        loop {
            let _ = bot_for_typing.send_chat_action(chat_id, ChatAction::Typing).await;
            tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;
        }
    });

    record_inflight_turn(chat_id.0, &session_id, &prompt_text);

    let start_time = std::time::Instant::now();
    let rx = match state.client.subscribe_events(&session_id).await {
        Ok(receiver) => Some(receiver),
        Err(e) => {
            println!("Warning: SSE subscription failed ({e}), using direct prompt fallback");
            None
        }
    };

    // Send the prompt
    let prompt_res = state.client.prompt_with_images(&session_id, &prompt_text, images).await;
    if let Err(e) = prompt_res {
        typing_handle.abort();
        clear_inflight_turn();
        let err_str = e.to_string();
        let formatted = format_detailed_error(&err_str, Some("error"));
        let _ = bot.send_message(chat_id, formatted).parse_mode(ParseMode::Html).await;
        return;
    }

    let mut current_output_text = String::new();
    let mut active_subagents_count = 0;

    if let Some(mut stream_rx) = rx {
        while let Some(msg) = stream_rx.recv().await {
            let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let event = msg.get("event");
            let inner_type = event.and_then(|e| e.get("type")).and_then(|v| v.as_str()).unwrap_or("");

            if msg_type == "session_event" {
                if inner_type == "message_update" {
                    if let Some(delta) = event.and_then(|e| e.get("assistantMessageEvent")).and_then(|a| a.get("delta")).and_then(|v| v.as_str()) {
                        current_output_text.push_str(delta);
                    }
                } else if inner_type == "auto_retry_start" {
                    let attempt = event.and_then(|e| e.get("attempt")).and_then(|v| v.as_u64()).unwrap_or(1);
                    let max = event.and_then(|e| e.get("maxAttempts")).and_then(|v| v.as_u64()).unwrap_or(3);
                    let msg_text = format!("🔄 <i>Model gagal, mencoba ulang ({attempt}/{max})...</i>");
                    let _ = bot.send_message(chat_id, msg_text).parse_mode(ParseMode::Html).await;
                } else if inner_type == "rlm_child_update" {
                    active_subagents_count += 1;
                } else if inner_type == "auth_stale" {
                    let _ = bot.send_message(chat_id, "🔑 <b>Peringatan:</b> Token autentikasi kadaluarsa.").parse_mode(ParseMode::Html).await;
                } else if inner_type == "extension_ui_request" {
                    if let Some(req_id) = event.and_then(|e| e.get("id")).and_then(|v| v.as_str()) {
                        let prompt_msg = event.and_then(|e| e.get("message")).and_then(|v| v.as_str()).unwrap_or("Apakah Anda menyetujui aksi ini?");
                        let kb = InlineKeyboardMarkup::new(vec![
                            vec![
                                InlineKeyboardButton::callback("✅ Allow", format!("dialog:{}:allow", req_id)),
                                InlineKeyboardButton::callback("❌ Deny", format!("dialog:{}:deny", req_id)),
                            ]
                        ]);
                        let _ = bot.send_message(chat_id, format!("⚠️ <b>Izin Diperlukan:</b>
{}", escape_html(prompt_msg))).reply_markup(kb).parse_mode(ParseMode::Html).await;
                    }
                } else if inner_type == "agent_end" {
                    break;
                }
            }
        }
    }

    typing_handle.abort();
    clear_inflight_turn();

    let elapsed = start_time.elapsed().as_secs().max(1);
    let subagent_badge = if active_subagents_count > 0 {
        format!(" | 🤖 {} subagent{}", active_subagents_count, if active_subagents_count > 1 { "s" } else { "" })
    } else {
        String::new()
    };
    let footer = format!("

`⏱️ {}s{}`", elapsed, subagent_badge);

    if current_output_text.trim().is_empty() {
        if let Ok(st) = state.client.get_state(Some(&session_id)).await {
            let data = st.get("data").unwrap_or(&st);
            if let Some(msgs) = data.get("messages").and_then(|v| v.as_array()) {
                for m in msgs.iter().rev() {
                    let role = m.get("role").or_else(|| m.get("message").and_then(|sub| sub.get("role"))).and_then(|v| v.as_str());
                    if role == Some("assistant") {
                        let c = m.get("content").or_else(|| m.get("message").and_then(|sub| sub.get("content")));
                        if let Some(text) = c.and_then(|v| v.as_str()) {
                            current_output_text = text.to_string();
                            break;
                        }
                    }
                }
            }
        }
    }

    let reply_body = if !current_output_text.trim().is_empty() {
        current_output_text
    } else {
        "✓ (Tugas selesai diproses)".to_string()
    };

    let final_reply = format!("{}{}", reply_body, footer);
    let html = markdown_to_telegram_html(&final_reply);
    for chunk in split_message(&html, 3800) {
        let _ = bot.send_message(chat_id, chunk)
            .reply_markup(build_main_reply_keyboard())
            .parse_mode(ParseMode::Html)
            .await;
    }

    update_pinned_status(&bot, &state, user_id).await;
}

async fn handle_callback(
    bot: Bot,
    q: CallbackQuery,
    state: Arc<BotState>,
) -> ResponseResult<()> {
    let user_id = q.from.id.0 as i64;
    if !is_authorized(&state, user_id) {
        bot.answer_callback_query(q.id).text("⛔ Unauthorized").await?;
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).await?;

    let Some(data) = q.data else {
        return Ok(());
    };

    let chat_id = match q.message {
        Some(ref msg) => msg.chat().id,
        None => return Ok(()),
    };

    if data == "noop" {
        return Ok(());
    }

    let sid = state.get_or_create_user_session(user_id).await;

    if data.starts_with("dialog:") {
        let parts: Vec<&str> = data.split(':').collect();
        if parts.len() >= 3 {
            let req_id = parts[1];
            let action = parts[2];
            let confirmed = action == "allow";
            let _ = state.client.respond_dialog(&sid, req_id, confirmed).await;
            bot.send_message(chat_id, format!("✅ Respons dialog dicatat: <b>{}</b>", action)).parse_mode(ParseMode::Html).await?;
        }
    } else if let Some(target_id) = data.strip_prefix("track_session:") {
        let ok = start_tracking_session(bot.clone(), Arc::clone(&state), chat_id, target_id).await;
        if ok {
            bot.send_message(chat_id, format!("📡 <b>Memantau Sesi</b> <code>{}</code>

<i>Responnya akan langsung dikirimkan ke sini begitu selesai...</i>", escape_html(&target_id.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
        } else {
            bot.send_message(chat_id, "⚠️ Sesi tidak sedang memproses tugas di latar belakang.").await?;
        }
    } else if data.starts_with("model_providers") {
        let (text, kb) = build_provider_menu(&state, &sid).await;
        bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
    } else if let Some(rest) = data.strip_prefix("model_prov:") {
        let parts: Vec<&str> = rest.split(':').collect();
        let prov = parts.get(0).copied().unwrap_or("default");
        let page: usize = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        let (text, kb) = build_model_list_menu(&state, &sid, prov, page).await;
        bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
    } else if let Some(key) = data.strip_prefix("set_model:") {
        if let Some((prov, model_id)) = state.get_model_key(key).await {
            let _ = state.client.set_model(&sid, &prov, &model_id).await;
            bot.send_message(chat_id, format!("✅ Model berhasil diubah ke: <code>{}</code>", escape_html(&model_id))).parse_mode(ParseMode::Html).await?;
            update_pinned_status(&bot, &state, user_id).await;
        }
    } else if let Some(level) = data.strip_prefix("think:") {
        let _ = state.client.set_thinking(&sid, level).await;
        bot.send_message(chat_id, format!("💭 Level thinking diubah ke: <b>{}</b>", escape_html(level))).parse_mode(ParseMode::Html).await?;
        update_pinned_status(&bot, &state, user_id).await;
    } else if let Some(page_str) = data.strip_prefix("sessions_page:") {
        let page: usize = page_str.parse().unwrap_or(0);
        if let Ok(resp) = state.client.list_sessions().await {
            let sessions = resp.get("data").or_else(|| resp.get("sessions")).and_then(|v| v.as_array());
            if let Some(arr) = sessions {
                let current_id = state.get_or_create_user_session(user_id).await;
                let (text, kb) = build_sessions_menu(arr, page, Some(&current_id));
                bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
            }
        }
    } else if let Some(target_id) = data.strip_prefix("switch:") {
        state.set_user_session(user_id, target_id).await;
        if let Ok(resp) = state.client.open_session(Some(serde_json::json!({ "activeSessionId": target_id }))).await {
            let data = resp.get("data").unwrap_or(&resp);
            let cwd = data.get("state").and_then(|s| s.get("cwd")).and_then(|v| v.as_str()).unwrap_or("default");
            let model = data.get("state").and_then(|s| s.get("model")).and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap_or("default");

            // Check if working in background
            let mut is_working = false;
            if let Ok(l_resp) = state.client.list_sessions().await {
                if let Some(arr) = l_resp.get("data").or_else(|| l_resp.get("sessions")).and_then(|v| v.as_array()) {
                    if let Some(s) = arr.iter().find(|x| x.get("id").or_else(|| x.get("activeSessionId")).and_then(|v| v.as_str()) == Some(target_id)) {
                        is_working = s.get("isSessionActive") == Some(&serde_json::json!(true))
                            || s.get("activity") == Some(&serde_json::json!("working"))
                            || s.get("isStreaming") == Some(&serde_json::json!(true))
                            || s.get("isRunningTools") == Some(&serde_json::json!(true));
                    }
                }
            }

            let lines = vec![
                format!("✅ <b>Sesi Aktif Dialihkan!</b>"),
                "".to_string(),
                format!("🆔 <b>Session:</b> <code>{}</code>", escape_html(&target_id.chars().take(8).collect::<String>())),
                format!("📂 <b>Directory:</b> <code>{}</code>", escape_html(cwd)),
                format!("🤖 <b>Model:</b> <code>{}</code>", escape_html(model)),
            ];

            let mut buttons = Vec::new();
            if is_working {
                buttons.push(vec![InlineKeyboardButton::callback("📡 Pantau Sesi Ini", format!("track_session:{}", target_id))]);
            }
            buttons.push(vec![
                InlineKeyboardButton::callback("🏷️ Rename Sesi", format!("session_action:rename:{}", target_id)),
                InlineKeyboardButton::callback("🗑️ Hapus Sesi", format!("session_action:delete:{}", target_id)),
            ]);

            bot.send_message(chat_id, lines.join("
")).reply_markup(InlineKeyboardMarkup::new(buttons)).parse_mode(ParseMode::Html).await?;

            // Render last 2 messages as context preview
            if let Some(msgs) = data.get("messages").and_then(|v| v.as_array()) {
                let recent: Vec<_> = msgs.iter().rev().take(2).collect();
                let mut chat_msgs = Vec::new();
                for m in recent.into_iter().rev() {
                    if let Some(formatted) = format_message_for_chat(m) {
                        chat_msgs.push(formatted);
                    }
                }
                if !chat_msgs.is_empty() {
                    let preview = format!("📜 <b>Konteks Terakhir ({}):</b>

{}", escape_html(&target_id.chars().take(8).collect::<String>()), chat_msgs.join("

───────────────

"));
                    for chunk in split_message(&preview, 3800) {
                        bot.send_message(chat_id, chunk).parse_mode(ParseMode::Html).await?;
                    }
                }
            }
        }
    } else if let Some(target_id) = data.strip_prefix("session_action:rename:") {
        bot.send_message(chat_id, format!("Untuk mengubah nama sesi <code>{}</code>, ketik:
<code>/rename &lt;nama_baru&gt;</code>", escape_html(&target_id.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
    } else if let Some(target_id) = data.strip_prefix("session_action:delete:") {
        let _ = state.client.delete_session(target_id).await;
        bot.send_message(chat_id, format!("🗑️ <b>Sesi {} berhasil dihapus.</b>", escape_html(&target_id.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
    } else if let Some(path) = data.strip_prefix("cat:") {
        match state.client.read_workspace_file(&sid, path).await {
            Ok(resp) => {
                let content = resp.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let binary = resp.get("binary") == Some(&serde_json::json!(true));
                if binary || content.len() > 3000 {
                    let filename = Path::new(path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| "file.txt".to_string());
                    let file = InputFile::memory(content.as_bytes().to_vec()).file_name(filename);
                    let _ = bot.send_document(chat_id, file).await;
                } else {
                    bot.send_message(chat_id, format!("📄 <b>{}</b>:
<pre><code>{}</code></pre>", escape_html(path), escape_html(content))).parse_mode(ParseMode::Html).await?;
                }
            }
            Err(e) => {
                bot.send_message(chat_id, format!("❌ Gagal membaca file: {e}")).await?;
            }
        }
    } else if let Some(job_id) = data.strip_prefix("cron_cancel:") {
        let _ = state.client.cancel_cron_job(&sid, job_id).await;
        bot.send_message(chat_id, format!("✅ Scheduled task <code>{}</code> dibatalkan.", escape_html(job_id))).parse_mode(ParseMode::Html).await?;
    } else if let Some(sub_target) = data.strip_prefix("view_sub:") {
        let parts: Vec<&str> = sub_target.split(':').collect();
        if parts.len() >= 2 {
            let parent_sid = parts[0];
            let child_id = parts[1];
            if let Ok(resp) = state.client.get_subagent_messages(parent_sid, child_id).await {
                let msgs = resp.get("messages").and_then(|v| v.as_array());
                if let Some(arr) = msgs {
                    let mut chat_msgs = Vec::new();
                    for m in arr.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev() {
                        if let Some(formatted) = format_message_for_chat(m) {
                            chat_msgs.push(formatted);
                        }
                    }
                    if !chat_msgs.is_empty() {
                        let combined = chat_msgs.join("

──────────────

");
                        bot.send_message(chat_id, format!("🤖 <b>Transkrip Subagent (5 pesan terakhir):</b>

{}", combined)).parse_mode(ParseMode::Html).await?;
                    } else {
                        bot.send_message(chat_id, "📄 <i>Belum ada pesan tercatat di subagent ini.</i>").parse_mode(ParseMode::Html).await?;
                    }
                }
            }
        }
    } else if let Some(action) = data.strip_prefix("menu_action:") {
        match action {
            "history" => {
                if let Ok(resp) = state.client.get_state(Some(&sid)).await {
                    let data = resp.get("data").unwrap_or(&resp);
                    let messages = data.get("messages").and_then(|v| v.as_array());
                    if let Some(arr) = messages {
                        let recent: Vec<_> = arr.iter().rev().take(5).collect();
                        let mut chat_msgs = Vec::new();
                        for m in recent.into_iter().rev() {
                            if let Some(formatted) = format_message_for_chat(m) {
                                chat_msgs.push(formatted);
                            }
                        }
                        if !chat_msgs.is_empty() {
                            let combined = chat_msgs.join("

───────────────

");
                            for chunk in split_message(&combined, 3800) {
                                bot.send_message(chat_id, chunk).parse_mode(ParseMode::Html).await?;
                            }
                            return Ok(());
                        }
                    }
                }
                bot.send_message(chat_id, "📭 <i>Belum ada riwayat percakapan di sesi ini.</i>").parse_mode(ParseMode::Html).await?;
            }
            "model" => {
                let (text, kb) = build_provider_menu(&state, &sid).await;
                bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
            }
            "thinking" => {
                let kb = InlineKeyboardMarkup::new(vec![
                    vec![
                        InlineKeyboardButton::callback("Off", "think:off"),
                        InlineKeyboardButton::callback("Low", "think:low"),
                        InlineKeyboardButton::callback("Medium", "think:medium"),
                    ],
                    vec![
                        InlineKeyboardButton::callback("High", "think:high"),
                        InlineKeyboardButton::callback("Max", "think:max"),
                    ],
                ]);
                bot.send_message(chat_id, "💭 <b>Pilih Level Thinking:</b>").reply_markup(kb).parse_mode(ParseMode::Html).await?;
            }
            "ls" => {
                if let Ok(val) = state.client.list_workspace(&sid, "").await {
                    let entries = val.get("entries").and_then(|v| v.as_array());
                    let mut rows = Vec::new();
                    if let Some(arr) = entries {
                        for item in arr.iter().take(12) {
                            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let is_dir = item.get("type").and_then(|v| v.as_str()) == Some("dir");
                            let icon = if is_dir { "📁" } else { "📄" };
                            rows.push(vec![InlineKeyboardButton::callback(
                                format!("{icon} {name}"),
                                format!("ls:{name}"),
                            )]);
                        }
                    }
                    bot.send_message(chat_id, "📂 <b>Workspace Root:</b>").reply_markup(InlineKeyboardMarkup::new(rows)).parse_mode(ParseMode::Html).await?;
                }
            }
            "diff" => {
                if let Ok(resp) = state.client.git_diff(Some(&sid)).await {
                    let diff_text = resp.get("diff").and_then(|v| v.as_str()).unwrap_or("(tidak ada diff)");
                    let reply = format!("🔍 <b>Git Diff:</b>

<pre><code>{}</code></pre>", escape_html(diff_text));
                    bot.send_message(chat_id, reply).parse_mode(ParseMode::Html).await?;
                }
            }
            "track" => {
                let ok = start_tracking_session(bot.clone(), Arc::clone(&state), chat_id, &sid).await;
                if ok {
                    bot.send_message(chat_id, format!("📡 <b>Memantau Sesi</b> <code>{}</code>

<i>Bot akan memberi notifikasi dan mengirimkan balasan ke sini begitu tugas yang berjalan selesai...</i>", escape_html(&sid.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
                } else {
                    bot.send_message(chat_id, format!("⚠️ <b>Tidak Ada Tugas Aktif</b>

Sesi <code>{}</code> saat ini sedang menganggur (idle). Listener tracking hanya dapat diaktifkan jika sesi sedang memproses tugas di Web/CLI.", escape_html(&sid.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
                }
            }
            "subagents" => {
                if let Ok(resp) = state.client.get_state(Some(&sid)).await {
                    let data = resp.get("data").unwrap_or(&resp);
                    let children = data.get("children").and_then(|v| v.as_array());
                    if let Some(arr) = children {
                        if !arr.is_empty() {
                            let mut rows = Vec::new();
                            for c in arr {
                                let cid = c.get("id").or_else(|| c.get("childId")).and_then(|v| v.as_str()).unwrap_or("sub");
                                let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("subagent");
                                let status = c.get("status").and_then(|v| v.as_str()).unwrap_or("done");
                                let icon = if status == "running" { "⏳" } else { "✅" };
                                rows.push(vec![InlineKeyboardButton::callback(
                                    format!("{icon} {name} ({status})"),
                                    format!("view_sub:{}:{}", sid, cid),
                                )]);
                            }
                            bot.send_message(chat_id, format!("🤖 <b>Subagents ({})</b>:
Klik untuk melihat transkrip:", arr.len())).reply_markup(InlineKeyboardMarkup::new(rows)).parse_mode(ParseMode::Html).await?;
                            return Ok(());
                        }
                    }
                }
                bot.send_message(chat_id, "ℹ️ Tidak ada subagent di sesi ini.").parse_mode(ParseMode::Html).await?;
            }
            "sh" => {
                let usage = "💻 <b>Penggunaan Terminal Shell:</b>
Ketik <code>/sh &lt;perintah&gt;</code> atau <code>!&lt;perintah&gt;</code>

Contoh: <code>/sh git status</code>";
                bot.send_message(chat_id, usage).parse_mode(ParseMode::Html).await?;
            }
            "export" => {
                let _ = bot.send_chat_action(chat_id, ChatAction::UploadDocument).await;
                if let Ok(resp) = state.client.export_session(&sid).await {
                    let data = resp.get("data").unwrap_or(&resp);
                    if let Some(path_str) = data.get("path").and_then(|v| v.as_str()) {
                        let p = PathBuf::from(path_str);
                        if p.exists() {
                            let doc = InputFile::file(&p);
                            let _ = bot.send_document(chat_id, doc).caption("📄 Export transkrip sesi").await;
                            return Ok(());
                        }
                    }
                }
                bot.send_message(chat_id, "✅ Export diajukan.").await?;
            }
            "side" => {
                bot.send_message(chat_id, "Ketik <code>/side &lt;pertanyaan&gt;</code> untuk bertanya sekilas.").parse_mode(ParseMode::Html).await?;
            }
            "abort" => {
                let _ = state.client.abort(&sid).await;
                bot.send_message(chat_id, "🛑 Generasi aktif di-abort.").await?;
            }
            _ => {}
        }
    } else if data == "menu:status" {
        if let Ok(resp) = state.client.get_state(Some(&sid)).await {
            let data = resp.get("data").unwrap_or(&resp);
            let active_sid = data.get("activeSessionId").and_then(|v| v.as_str()).unwrap_or(&sid);
            let model = data.get("state").and_then(|s| s.get("model")).and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap_or("default");
            let text = format!("📊 <b>Session Status</b>
<b>Active Session:</b> <code>{}</code>
<b>Model:</b> <code>{}</code>", escape_html(active_sid), escape_html(model));
            bot.send_message(chat_id, text).parse_mode(ParseMode::Html).await?;
        }
    } else if data == "menu:new" || data == "new_recent" {
        let (text, kb) = build_new_session_menu(&state).await;
        bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
    } else if let Some(key) = data.strip_prefix("create_in:") {
        let target_dir = state.get_dir_key(key).await;
        if let Ok(resp) = state.client.create_session(target_dir.as_deref()).await {
            let d = resp.get("data").unwrap_or(&resp);
            let sid = d.get("activeSessionId").and_then(|v| v.as_str()).unwrap_or("unknown");
            state.set_user_session(user_id, sid).await;
            let dir_disp = target_dir.unwrap_or_else(|| "default".to_string());
            bot.send_message(chat_id, format!("✨ <b>Sesi Baru Telah Aktif!</b>
🆔 ID: <code>{}</code>
📂 Folder: <code>{}</code>", escape_html(sid), escape_html(&dir_disp))).parse_mode(ParseMode::Html).await?;
        }
    } else if let Some(rest) = data.strip_prefix("browse_dir:") {
        let parts: Vec<&str> = rest.split(':').collect();
        let key = parts.get(0).copied().unwrap_or_default();
        let hidden = parts.get(1).map_or(false, |v| *v == "1");
        let page: usize = parts.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
        let path = state.get_dir_key(key).await;
        let (text, kb) = build_browse_dir_menu(&state, path.as_deref(), page, hidden).await;
        bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
    } else if let Some(rest) = data.strip_prefix("browse_page:") {
        let parts: Vec<&str> = rest.split(':').collect();
        let key = parts.get(0).copied().unwrap_or_default();
        let hidden = parts.get(1).map_or(false, |v| *v == "1");
        let page: usize = parts.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
        let path = state.get_dir_key(key).await;
        let (text, kb) = build_browse_dir_menu(&state, path.as_deref(), page, hidden).await;
        bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
    } else if let Some(rest) = data.strip_prefix("browse_toggle:") {
        let parts: Vec<&str> = rest.split(':').collect();
        let key = parts.get(0).copied().unwrap_or_default();
        let hidden = parts.get(1).map_or(false, |v| *v == "1");
        let page: usize = parts.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
        let path = state.get_dir_key(key).await;
        let (text, kb) = build_browse_dir_menu(&state, path.as_deref(), page, hidden).await;
        bot.send_message(chat_id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
    } else if data == "menu:compact" {
        let _ = bot.send_message(chat_id, "🧹 Menjalankan context compaction...").await;
        let _ = state.client.compact(&sid).await;
        bot.send_message(chat_id, "✅ Context compaction selesai.").await?;
    }

    Ok(())
}

async fn handle_command(
    bot: Bot,
    msg: Message,
    cmd: Command,
    state: Arc<BotState>,
) -> ResponseResult<()> {
    let user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized(&state, user_id) {
        bot.send_message(msg.chat.id, "⛔ Unauthorized user.")
            .await?;
        return Ok(());
    }

    let sid = state.get_or_create_user_session(user_id).await;

    match cmd {
        Command::Start | Command::Help => {
            let help_text = "🤖 <b>Prime Agent Telegram Bot</b>

<b>Perintah Tersedia:</b>
/status - Status sesi dan model aktif
/pin - Sematkan status live di chat
/new [path] - Buat sesi coding baru
/sessions - Daftar sesi yang ada
/history - Riwayat 5 pesan terakhir
/model [name] - Ganti model AI
/rename &lt;nama&gt; - Ganti judul sesi
/side &lt;tanya&gt; - Tanya sekilas tanpa simpan
/subagents - Daftar subagent
/export - Ekspor transkrip sesi
/thinking - Level reasoning
/track - Pantau sesi latar belakang
/sh &lt;cmd&gt; - Terminal shell
/diff - Git diff
/compact - Context compaction
/ls [path] - File browser
/tasks - Scheduled tasks
/abort - Hentikan generasi
/menu - Menu interaktif";
            bot.send_message(msg.chat.id, help_text)
                .reply_markup(build_main_reply_keyboard())
                .parse_mode(ParseMode::Html)
                .await?;
        }
        Command::Menu => {
            bot.send_message(msg.chat.id, "⚙️ <b>Menu Fitur Prime Agent:</b>
Pilih salah satu tindakan:")
                .reply_markup(build_full_menu())
                .parse_mode(ParseMode::Html)
                .await?;
        }
        Command::Status => {
            if let Ok(resp) = state.client.get_state(Some(&sid)).await {
                let data = resp.get("data").unwrap_or(&resp);
                let active_sid = data.get("activeSessionId").and_then(|v| v.as_str()).unwrap_or(&sid);
                let model = data.get("state").and_then(|s| s.get("model")).and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap_or("default");
                let thinking = data.get("state").and_then(|s| s.get("thinkingLevel")).and_then(|v| v.as_str()).unwrap_or("off");

                let mut lines = vec![
                    "📊 <b>Prime Agent Status</b>".to_string(),
                    "".to_string(),
                    format!("🆔 <b>Session:</b> <code>{}</code>", escape_html(&active_sid.chars().take(8).collect::<String>())),
                    format!("📂 <b>Directory:</b> <code>{}</code>", escape_html(data.get("state").and_then(|s| s.get("cwd")).and_then(|v| v.as_str()).unwrap_or("default"))),
                    format!("🤖 <b>Model:</b> <code>{}</code>", escape_html(model)),
                    format!("💭 <b>Thinking:</b> <code>{}</code>", escape_html(thinking)),
                ];

                if let Some(u) = data.get("state").and_then(|s| s.get("usage")) {
                    let in_tok = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let out_tok = u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    lines.push(format!("📈 <b>Tokens:</b> In: {} | Out: {}", in_tok, out_tok));
                    if let Some(cost) = u.get("cost").and_then(|v| v.as_f64()) {
                        lines.push(format!("💰 <b>Cost:</b> ${:.4}", cost));
                    }
                }

                if let Some(children) = data.get("children").and_then(|v| v.as_array()) {
                    if !children.is_empty() {
                        lines.push(format!("🤖 <b>Subagents:</b> {} subagent (lihat via /subagents)", children.len()));
                    }
                }

                // Check if working in background
                let mut is_working = false;
                if let Ok(l_resp) = state.client.list_sessions().await {
                    if let Some(arr) = l_resp.get("data").or_else(|| l_resp.get("sessions")).and_then(|v| v.as_array()) {
                        if let Some(s) = arr.iter().find(|x| x.get("id").or_else(|| x.get("activeSessionId")).and_then(|v| v.as_str()) == Some(&sid)) {
                            is_working = s.get("isSessionActive") == Some(&serde_json::json!(true))
                                || s.get("activity") == Some(&serde_json::json!("working"))
                                || s.get("isStreaming") == Some(&serde_json::json!(true))
                                || s.get("isRunningTools") == Some(&serde_json::json!(true));
                        }
                    }
                }

                if is_working {
                    lines.push("".to_string());
                    lines.push("⚡ <b>Sesi ini sedang aktif bekerja di latar belakang!</b>".to_string());
                    let kb = InlineKeyboardMarkup::new(vec![
                        vec![InlineKeyboardButton::callback("📡 Pantau & Kirim Notif", format!("track_session:{}", sid))]
                    ]);
                    bot.send_message(msg.chat.id, lines.join("
")).reply_markup(kb).parse_mode(ParseMode::Html).await?;
                } else {
                    bot.send_message(msg.chat.id, lines.join("
")).reply_markup(build_main_reply_keyboard()).parse_mode(ParseMode::Html).await?;
                }
            }
        }
        Command::Pin => {
            let msg_sent = bot.send_message(msg.chat.id, "📌 <b>Prime Agent Live Status: Initializing...</b>").parse_mode(ParseMode::Html).await?;
            let _ = bot.pin_chat_message(msg.chat.id, msg_sent.id).await;
            {
                let mut pins = state.pinned_messages.lock().await;
                pins.insert(user_id, (msg.chat.id, msg_sent.id));
            }
            update_pinned_status(&bot, &state, user_id).await;
        }
        Command::New(path_arg) => {
            if path_arg.trim().is_empty() {
                let (text, kb) = build_new_session_menu(&state).await;
                bot.send_message(msg.chat.id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
            } else {
                let cwd = Some(path_arg.trim());
                if let Ok(resp) = state.client.create_session(cwd).await {
                    let d = resp.get("data").unwrap_or(&resp);
                    let new_sid = d.get("activeSessionId").and_then(|v| v.as_str()).unwrap_or("unknown");
                    state.set_user_session(user_id, new_sid).await;
                    bot.send_message(msg.chat.id, format!("✨ Sesi baru dibuat di <code>{}</code>:
ID: <code>{}</code>", escape_html(path_arg.trim()), escape_html(new_sid))).parse_mode(ParseMode::Html).await?;
                }
            }
        }
        Command::Sessions => {
            if let Ok(resp) = state.client.list_sessions().await {
                let sessions = resp.get("data").or_else(|| resp.get("sessions")).and_then(|v| v.as_array());
                if let Some(arr) = sessions {
                    let current_id = state.get_or_create_user_session(user_id).await;
                    let (text, kb) = build_sessions_menu(arr, 0, Some(&current_id));
                    bot.send_message(msg.chat.id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
                }
            }
        }
        Command::History => {
            if let Ok(resp) = state.client.get_state(Some(&sid)).await {
                let data = resp.get("data").unwrap_or(&resp);
                let messages = data.get("messages").and_then(|v| v.as_array());
                if let Some(arr) = messages {
                    let recent: Vec<_> = arr.iter().rev().take(5).collect();
                    let mut chat_msgs = Vec::new();
                    for m in recent.into_iter().rev() {
                        let role = m.get("role").or_else(|| m.get("message").and_then(|sub| sub.get("role"))).and_then(serde_json::Value::as_str).unwrap_or("user");
                        let content = m.get("content").or_else(|| m.get("message").and_then(|sub| sub.get("content"))).and_then(serde_json::Value::as_str).unwrap_or("");
                        if !content.trim().is_empty() {
                            let icon = if role == "assistant" { "🤖" } else { "👤" };
                            chat_msgs.push(format!("{icon} <b>{role}:</b>
{}", markdown_to_telegram_html(content)));
                        }
                    }
                    if !chat_msgs.is_empty() {
                        let combined = chat_msgs.join("

───────────────

");
                        for chunk in split_message(&combined, 3800) {
                            bot.send_message(msg.chat.id, chunk).parse_mode(ParseMode::Html).await?;
                        }
                        return Ok(());
                    }
                }
            }
            bot.send_message(msg.chat.id, "📭 <i>Belum ada riwayat percakapan di sesi ini.</i>").parse_mode(ParseMode::Html).await?;
        }
        Command::Model(name) => {
            if name.trim().is_empty() {
                let (text, kb) = build_provider_menu(&state, &sid).await;
                bot.send_message(msg.chat.id, text).reply_markup(kb).parse_mode(ParseMode::Html).await?;
            } else {
                let _ = state.client.set_model(&sid, "default", name.trim()).await;
                bot.send_message(msg.chat.id, format!("Mengganti model ke: <code>{}</code>", escape_html(&name))).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Rename(new_name) => {
            if new_name.trim().is_empty() {
                bot.send_message(msg.chat.id, "Gunakan: <code>/rename &lt;nama_baru&gt;</code>").parse_mode(ParseMode::Html).await?;
            } else {
                let _ = state.client.rename_session(&sid, new_name.trim()).await;
                bot.send_message(msg.chat.id, format!("✅ Sesi dinamai ulang menjadi: <b>{}</b>", escape_html(new_name.trim()))).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Side(question) => {
            if question.trim().is_empty() {
                bot.send_message(msg.chat.id, "Gunakan: <code>/side &lt;pertanyaan&gt;</code>").parse_mode(ParseMode::Html).await?;
            } else {
                let id = format!("side_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
                let _ = bot.send_chat_action(msg.chat.id, ChatAction::Typing).await;
                let _ = state.client.ask_side_question(&sid, &id, question.trim()).await;
                bot.send_message(msg.chat.id, format!("❓ <b>Side Question diajukan:</b> <i>{}</i>", escape_html(question.trim()))).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Subagents => {
            if let Ok(resp) = state.client.get_state(Some(&sid)).await {
                let data = resp.get("data").unwrap_or(&resp);
                let children = data.get("children").and_then(|v| v.as_array());
                if let Some(arr) = children {
                    if !arr.is_empty() {
                        let mut rows = Vec::new();
                        for c in arr {
                            let cid = c.get("id").or_else(|| c.get("childId")).and_then(|v| v.as_str()).unwrap_or("sub");
                            let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("subagent");
                            let status = c.get("status").and_then(|v| v.as_str()).unwrap_or("done");
                            let icon = if status == "running" { "⏳" } else { "✅" };
                            rows.push(vec![InlineKeyboardButton::callback(
                                format!("{icon} {name} ({status})"),
                                format!("view_sub:{}:{}", sid, cid),
                            )]);
                        }
                        bot.send_message(msg.chat.id, format!("🤖 <b>Subagents ({})</b>:
Klik untuk melihat transkrip:", arr.len())).reply_markup(InlineKeyboardMarkup::new(rows)).parse_mode(ParseMode::Html).await?;
                        return Ok(());
                    }
                }
            }
            bot.send_message(msg.chat.id, "ℹ️ Tidak ada subagent di sesi ini.").parse_mode(ParseMode::Html).await?;
        }
        Command::Export => {
            let _ = bot.send_chat_action(msg.chat.id, ChatAction::UploadDocument).await;
            if let Ok(resp) = state.client.export_session(&sid).await {
                let data = resp.get("data").unwrap_or(&resp);
                if let Some(path_str) = data.get("path").and_then(|v| v.as_str()) {
                    let p = PathBuf::from(path_str);
                    if p.exists() {
                        let doc = InputFile::file(&p);
                        let _ = bot.send_document(msg.chat.id, doc).caption("📄 Export transkrip sesi").await;
                        return Ok(());
                    }
                }
            }
            bot.send_message(msg.chat.id, "✅ Export diajukan.").await?;
        }
        Command::Thinking => {
            let kb = InlineKeyboardMarkup::new(vec![
                vec![
                    InlineKeyboardButton::callback("Off", "think:off"),
                    InlineKeyboardButton::callback("Low", "think:low"),
                    InlineKeyboardButton::callback("Medium", "think:medium"),
                ],
                vec![
                    InlineKeyboardButton::callback("High", "think:high"),
                    InlineKeyboardButton::callback("Max", "think:max"),
                ],
            ]);
            bot.send_message(msg.chat.id, "💭 <b>Pilih Level Thinking:</b>").reply_markup(kb).parse_mode(ParseMode::Html).await?;
        }
        Command::Track => {
            let ok = start_tracking_session(bot.clone(), Arc::clone(&state), msg.chat.id, &sid).await;
            if ok {
                bot.send_message(msg.chat.id, format!("📡 <b>Memantau Sesi</b> <code>{}</code>

<i>Bot akan memberi notifikasi dan mengirimkan balasan ke sini begitu tugas yang berjalan selesai...</i>", escape_html(&sid.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
            } else {
                bot.send_message(msg.chat.id, format!("⚠️ <b>Tidak Ada Tugas Aktif</b>

Sesi <code>{}</code> saat ini sedang menganggur (idle). Listener tracking hanya dapat diaktifkan jika sesi sedang memproses tugas di Web/CLI.", escape_html(&sid.chars().take(8).collect::<String>()))).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Sh(cmd_text) => {
            if cmd_text.trim().is_empty() {
                let usage = "💻 <b>Penggunaan Terminal Shell:</b>
Ketik <code>/sh &lt;perintah&gt;</code> atau <code>!&lt;perintah&gt;</code>

Contoh: <code>/sh git status</code>";
                bot.send_message(msg.chat.id, usage).parse_mode(ParseMode::Html).await?;
                return Ok(());
            }
            let _ = bot.send_chat_action(msg.chat.id, ChatAction::Typing).await;
            match state.client.exec_terminal(Some(&sid), cmd_text.trim()).await {
                Ok(res) => {
                    let raw_output = res.get("output").and_then(|v| v.as_str()).unwrap_or("(tidak ada output)");
                    let exit_code = res.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0);
                    let duration = res.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cwd = res.get("cwd").and_then(|v| v.as_str()).unwrap_or("~");
                    let icon = if exit_code == 0 { "✅" } else { "❌" };
                    let status_label = if exit_code == 0 { "exit 0".to_string() } else { format!("exit {exit_code}") };

                    let output = if raw_output.len() > 3400 {
                        format!("{}

... [output terpotong] ...

{}", &raw_output[..1700], &raw_output[raw_output.len().saturating_sub(1500)..])
                    } else {
                        raw_output.to_string()
                    };

                    let reply = format!("{icon} <b>$ {}</b>
⏱️ <code>{}</code> ({}ms) | 📂 <code>{}</code>

<pre><code>{}</code></pre>", escape_html(cmd_text.trim()), status_label, duration, escape_html(cwd), escape_html(&output));
                    bot.send_message(msg.chat.id, reply).reply_markup(build_main_reply_keyboard()).parse_mode(ParseMode::Html).await?;
                }
                Err(e) => {
                    bot.send_message(msg.chat.id, format!("❌ Eksekusi gagal: {e}")).await?;
                }
            }
        }
        Command::Diff => {
            if let Ok(resp) = state.client.git_diff(Some(&sid)).await {
                let diff_text = resp.get("diff").and_then(|v| v.as_str()).unwrap_or("(tidak ada diff)");
                let reply = format!("🔍 <b>Git Diff:</b>

<pre><code>{}</code></pre>", escape_html(diff_text));
                bot.send_message(msg.chat.id, reply).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Compact => {
            let _ = bot.send_message(msg.chat.id, "🧹 Menjalankan context compaction...").await;
            let _ = state.client.compact(&sid).await;
            bot.send_message(msg.chat.id, "✅ Context compaction selesai.").await?;
        }
        Command::Ls(path) => {
            let target_path = path.trim();
            if let Ok(val) = state.client.list_workspace(&sid, target_path).await {
                let entries = val.get("entries").and_then(|v| v.as_array());
                let mut rows = Vec::new();
                if !target_path.is_empty() {
                    let parent = if let Some(idx) = target_path.rfind('/') { &target_path[..idx] } else { "" };
                    rows.push(vec![InlineKeyboardButton::callback("⬅️ Back", format!("ls:{}", parent))]);
                }
                if let Some(arr) = entries {
                    for item in arr.iter().take(12) {
                        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let is_dir = item.get("type").and_then(|v| v.as_str()) == Some("dir");
                        let full = if target_path.is_empty() { name.to_string() } else { format!("{target_path}/{name}") };
                        let (icon, cb) = if is_dir { ("📁", format!("ls:{full}")) } else { ("📄", format!("cat:{full}")) };
                        rows.push(vec![InlineKeyboardButton::callback(format!("{icon} {name}"), cb)]);
                    }
                }
                bot.send_message(msg.chat.id, format!("📂 <b>Folder:</b> <code>{}</code>", escape_html(if target_path.is_empty() { "/" } else { target_path }))).reply_markup(InlineKeyboardMarkup::new(rows)).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Tasks => {
            if let Ok(resp) = state.client.list_cron_jobs(&sid).await {
                let jobs = resp.get("jobs").and_then(|v| v.as_array());
                if let Some(arr) = jobs {
                    if !arr.is_empty() {
                        let mut rows = Vec::new();
                        for j in arr {
                            let jid = j.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                            let sched = j.get("schedule").and_then(|v| v.as_str()).unwrap_or("");
                            let prompt = j.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                            let label = format!("❌ {} ({})", sched, if prompt.len() > 15 { &prompt[..15] } else { prompt });
                            rows.push(vec![InlineKeyboardButton::callback(label, format!("cron_cancel:{}", jid))]);
                        }
                        bot.send_message(msg.chat.id, "⏰ <b>Scheduled Tasks:</b>
Klik untuk membatalkan:").reply_markup(InlineKeyboardMarkup::new(rows)).parse_mode(ParseMode::Html).await?;
                        return Ok(());
                    }
                }
            }
            bot.send_message(msg.chat.id, "⏰ Tidak ada scheduled task aktif.").parse_mode(ParseMode::Html).await?;
        }
        Command::CtxMode(profile) => {
            let p = profile.trim().to_lowercase();
            if p.is_empty() {
                let current = std::env::var("LEAN_CTX_PROFILE").unwrap_or_else(|_| "coder".to_string());
                let info = format!("⚙️ <b>lean-ctx Context Profile:</b>\n\n                    Profil saat ini: <b>{}</b>\n\n                    <b>Pilihan profil:</b>\n                    • <code>coder</code> - Coding umum, kompresi seimbang\n                    • <code>exploration</code> - Peta codebase, related hints luas\n                    • <code>bugfix</code> - Debugging terfokus, hemat shell\n                    • <code>review</code> - Code review luas, read-only\n                    • <code>hotfix</code> - Perbaikan cepat, signatures ringkas\n                    • <code>ci-debug</code> - CI/build/test, shell output besar\n                    • <code>passthrough</code> - Output mentah tanpa kompresi\n\n                    Ketik: <code>/ctx-mode &lt;nama_profil&gt;</code>", escape_html(&current));
                bot.send_message(msg.chat.id, info).parse_mode(ParseMode::Html).await?;
            } else {
                std::env::set_var("LEAN_CTX_PROFILE", &p);
                bot.send_message(msg.chat.id, format!("✅ Context profile diubah menjadi: <b>{}</b>", escape_html(&p))).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::CtxTools(profile) => {
            let p = profile.trim().to_lowercase();
            if p.is_empty() {
                let current = std::env::var("LEAN_CTX_TOOL_PROFILE").unwrap_or_else(|_| "stage2".to_string());
                let info = format!("🛠️ <b>lean-ctx Tool Profile:</b>\n\n                    Profil saat ini: <b>{}</b>\n\n                    <b>Pilihan profil:</b>\n                    • <code>minimal</code> - 5 tool inti (overhead token terkecil)\n                    • <code>lean</code> - Core tools + compose, session, patch\n                    • <code>standard</code> - Set seimbang coding kompleks\n                    • <code>stage2</code> - Core + Stage 2 (overview, graph, memory)\n                    • <code>power</code> - Semua tool aktif (kemampuan maksimal)\n\n                    Ketik: <code>/ctx-tools &lt;nama_profil&gt;</code>", escape_html(&current));
                bot.send_message(msg.chat.id, info).parse_mode(ParseMode::Html).await?;
            } else {
                std::env::set_var("LEAN_CTX_TOOL_PROFILE", &p);
                bot.send_message(msg.chat.id, format!("✅ Tool profile diubah menjadi: <b>{}</b>", escape_html(&p))).parse_mode(ParseMode::Html).await?;
            }
        }
        Command::Abort => {
            let _ = state.client.abort(&sid).await;
            bot.send_message(msg.chat.id, "🛑 Generasi aktif di-abort.").await?;
        }
    }

    Ok(())
}

async fn handle_photo(
    bot: Bot,
    msg: Message,
    state: Arc<BotState>,
) -> ResponseResult<()> {
    let user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized(&state, user_id) {
        bot.send_message(msg.chat.id, "⛔ Unauthorized user.").await?;
        return Ok(());
    }

    let Some(photos) = msg.photo() else {
        return Ok(());
    };
    let Some(photo) = photos.last() else {
        return Ok(());
    };

    let sid = state.get_or_create_user_session(user_id).await;
    let _ = bot.send_chat_action(msg.chat.id, ChatAction::Typing).await;

    match bot.get_file(photo.file.id.clone()).await {
        Ok(file) => {
            let mut buf = Vec::new();
            if bot.download_file(&file.path, &mut buf).await.is_ok() {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
                let caption = msg.caption().unwrap_or("Periksa gambar ini dan jelaskan atau perbaiki masalah yang terlihat.");
                let image_obj = serde_json::json!({
                    "type": "image",
                    "data": b64,
                    "mimeType": "image/jpeg",
                });
                run_prompt_and_stream(bot, state, msg.chat.id, user_id, sid, caption.to_string(), Some(serde_json::json!([image_obj]))).await;
            }
        }
        Err(e) => {
            bot.send_message(msg.chat.id, format!("❌ Gagal mengunduh foto: {e}")).await?;
        }
    }
    Ok(())
}

async fn handle_document(
    bot: Bot,
    msg: Message,
    state: Arc<BotState>,
) -> ResponseResult<()> {
    let user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized(&state, user_id) {
        bot.send_message(msg.chat.id, "⛔ Unauthorized user.").await?;
        return Ok(());
    }

    let Some(doc) = msg.document() else {
        return Ok(());
    };

    let sid = state.get_or_create_user_session(user_id).await;
    let _ = bot.send_chat_action(msg.chat.id, ChatAction::Typing).await;

    match bot.get_file(doc.file.id.clone()).await {
        Ok(file) => {
            let mut buf = Vec::new();
            if bot.download_file(&file.path, &mut buf).await.is_ok() {
                let text_content = String::from_utf8_lossy(&buf);
                let doc_name = doc.file_name.as_deref().unwrap_or("document");
                let caption = msg.caption().unwrap_or("Silakan periksa dan tindak lanjuti file ini.");
                let full_prompt = format!(
                    "{}

--- File Lampiran: {doc_name} ---
{text_content}
--- Akhir File Lampiran ---",
                    caption
                );
                run_prompt_and_stream(bot, state, msg.chat.id, user_id, sid, full_prompt, None).await;
            }
        }
        Err(e) => {
            bot.send_message(msg.chat.id, format!("❌ Gagal mengunduh dokumen: {e}")).await?;
        }
    }
    Ok(())
}

async fn handle_voice(
    bot: Bot,
    msg: Message,
    state: Arc<BotState>,
) -> ResponseResult<()> {
    let user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized(&state, user_id) {
        bot.send_message(msg.chat.id, "⛔ Unauthorized user.").await?;
        return Ok(());
    }

    let Some(voice) = msg.voice() else {
        return Ok(());
    };

    let sid = state.get_or_create_user_session(user_id).await;

    bot.send_message(msg.chat.id, "🎙️ <i>Mengunduh dan mentranskripsi pesan suara...</i>").parse_mode(ParseMode::Html).await?;
    match bot.get_file(voice.file.id.clone()).await {
        Ok(file) => {
            let mut buf = Vec::new();
            if bot.download_file(&file.path, &mut buf).await.is_ok() {
                if let Some(key) = &state.config.whisper_api_key {
                    let base_url = state.config.whisper_base_url.as_deref().unwrap_or("https://api.openai.com/v1");
                    let endpoint = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
                    let form = reqwest::multipart::Form::new()
                        .text("model", "whisper-1")
                        .part("file", reqwest::multipart::Part::bytes(buf).file_name("voice.ogg").mime_str("audio/ogg").unwrap());
                    let res = reqwest::Client::new()
                        .post(&endpoint)
                        .bearer_auth(key)
                        .multipart(form)
                        .send()
                        .await;
                    if let Ok(resp) = res {
                        if let Ok(val) = resp.json::<serde_json::Value>().await {
                            if let Some(text) = val.get("text").and_then(|v| v.as_str()) {
                                bot.send_message(msg.chat.id, format!("🗣️ <i>Transkripsi:</i> \"{}\"", escape_html(text))).parse_mode(ParseMode::Html).await?;
                                run_prompt_and_stream(bot, state, msg.chat.id, user_id, sid, text.to_string(), None).await;
                                return Ok(());
                            }
                        }
                    }
                }
                bot.send_message(msg.chat.id, "⚠️ Whisper API key tidak dikonfigurasi untuk transkripsi suara.").await?;
            }
        }
        Err(e) => {
            bot.send_message(msg.chat.id, format!("❌ Gagal mengunduh voice note: {e}")).await?;
        }
    }
    Ok(())
}

async fn handle_message(
    bot: Bot,
    msg: Message,
    state: Arc<BotState>,
) -> ResponseResult<()> {
    let user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized(&state, user_id) {
        bot.send_message(msg.chat.id, "⛔ Unauthorized user.")
            .await?;
        return Ok(());
    }

    let Some(text) = msg.text() else {
        return Ok(());
    };

    // If text starts with '!', execute as shell command
    if let Some(cmd) = text.strip_prefix('!') {
        let sid = state.get_or_create_user_session(user_id).await;
        let _ = bot.send_chat_action(msg.chat.id, ChatAction::Typing).await;
        match state.client.exec_terminal(Some(&sid), cmd.trim()).await {
            Ok(res) => {
                let raw_output = res.get("output").and_then(|v| v.as_str()).unwrap_or("(tidak ada output)");
                let exit_code = res.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0);
                let duration = res.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0);
                let cwd = res.get("cwd").and_then(|v| v.as_str()).unwrap_or("~");
                let icon = if exit_code == 0 { "✅" } else { "❌" };
                let status_label = if exit_code == 0 { "exit 0".to_string() } else { format!("exit {exit_code}") };

                let output = if raw_output.len() > 3400 {
                    format!("{}

... [output terpotong] ...

{}", &raw_output[..1700], &raw_output[raw_output.len().saturating_sub(1500)..])
                } else {
                    raw_output.to_string()
                };

                let reply = format!("{icon} <b>$ {}</b>
⏱️ <code>{}</code> ({}ms) | 📂 <code>{}</code>

<pre><code>{}</code></pre>", escape_html(cmd.trim()), status_label, duration, escape_html(cwd), escape_html(&output));
                bot.send_message(msg.chat.id, reply).reply_markup(build_main_reply_keyboard()).parse_mode(ParseMode::Html).await?;
            }
            Err(e) => {
                bot.send_message(msg.chat.id, format!("❌ Eksekusi gagal: {e}")).await?;
            }
        }
        return Ok(());
    }

    // Check bottom keyboard button clicks
    if text == "📊 Status" {
        return handle_command(bot, msg, Command::Status, state).await;
    }
    if text == "📋 Sessions" {
        return handle_command(bot, msg, Command::Sessions, state).await;
    }
    if text == "➕ New Session" {
        return handle_command(bot, msg, Command::New(String::new()), state).await;
    }
    if text == "⚙️ Menu" {
        return handle_command(bot, msg, Command::Menu, state).await;
    }

    let sid = state.get_or_create_user_session(user_id).await;
    run_prompt_and_stream(bot, state, msg.chat.id, user_id, sid, text.to_string(), None).await;

    Ok(())
}
