pub const MAX_TELEGRAM_MESSAGE_LENGTH: usize = 3800;

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
        "bash" | "ctx_shell" => {
            let cmd = args
                .and_then(|a| a.get("command"))
                .and_then(|c| c.as_str())
                .unwrap_or_default();
            format!(
                "🔧 <b>{name}:</b> <code>{}</code>",
                escape_html(&cmd.chars().take(100).collect::<String>())
            )
        }
        "read" | "write" | "edit" | "ctx_read" | "ctx_patch" => {
            let path = args
                .and_then(|a| a.get("path").or_else(|| a.get("file")))
                .and_then(|p| p.as_str())
                .unwrap_or_default();
            format!("📁 <b>{name}:</b> <code>{}</code>", escape_html(path))
        }
        "grep" | "search" | "ctx_search" => {
            let pat = args
                .and_then(|a| a.get("pattern").or_else(|| a.get("query")))
                .and_then(|p| p.as_str())
                .unwrap_or_default();
            format!("🔍 <b>{name}:</b> <code>{}</code>", escape_html(pat))
        }
        _ => format!("⚙️ <b>tool:</b> <code>{}</code>", escape_html(name)),
    }
}

pub fn format_markdown_tables(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut output: Vec<String> = Vec::new();
    let mut table_buffer: Vec<&str> = Vec::new();

    let flush_table = |buffer: &mut Vec<&str>, out: &mut Vec<String>| {
        if buffer.is_empty() {
            return;
        }
        let mut rows: Vec<Vec<String>> = Vec::new();
        for line in buffer.iter() {
            let trimmed = line.trim();
            // Skip separator line e.g. |---|---|
            if trimmed.starts_with('|') && trimmed.ends_with('|') {
                let inner = &trimmed[1..trimmed.len() - 1];
                if inner
                    .chars()
                    .all(|c| c == '-' || c == ':' || c == '|' || c == ' ')
                {
                    continue;
                }
            }
            let mut cells: Vec<String> = trimmed
                .split('|')
                .skip(1)
                .map(|c| c.trim().to_string())
                .collect();
            if trimmed.ends_with('|') && !cells.is_empty() {
                cells.pop();
            }
            if !cells.is_empty() {
                rows.push(cells);
            }
        }
        if !rows.is_empty() {
            let col_count = rows.iter().map(|r| r.len()).max().unwrap_or(0);
            if col_count > 0 {
                let mut col_widths = vec![3usize; col_count];
                for row in &rows {
                    for (col_idx, cell) in row.iter().enumerate() {
                        if col_idx < col_count {
                            col_widths[col_idx] = col_widths[col_idx].max(cell.chars().count());
                        }
                    }
                }
                let formatted_rows: Vec<String> = rows
                    .iter()
                    .map(|r| {
                        let cells: Vec<String> = (0..col_count)
                            .map(|idx| {
                                let cell = r.get(idx).map(|s| s.as_str()).unwrap_or("");
                                format!("{:<width$}", cell, width = col_widths[idx])
                            })
                            .collect();
                        cells.join(" │ ")
                    })
                    .collect();

                let divider = col_widths
                    .iter()
                    .map(|w| "─".repeat(*w))
                    .collect::<Vec<_>>()
                    .join("─┼─");

                let mut table_ascii = vec![formatted_rows[0].clone(), divider];
                table_ascii.extend(formatted_rows[1..].iter().cloned());
                out.push(format!("\n```\n{}\n```\n", table_ascii.join("\n")));
            }
        }
        buffer.clear();
    };

    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with('|') && trimmed.ends_with('|') {
            table_buffer.push(line);
        } else {
            flush_table(&mut table_buffer, &mut output);
            output.push(line.to_string());
        }
    }
    flush_table(&mut table_buffer, &mut output);
    output.join("\n")
}

pub fn markdown_to_telegram_html(markdown: &str) -> String {
    if markdown.trim().is_empty() {
        return String::new();
    }

    // 1. Format markdown tables first
    let text = format_markdown_tables(markdown);
    let mut text = text.replace("\r\n", "\n");

    // 2. Protect code blocks (<pre><code class="...">)
    let mut code_blocks: Vec<String> = Vec::new();
    let re_code = regex::Regex::new(r"(?s)```([a-zA-Z0-9_+-]*)\s*\n?(.*?)```").unwrap();
    text = re_code
        .replace_all(&text, |caps: &regex::Captures| {
            let lang = caps.get(1).map_or("", |m| m.as_str().trim());
            let code = caps.get(2).map_or("", |m| m.as_str().trim_end());
            let clean_lang = if !lang.is_empty() {
                format!(" class=\"language-{}\"", escape_html(lang))
            } else {
                String::new()
            };
            let idx = code_blocks.len();
            code_blocks.push(format!(
                "<pre><code{}>{}\n</code></pre>",
                clean_lang,
                escape_html(code)
            ));
            format!("TGCODEBLOCK{idx}END")
        })
        .to_string();

    // 3. Protect inline code (<code>)
    let mut inline_codes: Vec<String> = Vec::new();
    let re_inline = regex::Regex::new(r"`([^`\n]+)`").unwrap();
    text = re_inline
        .replace_all(&text, |caps: &regex::Captures| {
            let code = caps.get(1).map_or("", |m| m.as_str());
            let idx = inline_codes.len();
            inline_codes.push(format!("<code>{}</code>", escape_html(code)));
            format!("TGINLINECODE{idx}END")
        })
        .to_string();

    // 4. Escape HTML in text spans
    text = escape_html(&text);

    // 5. Aesthetic horizontal rules
    let re_hr = regex::Regex::new(r"(?m)^(?:[-*_]){3,}\s*$").unwrap();
    text = re_hr.replace_all(&text, "──────────────").to_string();

    // 6. Headings
    let re_h1 = regex::Regex::new(r"(?m)^#\s+(.+)$").unwrap();
    text = re_h1.replace_all(&text, "<b>■ $1</b>").to_string();
    let re_h2 = regex::Regex::new(r"(?m)^##\s+(.+)$").unwrap();
    text = re_h2.replace_all(&text, "<b>◆ $1</b>").to_string();
    let re_h3 = regex::Regex::new(r"(?m)^#{3,6}\s+(.+)$").unwrap();
    text = re_h3.replace_all(&text, "<b>• $1</b>").to_string();

    // 7. Checklists
    let re_chk_done = regex::Regex::new(r"(?m)^[ \t]*[-*+][ \t]+\[[xX]\][ \t]+(.+)$").unwrap();
    text = re_chk_done.replace_all(&text, "  ✅ $1").to_string();
    let re_chk_open = regex::Regex::new(r"(?m)^[ \t]*[-*+][ \t]+\[[ \t]\][ \t]+(.+)$").unwrap();
    text = re_chk_open.replace_all(&text, "  🔲 $1").to_string();

    // 8. Bullet lists
    let re_bullet = regex::Regex::new(r"(?m)^[ \t]*[-*+][ \t]+(.+)$").unwrap();
    text = re_bullet.replace_all(&text, "  • $1").to_string();

    // 9. Blockquotes
    let re_quote = regex::Regex::new(r"(?m)^(?:&gt;|>)[ \t]*(.+)$").unwrap();
    text = re_quote
        .replace_all(&text, "<blockquote>$1</blockquote>")
        .to_string();
    text = text.replace("</blockquote>\n<blockquote>", "\n");

    // 10. Bold
    let re_bold = regex::Regex::new(r"\*\*([^\s*][^*]*?[^\s*]|[^\s*])\*\*").unwrap();
    text = re_bold.replace_all(&text, "<b>$1</b>").to_string();
    let re_bold_u = regex::Regex::new(r"__([^\s_][^_]*?[^\s_]|[^\s_])__").unwrap();
    text = re_bold_u.replace_all(&text, "<b>$1</b>").to_string();

    // 11. Italic
    let re_italic =
        regex::Regex::new(r"(^|[^\w])\*([^\s*][^*]*?[^\s*]|[^\s*])\*([^\w]|$)").unwrap();
    text = re_italic.replace_all(&text, "$1<i>$2</i>$3").to_string();
    let re_italic_u =
        regex::Regex::new(r"(^|[^\w])_([^\s_][^_]*?[^\s_]|[^\s_])_([^\w]|$)").unwrap();
    text = re_italic_u.replace_all(&text, "$1<i>$2</i>$3").to_string();

    // 12. Strikethrough
    let re_strike = regex::Regex::new(r"~~(.+?)~~").unwrap();
    text = re_strike.replace_all(&text, "<s>$1</s>").to_string();

    // 13. Links: [text](https://url)
    let re_link = regex::Regex::new(r"\[([^\]]+)\]\((https?://[^\s)]+)\)").unwrap();
    text = re_link
        .replace_all(&text, "<a href=\"$2\">$1</a>")
        .to_string();

    // 14. Restore code blocks & inline code
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
    let Some(m) = model else {
        return "default".to_string();
    };
    let id = m
        .get("id")
        .or_else(|| m.get("modelId"))
        .or_else(|| m.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("default");
    if let Some(prov) = m.get("provider").and_then(|v| v.as_str()) {
        format!("{prov}/{id}")
    } else {
        id.to_string()
    }
}

pub fn format_detailed_error(error: &str, stop_reason: Option<&str>) -> String {
    let raw = error.to_lowercase();
    let title: &str;
    let advice: &str;

    if raw.contains("429")
        || raw.contains("quota_exhausted")
        || raw.contains("resource_exhausted")
        || raw.contains("rate limit")
    {
        title = "⏳ <b>Batas Kuota / Rate Limit Tercapai (429)</b>";
        advice = "Kuota model ini habis atau terkena rate limit. Silakan beralih ke model lain via <b>🤖 Model</b> atau tunggu reset kuota.";
    } else if raw.contains("401")
        || raw.contains("unauthenticated")
        || raw.contains("invalid api key")
        || raw.contains("unauthorized")
    {
        title = "🔑 <b>Autentikasi Gagal (401)</b>";
        advice =
            "API Key provider tidak valid atau kadaluarsa. Periksa konfigurasi auth provider Anda.";
    } else if raw.contains("context") && (raw.contains("exceeded") || raw.contains("length"))
        || stop_reason == Some("maxTokens")
    {
        title = "📦 <b>Batas Konteks Penuh (Max Tokens)</b>";
        advice = "Panjang percakapan melebihi batas model. Gunakan perintah <b>/compact</b> atau buat sesi baru via <b>➕ New Session</b>.";
    } else if raw.contains("503")
        || raw.contains("500")
        || raw.contains("overloaded")
        || raw.contains("server error")
    {
        title = "💥 <b>Server Provider Overloaded (5xx)</b>";
        advice = "Server provider AI sedang down atau mengalami beban tinggi. Coba beralih ke provider cadangan via <b>🤖 Model</b>.";
    } else if raw.contains("400") || raw.contains("invalid_argument") || raw.contains("bad request")
    {
        title = "🚫 <b>Permintaan Tidak Valid (400)</b>";
        advice =
            "Parameter atau pesan tidak dapat diproses oleh model. Periksa kembali pesan Anda.";
    } else {
        title = "⚠️ <b>Error dari Model Provider</b>";
        advice = "Terjadi gangguan saat memproses balasan. Gunakan <b>🤖 Model</b> untuk mencoba model lain.";
    }

    format!(
        "{title}\n\n<code>{}</code>\n\n💡 <i>{}</i>",
        escape_html(error),
        advice
    )
}

pub fn format_session_item_label(
    session: &serde_json::Value,
    index: usize,
    is_current: bool,
) -> String {
    let marker = if is_current { "🟢 " } else { "" };
    let first_msg = session.get("firstMessage").and_then(|v| v.as_str());
    let title = if let Some(fm) = first_msg {
        let trimmed = fm.trim().replace('\n', " ");
        if trimmed.len() > 35 {
            format!("{}…", &trimmed[..32])
        } else {
            trimmed
        }
    } else if let Some(name) = session.get("name").and_then(|v| v.as_str()) {
        name.to_string()
    } else {
        let sid = session
            .get("id")
            .or_else(|| session.get("activeSessionId"))
            .and_then(|v| v.as_str())
            .unwrap_or("session");
        format!("Session {}", &sid[..sid.len().min(8)])
    };

    let folder = session
        .get("cwd")
        .and_then(|v| v.as_str())
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "~".to_string());

    format!("{marker}{}. {title} [{folder}]", index + 1)
}

pub fn format_message_for_chat(msg: &serde_json::Value) -> Option<String> {
    let role = msg
        .get("role")
        .or_else(|| msg.get("message").and_then(|m| m.get("role")))
        .and_then(|v| v.as_str())?;
    let content = msg
        .get("content")
        .or_else(|| msg.get("message").and_then(|m| m.get("content")))?;

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

    let icon = if role == "assistant" {
        "🤖 <b>Prime Agent</b>"
    } else {
        "👤 <b>User</b>"
    };
    Some(format!("{icon}:\n{}", markdown_to_telegram_html(&text)))
}

pub fn extract_assistant_pure_text(messages: &[serde_json::Value]) -> Option<String> {
    for m in messages.iter().rev() {
        let role = m
            .get("role")
            .or_else(|| m.get("message").and_then(|sub| sub.get("role")))
            .and_then(|v| v.as_str());
        if role == Some("assistant") {
            let content = m
                .get("content")
                .or_else(|| m.get("message").and_then(|sub| sub.get("content")));
            if let Some(text) = content.and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            } else if let Some(parts) = content.and_then(|v| v.as_array()) {
                let text_parts: Vec<&str> = parts
                    .iter()
                    .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .collect();
                if !text_parts.is_empty() {
                    return Some(text_parts.join("\n"));
                }
            }
        }
    }
    None
}
