pub const MAX_TELEGRAM_MESSAGE_LENGTH: usize = 4000;

pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        let slice = &remaining[..max_len];
        let split_idx = if let Some(pos) = slice.rfind('\n') {
            if pos >= max_len / 2 {
                pos
            } else if let Some(space_pos) = slice.rfind(' ') {
                space_pos
            } else {
                max_len
            }
        } else if let Some(space_pos) = slice.rfind(' ') {
            space_pos
        } else {
            max_len
        };

        let chunk = remaining[..split_idx].trim_end();
        if !chunk.is_empty() {
            chunks.push(chunk.to_string());
        }
        remaining = remaining[split_idx..].trim_start();
    }

    chunks
}

pub fn format_tool_call(name: &str, args: Option<&serde_json::Value>) -> String {
    match name {
        "bash" => {
            let cmd = args
                .and_then(|a| a.get("command"))
                .and_then(|c| c.as_str())
                .unwrap_or_default();
            let preview: String = cmd.chars().take(80).collect();
            format!("🔧 <b>bash:</b> <code>{}</code>", escape_html(&preview))
        }
        "read" | "write" | "edit" => {
            let path = args
                .and_then(|a| a.get("path"))
                .and_then(|p| p.as_str())
                .unwrap_or_default();
            format!("📁 <b>{name}:</b> <code>{}</code>", escape_html(path))
        }
        _ => format!("⚙️ <b>tool:</b> <code>{name}</code>"),
    }
}


pub fn markdown_to_telegram_html(markdown: &str) -> String {
    if markdown.trim().is_empty() {
        return String::new();
    }

    let mut text = markdown.replace("
", "
");

    // 1. Protect code blocks
    let mut code_blocks: Vec<String> = Vec::new();
    let re_code = regex::Regex::new(r"(?s)```([a-zA-Z0-9_+-]*)\s*
?(.*?)```").unwrap();
    text = re_code.replace_all(&text, |caps: &regex::Captures| {
        let lang = caps.get(1).map_or("", |m| m.as_str().trim());
        let code = caps.get(2).map_or("", |m| m.as_str().trim_end());
        let clean_lang = if !lang.is_empty() {
            format!(" class=\"language-{}\"", escape_html(lang))
        } else {
            String::new()
        };
        let idx = code_blocks.len();
        code_blocks.push(format!("<pre><code{}>{}</code></pre>", clean_lang, escape_html(code)));
        format!("TGCODEBLOCK{idx}END")
    }).to_string();

    // 2. Protect inline code
    let mut inline_codes: Vec<String> = Vec::new();
    let re_inline = regex::Regex::new(r"`([^`
]+)`").unwrap();
    text = re_inline.replace_all(&text, |caps: &regex::Captures| {
        let code = caps.get(1).map_or("", |m| m.as_str());
        let idx = inline_codes.len();
        inline_codes.push(format!("<code>{}</code>", escape_html(code)));
        format!("TGINLINECODE{idx}END")
    }).to_string();

    // 3. Escape HTML in text spans
    text = escape_html(&text);

    // 4. Horizontal rules
    let re_hr = regex::Regex::new(r"(?m)^(?:[-*_]){3,}\s*$").unwrap();
    text = re_hr.replace_all(&text, "──────────────").to_string();

    // 5. Headings
    let re_h1 = regex::Regex::new(r"(?m)^#\s+(.+)$").unwrap();
    text = re_h1.replace_all(&text, "<b>■ $1</b>").to_string();
    let re_h2 = regex::Regex::new(r"(?m)^##\s+(.+)$").unwrap();
    text = re_h2.replace_all(&text, "<b>◆ $1</b>").to_string();
    let re_h3 = regex::Regex::new(r"(?m)^#{3,6}\s+(.+)$").unwrap();
    text = re_h3.replace_all(&text, "<b>• $1</b>").to_string();

    // 6. Lists
    let re_bullet = regex::Regex::new(r"(?m)^[ 	]*[-*+][ 	]+(.+)$").unwrap();
    text = re_bullet.replace_all(&text, "  • $1").to_string();

    // 7. Bold
    let re_bold = regex::Regex::new(r"\*\*([^\s*][^*]*?[^\s*]|[^\s*])\*\*").unwrap();
    text = re_bold.replace_all(&text, "<b>$1</b>").to_string();

    // 8. Italic
    let re_italic = regex::Regex::new(r"(^|[^\w])\*([^\s*][^*]*?[^\s*]|[^\s*])\*([^\w]|$)").unwrap();
    text = re_italic.replace_all(&text, "$1<i>$2</i>$3").to_string();

    // 9. Strikethrough
    let re_strike = regex::Regex::new(r"~~(.+?)~~").unwrap();
    text = re_strike.replace_all(&text, "<s>$1</s>").to_string();

    // 10. Restore code blocks & inline code
    for (i, block) in code_blocks.iter().enumerate() {
        let tag = format!("TGCODEBLOCK{i}END");
        text = text.replace(&tag, block);
    }
    for (i, code) in inline_codes.iter().enumerate() {
        let tag = format!("TGINLINECODE{i}END");
        text = text.replace(&tag, code);
    }

    text.trim().to_string()
}


pub fn format_model_identifier(model: Option<&serde_json::Value>) -> String {
    let Some(m) = model else { return "default".to_string(); };
    let id = m.get("id").or_else(|| m.get("modelId")).or_else(|| m.get("name")).and_then(|v| v.as_str()).unwrap_or("default");
    if let Some(prov) = m.get("provider").and_then(|v| v.as_str()) {
        format!("{prov}/{id}")
    } else {
        id.to_string()
    }
}

pub fn format_detailed_error(error: &str, stop_reason: Option<&str>) -> String {
    let mut title = "⚠️ <b>Error dari Model Provider</b>";
    let mut advice = "Gunakan tombol <b>🤖 Model</b> untuk beralih ke model lain.";

    if error.contains("429") || error.to_lowercase().contains("quota_exhausted") || error.to_lowercase().contains("rate limit") {
        title = "⏳ <b>Batas Kuota / Rate Limit Tercapai (429)</b>";
        advice = "Kuota model ini habis atau terkena rate limit. Silakan beralih ke model lain via <b>🤖 Model</b> atau tunggu reset kuota.";
    } else if error.contains("401") || error.to_lowercase().contains("unauthenticated") || error.to_lowercase().contains("invalid api key") {
        title = "🔑 <b>Autentikasi Gagal (401)</b>";
        advice = "API Key provider tidak valid atau kadaluarsa. Periksa konfigurasi auth provider Anda.";
    } else if error.to_lowercase().contains("context") || stop_reason == Some("maxTokens") {
        title = "📦 <b>Batas Konteks Penuh (Max Tokens)</b>";
        advice = "Panjang percakapan melebihi batas model. Gunakan tombol <b>/compact</b> atau buat sesi baru via <b>➕ New Session</b>.";
    } else if error.contains("503") || error.contains("500") || error.to_lowercase().contains("overloaded") {
        title = "💥 <b>Server Provider Overloaded (5xx)</b>";
        advice = "Server provider AI sedang down atau mengalami beban tinggi. Coba beralih ke provider cadangan via <b>🤖 Model</b>.";
    } else if error.contains("400") || error.to_lowercase().contains("invalid_argument") {
        title = "🚫 <b>Argumen Tidak Valid (400)</b>";
        advice = "Request ditolak provider. Coba ulangi prompt dengan kalimat yang lebih sederhana atau ganti model.";
    } else if stop_reason == Some("aborted") {
        title = "🛑 <b>Tugas Dibatalkan</b>";
        advice = "Generasi dihentikan oleh pengguna.";
    }

    let preview = if error.len() > 300 { &error[..300] } else { error };
    format!("{title}\n\n<code>{}</code>\n\n💡 <i>Saran: {advice}</i>", escape_html(preview))
}

pub fn format_session_item_label(session: &serde_json::Value, index: usize, is_current: bool) -> String {
    let marker = if is_current { "🟢 " } else { "" };
    let first_msg = session.get("firstMessage").and_then(|v| v.as_str()).map(|s| s.trim());
    let name = session.get("name").and_then(|v| v.as_str());
    let id = session.get("id").or_else(|| session.get("sessionId")).and_then(|v| v.as_str()).unwrap_or("session");

    let title = match first_msg {
        Some(msg) if !msg.is_empty() => {
            let one_line = msg.replace('\n', " ");
            if one_line.len() > 35 {
                format!("{}...", &one_line[..32])
            } else {
                one_line
            }
        }
        _ => name.unwrap_or(id).to_string(),
    };

    let folder = session.get("cwd").and_then(|v| v.as_str())
        .map(|c| c.split('/').filter(|p| !p.is_empty()).last().unwrap_or(c))
        .unwrap_or("");

    format!("{marker}{}. {title} [{folder}]", index + 1)
}

pub fn format_message_for_chat(msg: &serde_json::Value) -> Option<String> {
    let role = msg.get("role").or_else(|| msg.get("message").and_then(|m| m.get("role"))).and_then(|v| v.as_str())?;
    let content = msg.get("content").or_else(|| msg.get("message").and_then(|m| m.get("content")))?;

    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for p in arr {
            if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                    parts.push(t);
                }
            }
        }
        parts.join("\n")
    } else {
        String::new()
    };

    if text.trim().is_empty() {
        return None;
    }

    let icon = if role == "assistant" { "🤖 <b>Prime Agent</b>" } else { "👤 <b>User</b>" };
    Some(format!("{icon}:\n{}", markdown_to_telegram_html(&text)))
}
