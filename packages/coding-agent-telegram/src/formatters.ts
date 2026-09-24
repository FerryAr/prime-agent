const MAX_TELEGRAM_MESSAGE_LENGTH = 4000;

/**
 * Splits a long text message into chunks safe for Telegram (max 4096 chars).
 * Splits along line breaks when possible.
 */
export function splitMessage(text: string, maxLength: number = MAX_TELEGRAM_MESSAGE_LENGTH): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Find a newline within the budget
		let splitIndex = remaining.lastIndexOf("\n", maxLength);
		if (splitIndex < maxLength / 2) {
			// If no good newline, try space
			splitIndex = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitIndex <= 0) {
			// Hard split if no suitable whitespace
			splitIndex = maxLength;
		}

		chunks.push(remaining.slice(0, splitIndex).trimEnd());
		remaining = remaining.slice(splitIndex).trimStart();
	}

	return chunks;
}

export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function formatToolInvocation(name: string, args: Record<string, unknown> | undefined): string {
	if (name === "bash" && typeof args?.command === "string") {
		return `🔧 <b>bash:</b> <code>${escapeHtml(args.command.slice(0, 100))}</code>`;
	}
	if ((name === "read" || name === "write" || name === "edit") && typeof args?.path === "string") {
		return `📁 <b>${name}:</b> <code>${escapeHtml(args.path)}</code>`;
	}
	return `⚙️ <b>tool:</b> <code>${escapeHtml(name)}</code>`;
}

export function formatSessionSummary(session: {
	id: string;
	cwd?: string;
	model?: { provider: string; modelId: string };
	messageCount?: number;
}): string {
	const lines: string[] = [];
	lines.push(`🆔 <b>Session:</b> <code>${session.id.slice(0, 8)}</code>`);
	if (session.cwd) {
		lines.push(`📂 <b>Directory:</b> <code>${session.cwd}</code>`);
	}
	if (session.model) {
		lines.push(`🤖 <b>Model:</b> ${session.model.provider}/${session.model.modelId}`);
	}
	if (session.messageCount !== undefined) {
		lines.push(`💬 <b>Messages:</b> ${session.messageCount}`);
	}
	return lines.join("\n");
}



export function formatMessageForChat(msg: any): string | null {
	const role = msg.role ?? msg.message?.role;
	const timestamp = msg.timestamp ?? msg.message?.timestamp;
	const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";

	if (role === "user") {
		let text = "";
		const content = msg.content ?? msg.message?.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((p: any) => p && p.type === "text")
				.map((p: any) => p.text ?? "")
				.join("\n");
		}
		if (!text) return null;
		return `👤 <b>User</b> <i>(${timeStr})</i>:\n${markdownToTelegramHtml(text)}`;
	}

	if (role === "assistant") {
		let text = "";
		const content = msg.content ?? msg.message?.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((p: any) => p && p.type === "text")
				.map((p: any) => p.text ?? "")
				.join("\n");
		}
		if (!text) return null;
		return `🤖 <b>Prime Agent</b> <i>(${timeStr})</i>:\n${markdownToTelegramHtml(text)}`;
	}

	return null;
}

export function formatSessionItemLabel(session: any, index: number, isCurrent: boolean): string {
	const marker = isCurrent ? "🟢 " : "";
	const title = session.firstMessage?.trim()
		? session.firstMessage.trim().replace(/\s+/g, " ").slice(0, 35)
		: (session.name || `Session ${session.id.slice(0, 8)}`);
	const folder = session.cwd ? session.cwd.split("/").pop() || session.cwd : "";
	const date = session.modified ? new Date(session.modified).toLocaleDateString("id-ID", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

	return `${marker}${index + 1}. ${title} [${folder}] (${date})`;
}


/**
 * Converts standard Markdown from LLM replies into Telegram-compatible HTML.
 * Preserves code blocks (<pre><code>), inline code (<code>), bold (<b>),
 * italic (<i>), strikethrough (<s>), blockquotes (<blockquote>), and bullet lists.
 */
/**
 * Converts standard Markdown from LLM replies into beautiful, valid Telegram-compatible HTML.
 * Supports:
 * - Code blocks with syntax highlighting language (<pre><code class="language-xyz">)
 * - Inline code (<code>)
 * - Headers (# H1, ## H2, ### H3) converted to clean bold headings
 * - Bold (**bold** and __bold__)
 * - Italic (*italic* and _italic_)
 * - Strikethrough (~~del~~)
 * - Blockquotes (<blockquote>)
 * - Clean bullet lists (• item)
 * - Aesthetic horizontal dividers (──────────)
 * - Auto-collapse excessive blank lines
 */
function formatMarkdownTables(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let tableBuffer: string[] = [];

	const flushTable = () => {
		if (tableBuffer.length === 0) return;
		const rows: string[][] = [];
		for (const line of tableBuffer) {
			const trimmed = line.trim();
			if (/^\|[\s-:|]+\|$/.test(trimmed) || /^[\s-:|]+$/.test(trimmed)) continue;
			const cells = trimmed
				.split("|")
				.slice(1, -1)
				.map((c) => c.trim());
			if (cells.length > 0) rows.push(cells);
		}
		if (rows.length > 0) {
			const colCount = Math.max(...rows.map((r) => r.length));
			const colWidths = Array.from({ length: colCount }, (_, colIdx) =>
				Math.max(...rows.map((r) => (r[colIdx] ? r[colIdx].length : 0)), 3),
			);
			const formattedRows = rows.map((r) =>
				r.map((c, idx) => (c || "").padEnd(colWidths[idx] || 3, " ")).join(" │ "),
			);
			const divider = colWidths.map((w) => "─".repeat(w)).join("─┼─");
			const tableAscii = [formattedRows[0], divider, ...formattedRows.slice(1)].join("\n");
			output.push(`\n\`\`\`\n${tableAscii}\n\`\`\`\n`);
		}
		tableBuffer = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
			tableBuffer.push(line);
		} else {
			flushTable();
			output.push(line);
		}
	}
	flushTable();
	return output.join("\n");
}

export function markdownToTelegramHtml(markdown: string): string {
	if (!markdown) return "";

	// 1. Convert markdown tables into aligned fixed-width code blocks first
	let text = formatMarkdownTables(markdown);

	// 2. Normalize line endings and collapse excessive blank lines
	text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");

	// 3. Extract and protect code blocks (<pre><code class="...">)
	const codeBlocks: string[] = [];
	text = text.replace(/```([a-zA-Z0-9_+-]*)\s*\n?([\s\S]*?)```/g, (_, lang, code) => {
		const escapedCode = escapeHtml(code.trimEnd());
		const cleanLang = lang?.trim() ? ` class="language-${escapeHtml(lang.trim())}"` : "";
		const placeholder = `TGCODEBLOCK${codeBlocks.length}END`;
		codeBlocks.push(`<pre><code${cleanLang}>${escapedCode}</code></pre>`);
		return placeholder;
	});

	// 4. Extract and protect inline code (<code>)
	const inlineCodes: string[] = [];
	text = text.replace(/`([^`\n]+)`/g, (_, code) => {
		const placeholder = `TGINLINECODE${inlineCodes.length}END`;
		inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
		return placeholder;
	});

	// 5. Escape markup in non-code spans before injecting tags
	text = escapeHtml(text);

	// 6. Aesthetic horizontal rules: --- or *** or ___ -> ──────────────
	text = text.replace(/^(?:[-*_]){3,}\s*$/gm, "──────────────");

	// 7. Headings hierarchy
	text = text.replace(/^#\s+(.+)$/gm, "<b>■ $1</b>");
	text = text.replace(/^##\s+(.+)$/gm, "<b>◆ $1</b>");
	text = text.replace(/^#{3,6}\s+(.+)$/gm, "<b>• $1</b>");

	// 8. Checklists: - [x] -> ✅, - [ ] -> 🔲
	text = text.replace(/^[ \t]*[-*+][ \t]+\[[xX]\][ \t]+(.+)$/gm, "  ✅ $1");
	text = text.replace(/^[ \t]*[-*+][ \t]+\[[ \t]\][ \t]+(.+)$/gm, "  🔲 $1");

	// 9. Bullet lists: convert - item or * item to clean bullet • item
	text = text.replace(/^[ \t]*[-*+][ \t]+(.+)$/gm, "  • $1");

	// 10. Blockquotes: > quote -> <blockquote>quote</blockquote>
	text = text.replace(/^(?:&gt;|>)[ \t]*(.+)$/gm, "<blockquote>$1</blockquote>");
	text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");

	// 11. Bold: **text** or __text__ -> <b>text</b>
	text = text.replace(/\*\*([^\s*][^*]*?[^\s*]|[^\s*])\*\*/g, "<b>$1</b>");
	text = text.replace(/__([^\s_][^_]*?[^\s_]|[^\s_])__/g, "<b>$1</b>");

	// 12. Italic: *text* or _text_ -> <i>text</i>
	text = text.replace(/(^|[^\w])\*([^\s*][^*]*?[^\s*]|[^\s*])\*([^\w]|$)/g, "$1<i>$2</i>$3");
	text = text.replace(/(^|[^\w])_([^\s_][^_]*?[^\s_]|[^\s_])_([^\w]|$)/g, "$1<i>$2</i>$3");

	// 13. Strikethrough: ~~text~~ -> <s>text</s>
	text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// 14. Markdown Links: [text](url) -> <a href="url">text</a>
	text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

	// 15. Restore code blocks & inline code
	for (let i = 0; i < codeBlocks.length; i++) {
		text = text.replace(`TGCODEBLOCK${i}END`, codeBlocks[i]);
	}
	for (let i = 0; i < inlineCodes.length; i++) {
		text = text.replace(`TGINLINECODE${i}END`, inlineCodes[i]);
	}

	return text.trim();
}




export function formatModelIdentifier(model: any): string {
	if (!model) return "default";
	const id = model.id || model.modelId || model.name;
	if (model.provider) {
		return `${model.provider}/${id}`;
	}
	return id || "default";
}


export function formatDetailedError(error: any, stopReason?: string): string {
	const raw = typeof error === "string" ? error : JSON.stringify(error, null, 2);
	let title = "⚠️ <b>Error dari Model Provider</b>";
	let advice = "Gunakan tombol <b>🤖 Model</b> untuk beralih ke model lain.";

	if (raw.includes("429") || /QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|rate limit/i.test(raw)) {
		title = "⏳ <b>Batas Kuota / Rate Limit Tercapai (429)</b>";
		advice = "Kuota model ini habis atau terkena rate limit. Silakan beralih ke model lain via <b>🤖 Model</b> atau tunggu reset kuota.";
	} else if (raw.includes("401") || /UNAUTHENTICATED|invalid api key|unauthorized/i.test(raw)) {
		title = "🔑 <b>Autentikasi Gagal (401)</b>";
		advice = "API Key provider tidak valid atau kadaluarsa. Periksa konfigurasi auth provider Anda.";
	} else if (/context.*exceeded|maximum context length|too many tokens/i.test(raw) || stopReason === "maxTokens") {
		title = "📦 <b>Batas Konteks Penuh (Max Tokens)</b>";
		advice = "Panjang percakapan melebihi batas model. Gunakan tombol <b>/compact</b> atau buat sesi baru via <b>➕ New Session</b>.";
	} else if (raw.includes("503") || raw.includes("500") || /OVERLOADED|server error|internal error/i.test(raw)) {
		title = "💥 <b>Server Provider Overloaded (5xx)</b>";
		advice = "Server provider AI sedang down atau mengalami beban tinggi. Coba beralih ke provider cadangan via <b>🤖 Model</b>.";
	} else if (raw.includes("400") || /INVALID_ARGUMENT|bad request/i.test(raw)) {
		title = "🚫 <b>Argumen Tidak Valid (400)</b>";
		advice = "Request ditolak provider. Coba ulangi prompt dengan kalimat yang lebih sederhana atau ganti model.";
	} else if (stopReason === "aborted") {
		title = "🛑 <b>Tugas Dibatalkan</b>";
		advice = "Eksekusi dibatalkan oleh pengguna.";
	}

	return `${title}\n\n<code>${escapeHtml(raw.slice(0, 1500))}</code>\n\n💡 <i>${advice}</i>`;
}
