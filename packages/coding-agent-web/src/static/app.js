/* Prime Agent web client: chat + files/git/jobs panels over the Prime Agent web gateway. */
const $ = (id) => document.getElementById(id);

let token = new URLSearchParams(location.search).get("token") || localStorage.getItem("primeAgentToken") || "";
if (token) localStorage.setItem("primeAgentToken", token);
{
	const url = new URL(location.href);
	url.searchParams.delete("token");
	history.replaceState(null, "", url);
}

let meta = { cwd: "", home: "", authMode: "token", username: "local" };
let active = null; // { id, es, snapshotSequence }
let rosterEs = null;
let rosterReconnectTimer;
let rosterLastEventId = "";
let sessionReconnectTimer;
let sessionOpenSequence = 0;
let catalogSessions = [];
let rosterEntries = new Map();
let sidebarSignature = "";
let sidebarRefreshPromise = null;
let sidebarRefreshQueued = false;
let busy = false;
let lastSessionEventAt = Date.now();
let soundEnabled = localStorage.getItem("primeAgentSound") !== "0";
let run = null; // { assistant, thinking }
let activeRetry = null; // { attempt, maxAttempts, delayMs, errorMessage }
let activeGoal = null;
const dismissedGoals = new Set();
try {
	const stored = JSON.parse(localStorage.getItem("primeAgentDismissedGoals") || "[]");
	for (const id of stored) dismissedGoals.add(id);
} catch {}

function dismissGoalBanner() {
	if (activeGoal) {
		if (activeGoal.goalId) dismissedGoals.add(activeGoal.goalId);
		if (activeGoal.objective) dismissedGoals.add(activeGoal.objective);
		if (active) {
			if (active.id && activeGoal.goalId) dismissedGoals.add(`${active.id}:${activeGoal.goalId}`);
			if (active.id && activeGoal.objective) dismissedGoals.add(`${active.id}:${activeGoal.objective}`);
			if (active.sessionId && activeGoal.goalId) dismissedGoals.add(`${active.sessionId}:${activeGoal.goalId}`);
			if (active.sessionId && activeGoal.objective) dismissedGoals.add(`${active.sessionId}:${activeGoal.objective}`);
		}
		try {
			localStorage.setItem("primeAgentDismissedGoals", JSON.stringify([...dismissedGoals].slice(-200)));
		} catch {}
	}
	activeGoal = null;
	const banner = $("goalBanner");
	const chip = $("goalChip");
	if (banner) banner.classList.add("hidden");
	if (chip) chip.classList.add("hidden");
}

const previousSessionWorkingState = new Map();
const toolCards = new Map();
const sideCards = new Map();
const refinementCards = new Map();
const subagentCards = new Map();
let panelState = { tab: null, path: "", file: null, editing: false };
let cmdCache = new Map(); // sessionId -> commands[]
let cmdMenuState = { open: false, items: [], highlighted: -1 };
let modelCache = [];       // cached /api/models for the active session
const TRANSCRIPT_TURN_PAGE_SIZE = 25; // Number of conversational turns (user / assistant replies) to render per page
let fullSessionMessages = [];
let renderedTurnCount = 0;
let totalSessionTurns = 0;

function isConversationalTurn(message) {
	if (!message) return false;
	const role = message.role;
	if (role === "user") return true;
	if (role === "assistant") {
		const content = message.content;
		if (typeof content === "string" && content.trim()) return true;
		if (Array.isArray(content)) {
			const hasTool = content.some((part) => part && part.type === "toolCall");
			// An assistant message that only executes tools is an intermediate turn, not a final reply
			if (!hasTool) {
				for (const part of content) {
					if (part && part.type === "text" && part.text && part.text.trim()) return true;
				}
			}
		}
		return false;
	}
	if (role === "compactionSummary" || role === "branchSummary") return true;
	if (role === "custom") {
		const ct = message.customType;
		if (ct === "session_slash_command" || ct === "session_slash_command_result") return true;
	}
	return false;
}

function getTurnBoundaryIndices(messages) {
	const boundaries = [];
	for (let i = 0; i < messages.length; i++) {
		if (isConversationalTurn(messages[i])) boundaries.push(i);
	}
	return boundaries;
}
let modelMenuOpen = false;
let modelHighlight = -1;
let modelItems = [];

const transcript = $("transcript"), input = $("input");

// ---------------------------------------------------------------------------
// Markdown rendering (safe: DOM built with textContent, never innerHTML)
// ---------------------------------------------------------------------------

const INLINE_MD =
	/(\*\*\*(?!\s)((?:[^*]|\*(?!\*\*))+?)(?<!\s)\*\*\*)|(\*\*(?!\s)((?:[^*]|\*(?!\*))+?)(?<!\s)\*\*|__(?!\s)((?:[^_]|_(?!_))+?)(?<!\s)__)|(?:\*([^\s*](?:[^*]*?[^\s*])?)\*|\b_([^\s_](?:[^_]*?[^\s_])?)_\b)|(`([^`\n]+?)`)|(\[([^\]\n]+?)\]\((https?:\/\/[^)\s]+?)\))|(~~(?!\s)((?:[^~]|~(?!~))+?)(?<!\s)~~)|(https?:\/\/[^\s<>"')]+)|(\$((?!\$)[^\n$]+?)\$)/g;

function renderInline(parent, text) {
	if (!text) return;
	const regex = new RegExp(INLINE_MD.source, "g");
	let last = 0;
	let match;
	while ((match = regex.exec(text)) !== null) {
		if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
		if (match[1]) {
			const strong = el("strong", "");
			const em = el("em", "");
			renderInline(em, match[2]);
			strong.append(em);
			parent.append(strong);
		} else if (match[3]) {
			const strong = el("strong", "");
			renderInline(strong, match[4] || match[5]);
			parent.append(strong);
		} else if (match[6] !== undefined || match[7] !== undefined) {
			const em = el("em", "");
			renderInline(em, match[6] !== undefined ? match[6] : match[7]);
			parent.append(em);
		} else if (match[8]) {
			parent.append(el("code", "inline-code", match[9]));
		} else if (match[10]) {
			const anchor = document.createElement("a");
			anchor.href = match[12];
			anchor.target = "_blank";
			anchor.rel = "noopener noreferrer";
			renderInline(anchor, match[11]);
			parent.append(anchor);
		} else if (match[13]) {
			const del = el("del", "");
			renderInline(del, match[14]);
			parent.append(del);
		} else if (match[15]) {
			let url = match[15];
			let trailing = "";
			const trailMatch = url.match(/[.,;:!?)]+$/);
			if (trailMatch) {
				trailing = trailMatch[0];
				url = url.slice(0, -trailing.length);
			}
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.textContent = url;
			anchor.target = "_blank";
			anchor.rel = "noopener noreferrer";
			parent.append(anchor);
			if (trailing) parent.append(document.createTextNode(trailing));
		} else if (match[16]) {
			const mathText = match[17];
			const span = el("span", "math-inline");
			if (typeof katex !== "undefined" && typeof katex.renderToString === "function") {
				try {
					span.innerHTML = katex.renderToString(mathText, { displayMode: false, throwOnError: false });
				} catch {
					span.textContent = "$" + mathText + "$";
				}
			} else {
				span.textContent = "$" + mathText + "$";
			}
			parent.append(span);
		}
		last = regex.lastIndex;
	}
	if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function codeBlock(lang, code) {
	const wrap = el("div", "codeblock");
	const bar = el("div", "codebar");
	bar.append(el("span", "codelang", lang || "text"));
	const button = el("button", "copybtn", "Copy");
	button.onclick = () => {
		const onSuccess = () => {
			button.textContent = "Copied";
			setTimeout(() => { button.textContent = "Copy"; }, 1200);
		};
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(code).then(onSuccess).catch(fallback);
		} else {
			fallback();
		}
		function fallback() {
			try {
				const ta = document.createElement("textarea");
				ta.value = code;
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				document.body.append(ta);
				ta.focus();
				ta.select();
				document.execCommand("copy");
				ta.remove();
				onSuccess();
			} catch {
				button.textContent = "Error";
				setTimeout(() => { button.textContent = "Copy"; }, 1200);
			}
		}
	};
	bar.append(button);
	const pre = el("pre");
	pre.append(el("code", "", code));
	wrap.append(bar, pre);
	return wrap;
}

function isTableSeparator(line) {
	return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("|");
}

function splitTableRow(line) {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
	const cells = [];
	let current = "";
	let inCode = false;
	let escaped = false;
	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (escaped) {
			current += char;
			escaped = false;
		} else if (char === "\\") {
			escaped = true;
			current += char;
		} else if (char === "`") {
			inCode = !inCode;
			current += char;
		} else if (char === "|" && !inCode) {
			cells.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	cells.push(current.trim());
	return cells;
}

try {
	if (typeof marked !== "undefined" && typeof markedKatex !== "undefined") {
		marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
	}
} catch (e) {
	console.warn("Failed to initialize marked-katex extension:", e);
}

function renderMarkdown(raw) {
	if (typeof raw !== "string") raw = String(raw ?? "");
	if (!raw.trim()) return document.createDocumentFragment();

	// Primary modern pipeline: marked + KaTeX extension
	if (typeof marked !== "undefined" && typeof marked.parse === "function" && typeof document !== "undefined" && typeof document.createElement === "function") {
		try {
			const template = document.createElement("template");
			if (template.content) {
				template.innerHTML = marked.parse(raw);
				// Wrap code blocks with copy bar and styled header
				for (const pre of template.content.querySelectorAll("pre")) {
					if (pre.parentElement && pre.parentElement.classList.contains("codeblock")) continue;
					const code = pre.querySelector("code");
					const langMatch = (code?.className || "").match(/language-(\S+)/);
					const lang = langMatch ? langMatch[1] : "";
					const codeText = pre.textContent || "";
					const enhanced = codeBlock(lang, codeText);
					pre.replaceWith(enhanced);
				}

				// Wrap tables with horizontal scroll container and apply styling classes
				for (const table of template.content.querySelectorAll("table")) {
					if (!table.parentElement || !table.parentElement.classList.contains("md-table-wrap")) {
						table.classList.add("md-table");
						for (const th of table.querySelectorAll("th")) th.classList.add("md-th");
						for (const td of table.querySelectorAll("td")) td.classList.add("md-td");
						const wrap = el("div", "md-table-wrap");
						table.replaceWith(wrap);
						wrap.append(table);
					}
				}

				return template.content;
			}
		} catch (err) {
			console.warn("marked.parse error, falling back to internal parser:", err);
		}
	}

	const fragment = document.createDocumentFragment();
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	let index = 0;

	const flushParagraph = (buffer) => {
		if (buffer.length === 0) return;
		const paragraph = el("p", "md-p");
		renderInline(paragraph, buffer.join("\n"));
		fragment.append(paragraph);
		buffer.length = 0;
	};

	const paragraphBuffer = [];
	while (index < lines.length) {
		const line = lines[index];

		if (line.trim() === "") { flushParagraph(paragraphBuffer); index += 1; continue; }

		if (/^\s*\$\$/.test(line)) {
			flushParagraph(paragraphBuffer);
			const mathLines = [];
			const trimmed = line.trim();
			if (trimmed.length > 2 && trimmed.endsWith("$$")) {
				// Single-line block math: $$...$$
				mathLines.push(trimmed.slice(2, -2).trim());
				index += 1;
			} else {
				// Multi-line block math
				const firstLineRest = trimmed.slice(2).trim();
				if (firstLineRest) mathLines.push(firstLineRest);
				index += 1;
				while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
					mathLines.push(lines[index]);
					index += 1;
				}
				if (index < lines.length) index += 1;
			}
			const mathCode = mathLines.join("\n").trim();
			const mathNode = el("div", "math-block");
			if (typeof katex !== "undefined" && typeof katex.renderToString === "function") {
				try {
					mathNode.innerHTML = katex.renderToString(mathCode, { displayMode: true, throwOnError: false });
				} catch {
					mathNode.textContent = "$$" + mathCode + "$$";
				}
			} else {
				mathNode.textContent = "$$" + mathCode + "$$";
			}
			fragment.append(mathNode);
			continue;
		}

		const fence = line.match(/^ {0,3}```\s*(\S*)/);
		if (fence) {
			flushParagraph(paragraphBuffer);
			const code = [];
			index += 1;
			while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index])) {
				code.push(lines[index]);
				index += 1;
			}
			if (index < lines.length) index += 1;
			const lang = (fence[1] ?? "").toLowerCase();
			fragment.append(codeBlock(lang, code.join("\n")));
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushParagraph(paragraphBuffer);
			const level = String(Math.min(heading[1].length + 1, 6));
			const node = el(`h${level}`, "md-h");
			renderInline(node, heading[2]);
			fragment.append(node);
			index += 1;
			continue;
		}

		if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
			flushParagraph(paragraphBuffer);
			fragment.append(el("hr", "md-hr"));
			index += 1;
			continue;
		}

		if (/^\s*>/.test(line)) {
			flushParagraph(paragraphBuffer);
			const quote = el("blockquote", "md-quote");
			const quoteLines = [];
			while (index < lines.length && /^\s*>/.test(lines[index])) {
				quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
				index += 1;
			}
			for (let qIdx = 0; qIdx < quoteLines.length; qIdx++) {
				if (qIdx > 0) quote.append(el("br"));
				renderInline(quote, quoteLines[qIdx]);
			}
			fragment.append(quote);
			continue;
		}

		const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
		const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
		if (bullet || ordered) {
			flushParagraph(paragraphBuffer);
			const parseList = (startIndex) => {
				let curIdx = startIndex;
				const startLine = lines[curIdx];
				const initialIndent = startLine.match(/^(\s*)/)[1].length;
				const isOrdered = /^\s*\d+[.)]\s+/.test(startLine);
				const list = el(isOrdered ? "ol" : "ul", "md-list");
				if (isOrdered) {
					const startMatch = startLine.match(/^\s*(\d+)[.)]\s+/);
					const startNum = startMatch ? parseInt(startMatch[1], 10) : 1;
					if (Number.isFinite(startNum) && startNum !== 1) list.start = startNum;
				}

				let currentLi = null;
				let hadBlank = false;

				while (curIdx < lines.length) {
					const curLine = lines[curIdx];

					if (curLine.trim() === "") {
						let nextIdx = curIdx + 1;
						while (nextIdx < lines.length && lines[nextIdx].trim() === "") nextIdx += 1;
						if (nextIdx < lines.length) {
							const nextLine = lines[nextIdx];
							const nextIndent = nextLine.match(/^(\s*)/)[1].length;
							const nextIsItem = /^\s*(\d+[.)]|[-*+])\s+/.test(nextLine);
							if (nextIndent >= initialIndent && (nextIsItem || nextIndent > initialIndent)) {
								hadBlank = true;
								curIdx = nextIdx;
								continue;
							}
						}
						break;
					}

					const indent = curLine.match(/^(\s*)/)[1].length;
					if (indent < initialIndent) break;

					if (indent > initialIndent && /^\s*(\d+[.)]|[-*+])\s+/.test(curLine)) {
						if (currentLi) {
							const sub = parseList(curIdx);
							currentLi.append(sub.node);
							curIdx = sub.nextIndex;
							hadBlank = false;
							continue;
						}
					}

					const itemMatch = isOrdered
						? curLine.match(/^\s*\d+[.)]\s+(.*)$/)
						: curLine.match(/^\s*[-*+]\s+(.*)$/);

					if (itemMatch && indent <= initialIndent + 1) {
						currentLi = el("li", "md-li");
						const itemText = itemMatch[1];
						const task = itemText.match(/^\[([ xX])\]\s+(.*)$/);
						if (task) {
							const box = el("input");
							box.type = "checkbox";
							box.disabled = true;
							box.checked = task[1].toLowerCase() === "x";
							currentLi.classList.add("md-task");
							currentLi.append(box, " ");
							renderInline(currentLi, task[2]);
						} else {
							renderInline(currentLi, itemText);
						}
						list.append(currentLi);
						curIdx += 1;
						hadBlank = false;
						continue;
					}

					if (indent > initialIndent && currentLi) {
						if (hadBlank) {
							currentLi.append(el("br"));
							hadBlank = false;
						}
						currentLi.append(" ");
						renderInline(currentLi, curLine.trim());
						curIdx += 1;
						continue;
					}

					break;
				}

				return { node: list, nextIndex: curIdx };
			};

			const parsed = parseList(index);
			fragment.append(parsed.node);
			index = parsed.nextIndex;
			continue;
		}

		if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
			flushParagraph(paragraphBuffer);
			const header = splitTableRow(line);
			const sepCells = splitTableRow(lines[index + 1]);
			const alignments = sepCells.map((c) => {
				const t = (c ?? "").trim();
				if (t.startsWith(":") && t.endsWith(":")) return "center";
				if (t.endsWith(":")) return "right";
				if (t.startsWith(":")) return "left";
				return "";
			});
			index += 2;
			const table = el("table", "md-table");
			const head_ = el("tr", "md-tr-head");
			for (let c = 0; c < header.length; c++) {
				const th = el("th", "md-th");
				if (alignments[c]) { if (th.style) th.style.textAlign = alignments[c]; th.align = alignments[c]; }
				renderInline(th, header[c]);
				head_.append(th);
			}
			table.append(head_);
			while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
				const row = el("tr", "md-tr");
				const cells = splitTableRow(lines[index]);
				for (let c = 0; c < header.length; c++) {
					const td = el("td", "md-td");
					if (alignments[c]) { if (td.style) td.style.textAlign = alignments[c]; td.align = alignments[c]; }
					renderInline(td, cells[c] ?? "");
					row.append(td);
				}
				table.append(row);
				index += 1;
			}
			const tableWrap = el("div", "md-table-wrap");
			tableWrap.append(table);
			fragment.append(tableWrap);
			continue;
		}

		paragraphBuffer.push(line);
		index += 1;
	}
	flushParagraph(paragraphBuffer);
	return fragment;
}

function renderMarkdownInto(node, raw) {
	const footer = node.querySelector(".msg-footer") || node.querySelector(".user-msg-footer") || node.querySelector(".msg-time");
	node.replaceChildren(renderMarkdown(raw));
	if (footer) node.append(footer);
}

const COPY_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

async function copyTextToClipboard(text, button, defaultLabel = "Copy") {
	try {
		if (navigator?.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		} else {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			ta.remove();
		}
		if (button) {
			button.classList.add("copied");
			const span = button.querySelector("span");
			if (span) span.textContent = "Copied!";
			setTimeout(() => {
				button.classList.remove("copied");
				if (span) span.textContent = defaultLabel;
			}, 1500);
		}
	} catch (err) {
		console.error("Failed to copy:", err);
	}
}

function createCopyButton(getText) {
	const btn = el("button", "msg-action-btn copy-btn");
	btn.type = "button";
	btn.title = "Copy text to clipboard";
	btn.innerHTML = `${COPY_SVG} <span>Copy</span>`;
	btn.onclick = async (e) => {
		e.stopPropagation();
		const text = typeof getText === "function" ? getText() : (getText || "");
		if (!text) return;
		await copyTextToClipboard(text, btn, "Copy");
	};
	return btn;
}

function attachMessageFooter(bubble, getText, timestamp = Date.now(), extraActions = [], ttftMs = 0) {
	let footer = bubble.querySelector(".msg-footer") || bubble.querySelector(".user-msg-footer");
	if (!footer) {
		footer = el("div", bubble.classList.contains("user") ? "msg-footer user-msg-footer" : "msg-footer");
		bubble.append(footer);
	} else {
		footer.replaceChildren();
	}
	const actions = el("div", "msg-actions");
	actions.append(createCopyButton(getText));
	const effectiveTtft = Number(ttftMs || bubble?.dataset?.ttft || 0);
	if (effectiveTtft > 0) {
		const label = effectiveTtft >= 1000 ? `${(effectiveTtft / 1000).toFixed(1)}s` : `${Math.round(effectiveTtft)}ms`;
		const ttftBadge = el("span", "msg-action-badge ttft", `⚡ ${label}`);
		ttftBadge.title = `Response latency / TTFT: ${Math.round(effectiveTtft)}ms`;
		actions.append(ttftBadge);
	}
	for (const act of extraActions) {
		if (act) actions.append(act);
	}
	footer.append(actions);
	addTimestamp(footer, timestamp);
	return footer;
}

function timestampDate(value) {
	const date = value instanceof Date ? value : new Date(value ?? Date.now());
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function formatRelativeTime(value) {
	const seconds = Math.max(0, Math.floor((Date.now() - value.getTime()) / 1000));
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
	return value.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function addTimestamp(node, value) {
	const date = timestampDate(value);
	const time = el("time", "msg-time", date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
	time.dateTime = date.toISOString();
	time.title = date.toLocaleString();
	node.append(time);
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function parseDetailedError(error, stopReason) {
	let raw = "";
	if (typeof error === "string") {
		raw = error;
	} else if (error && typeof error === "object") {
		raw = error.message || error.error || JSON.stringify(error, null, 2);
	} else {
		raw = String(error || "Unknown error");
	}

	let title = "Error dari Model Provider";
	let advice = "Gunakan menu Model untuk beralih ke model atau provider lain.";
	let icon = "⚠️";

	if (raw.includes("429") || /QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|rate limit/i.test(raw)) {
		title = "Batas Kuota / Rate Limit Tercapai (429)";
		advice = "Kuota model ini habis atau terkena pembatasan rate limit. Beralih ke model lain via menu Model atau tunggu reset kuota.";
		icon = "⏳";
	} else if (raw.includes("401") || /UNAUTHENTICATED|invalid api key|unauthorized/i.test(raw)) {
		title = "Autentikasi Gagal (401)";
		advice = "API Key provider tidak valid atau kadaluarsa. Periksa kredensial provider AI Anda di pengaturan.";
		icon = "🔑";
	} else if (/context.*exceeded|maximum context length|too many tokens/i.test(raw) || stopReason === "maxTokens") {
		title = "Batas Konteks Penuh (Max Tokens)";
		advice = "Panjang percakapan melebihi batas model. Gunakan tombol Compact atau buat sesi baru.";
		icon = "📦";
	} else if (raw.includes("503") || raw.includes("500") || /OVERLOADED|server error|internal error/i.test(raw)) {
		title = "Server Provider Overloaded (5xx)";
		advice = "Server provider AI sedang down atau mengalami beban tinggi. Coba beralih ke provider cadangan.";
		icon = "💥";
	} else if (raw.includes("400") || /INVALID_ARGUMENT|bad request/i.test(raw)) {
		title = "Argumen Tidak Valid (400)";
		advice = "Request ditolak provider. Coba ulangi prompt dengan kalimat yang lebih sederhana atau ganti model.";
		icon = "🚫";
	} else if (/failed to fetch|network error|connection error|fetch failed/i.test(raw)) {
		title = "Koneksi Provider Terputus";
		advice = "Tidak dapat tersambung ke endpoint API provider. Periksa jaringan internet atau reverse proxy Anda.";
		icon = "🌐";
	} else if (stopReason === "aborted") {
		title = "Tugas Dibatalkan";
		advice = "Eksekusi giliran dibatalkan oleh pengguna.";
		icon = "🛑";
	}
	return { title, advice, raw, icon };
}

function createErrorCard(error, stopReason) {
	const { title, advice, raw, icon } = parseDetailedError(error, stopReason);
	const card = el("div", "card error-card");
	const header = el("div", "error-card-header");
	const iconEl = el("span", "error-card-icon", icon);
	const titleEl = el("b", "error-card-title", title);
	header.append(iconEl, titleEl);

	const details = el("pre", "error-card-details");
	const code = el("code", "", raw.length > 2500 ? raw.slice(0, 2500) + "... [truncated]" : raw);
	details.append(code);

	const adviceEl = el("div", "error-card-advice");
	const em = el("i", "", advice);
	adviceEl.append("💡 ", em);

	card.append(header, details, adviceEl);
	return card;
}

function formatDisplayPath(pathStr) {
	if (!pathStr) return "";
	const home = meta.home || "";
	let normalized = pathStr;
	if (home && (normalized === home || normalized.startsWith(home + "/"))) {
		normalized = "~" + normalized.slice(home.length);
	}
	return normalized;
}

function formatCwdTail(pathStr) {
	if (!pathStr) return "";
	const formatted = formatDisplayPath(pathStr);
	if (formatted === "~") return "~";
	const parts = formatted.split("/").filter(Boolean);
	if (parts.length <= 2) return formatted;
	return parts.slice(-2).join("/");
}

function fmtBytes(size) {
	if (size === undefined) return "";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokens(tokens) {
	const count = Number(tokens ?? 0);
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count >= 1_000_000_000) {
		const b = count / 1_000_000_000;
		const val = b < 10 ? b.toFixed(2) : b.toFixed(1);
		return (val.includes(".") ? val.replace(/0+$/, "").replace(/\.$/, "") : val) + "b";
	}
	if (count >= 1_000_000) {
		const m = count / 1_000_000;
		const val = m < 10 ? m.toFixed(2) : m.toFixed(1);
		return (val.includes(".") ? val.replace(/0+$/, "").replace(/\.$/, "") : val) + "m";
	}
	if (count >= 1_000) {
		const k = count / 1_000;
		const val = k < 10 ? k.toFixed(2) : k.toFixed(1);
		return (val.includes(".") ? val.replace(/0+$/, "").replace(/\.$/, "") : val) + "k";
	}
	return String(Math.round(count));
}

async function api(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: { "content-type": "application/json", "x-prime-agent-token": token, ...(options.headers ?? {}) },
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		if (res.status === 401 && body.auth === "password") showLogin();
		throw new Error(body.message ?? `HTTP ${res.status}`);
	}
	return body;
}

let stickToBottom = true;

function nearBottom() {
	return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}

function updateJumpBtn() {
	$("jumpBtn").classList.toggle("hidden", stickToBottom || transcript.scrollHeight <= transcript.clientHeight + 40);
}

function scroll(force = false) {
	if (force) stickToBottom = true;
	if (stickToBottom) {
		transcript.scrollTop = transcript.scrollHeight;
		// Double-requestAnimationFrame to handle any late font/layout repaints
		if (force && typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => {
				transcript.scrollTop = transcript.scrollHeight;
				requestAnimationFrame(() => {
					transcript.scrollTop = transcript.scrollHeight;
					updateJumpBtn();
				});
			});
		}
	}
	updateJumpBtn();
}

transcript.addEventListener(
	"scroll",
	() => {
		stickToBottom = nearBottom();
		updateJumpBtn();
	},
	{ passive: true },
);

$("jumpBtn").addEventListener("click", () => scroll(true));

// ---------------------------------------------------------------------------
// Login (users auth mode)
// ---------------------------------------------------------------------------

function showLogin() {
	$("loginOverlay").classList.remove("hidden");
}

$("loginForm").addEventListener("submit", async (event) => {
	event.preventDefault();
	$("loginError").textContent = "";
	try {
		const res = await fetch("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: $("loginPass").value }),
		});
		if (!res.ok) throw new Error("Invalid password");
		location.reload();
	} catch (error) {
		$("loginError").textContent = error.message;
	}
});

$("logoutBtn").addEventListener("click", async () => {
	await fetch("/api/logout", { method: "POST" }).catch(() => {});
	location.reload();
});

// ---------------------------------------------------------------------------
// Generic modal
// ---------------------------------------------------------------------------

function openModal({ title, message, build, wide = false, className = "" }) {
	const overlay = $("dialogOverlay");
	const dialog = overlay.querySelector(".dialog");
	$("dialogTitle").textContent = title;
	$("dialogMessage").textContent = message ?? "";
	const body = $("dialogBody"), actions = $("dialogActions");
	body.replaceChildren();
	actions.replaceChildren();
	if (dialog) {
		dialog.classList.toggle("dialog-wide", Boolean(wide));
		if (className) dialog.classList.add(...className.split(" ").filter(Boolean));
	}
	const onKey = (event) => {
		if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
	};
	const close = () => {
		overlay.classList.add("hidden");
		if (dialog) {
			dialog.classList.remove("dialog-wide");
			if (className) dialog.classList.remove(...className.split(" ").filter(Boolean));
		}
		document.removeEventListener("keydown", onKey);
	};
	document.addEventListener("keydown", onKey);
	overlay.onclick = (event) => {
		if (event.target === overlay) close();
	};
	build(body, actions, close);
	if (!actions.querySelector("#dialogCancel") && !actions.querySelector(".dialog-close-btn")) {
		const cancel = el("button", "", "Cancel");
		cancel.id = "dialogCancel";
		cancel.onclick = close;
		actions.append(cancel);
	}
	overlay.classList.remove("hidden");
	return close;
}

// ---------------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------------

function setBusy(value) {
	busy = value;
	$("busy").classList.toggle("hidden", !value);
	$("stopBtn").disabled = !value || !active;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part === "string" ? part : part && part.type === "text" ? part.text ?? "" : "")).join("");
}

let typingEl = null;

function showTyping(label) {
	if (!typingEl) {
		typingEl = el("div", "bubble assistant typing");
		typingEl.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
	}
	let labelEl = typingEl.querySelector(".typing-label");
	if (label) {
		if (!labelEl) {
			labelEl = el("span", "typing-label");
			typingEl.append(labelEl);
		}
		labelEl.textContent = label;
	} else if (labelEl) {
		labelEl.remove();
	}
	if (typingEl.parentElement !== transcript) transcript.append(typingEl);
	scroll();
}

function hideTyping() {
	typingEl?.remove();
	typingEl = null;
}

// Keep the dots pinned to the bottom without moving them: new elements are
// inserted BEFORE the dots, so the dots element is never re-appended and its
// CSS animation never restarts (no flicker).
let activeMountTarget = null; // When set (e.g. during loadEarlierMessages), appendNode redirects here

function appendNode(node) {
	if (activeMountTarget) {
		activeMountTarget.append(node);
		return;
	}
	if (typingEl && typingEl.parentElement === transcript) transcript.insertBefore(node, typingEl);
	else transcript.append(node);
}

// --- finish chime + browser notification ----------------------------------
let audioCtx = null;
let doneAudioBuffer = null;
let doneAudioLoading = false;
let lastStopAt = 0;

const DONE_SOUND_URL = "/sounds/agent-done.mp3";

async function loadDoneAudioBuffer() {
	if (doneAudioBuffer || doneAudioLoading || !audioCtx) return;
	doneAudioLoading = true;
	try {
		const res = await fetch(DONE_SOUND_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const arrayBuf = await res.arrayBuffer();
		doneAudioBuffer = await audioCtx.decodeAudioData(arrayBuf);
	} catch (error) {
		console.warn("Prime Agent web: could not load/decode MP3 finish sound, chime will be used:", error);
	} finally {
		doneAudioLoading = false;
	}
}

function ensureAudio() {
	try {
		if (!audioCtx) {
			const Ctx = window.AudioContext ?? window.webkitAudioContext;
			if (!Ctx) return;
			audioCtx = new Ctx();
		}
		if (audioCtx.state === "suspended") {
			audioCtx.resume().catch(() => undefined);
		}
		if (!doneAudioBuffer && !doneAudioLoading) {
			void loadDoneAudioBuffer();
		}
	} catch {}
}

/** Play the finish sound: decoded MP3 buffer first, synthesized chime or HTML5 Audio as instant fallback. */
function playDoneSound() {
	if (!soundEnabled) return;
	try {
		ensureAudio();
		const playHtmlAudio = () => {
			try {
				const a = new Audio(DONE_SOUND_URL);
				a.volume = 1.0;
				a.play().catch(() => playChime());
			} catch {
				playChime();
			}
		};

		if (!audioCtx) {
			playHtmlAudio();
			return;
		}

		const play = () => {
			if (doneAudioBuffer) {
				try {
					const source = audioCtx.createBufferSource();
					source.buffer = doneAudioBuffer;
					const gain = audioCtx.createGain();
					gain.gain.value = 1.0;
					source.connect(gain);
					gain.connect(audioCtx.destination);
					source.start(0);
					return;
				} catch (err) {
					console.warn("Prime Agent web: buffer playback failed, falling back to chime:", err);
				}
			}
			playHtmlAudio();
		};

		if (audioCtx.state === "suspended") {
			audioCtx.resume().then(play).catch(playHtmlAudio);
		} else {
			play();
		}
	} catch (error) {
		console.warn("Prime Agent web: playDoneSound error:", error);
		playChime();
	}
}

// Hard finish alert: two quick A5 blips into a loud E6 sting. Triangle cores for
// brightness, fast 6 ms attacks, high gain — cuts through without an asset file.
function playChime() {
	if (!soundEnabled) return;
	ensureAudio();
	if (!audioCtx) return;

	const runChime = () => {
		try {
			const t0 = audioCtx.currentTime + 0.02;
			// Compressor as a limiter: hot input levels stay loud without clipping.
			const limiter = audioCtx.createDynamicsCompressor();
			limiter.threshold.value = -10;
			limiter.knee.value = 6;
			limiter.ratio.value = 6;
			limiter.attack.value = 0.003;
			limiter.release.value = 0.1;
			limiter.connect(audioCtx.destination);
			const master = audioCtx.createGain();
			master.gain.value = 1;
			master.connect(limiter);
			const voice = (freq, start, dur, peak, type) => {
				const osc = audioCtx.createOscillator();
				const gain = audioCtx.createGain();
				osc.type = type;
				osc.frequency.value = freq;
				gain.gain.setValueAtTime(0.0001, t0 + start);
				gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.004);
				gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
				osc.connect(gain);
				gain.connect(master);
				osc.start(t0 + start);
				osc.stop(t0 + start + dur);
			};
			const blip = (freq, start) => {
				voice(freq, start, 0.11, 0.55, "triangle");
				voice(freq * 2, start, 0.09, 0.28, "sine");
				voice(freq, start, 0.09, 0.16, "square");
			};
			blip(880, 0);
			blip(880, 0.16);
			voice(1318.51, 0.34, 0.5, 0.6, "triangle");
			voice(2637.02, 0.34, 0.34, 0.3, "sine");
			voice(659.26, 0.34, 0.24, 0.2, "square");
		} catch {}
	};

	if (audioCtx.state === "suspended") {
		audioCtx.resume().then(runChime).catch(runChime);
	} else {
		runChime();
	}
}

const NOTIFICATION_ICON =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#58d5a9"/><stop offset="1" stop-color="#4c8dff"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#10151c"/><path d="M32 12 L52 32 L32 52 L12 32 Z" fill="url(#g)"/></svg>',
	);

function showToast(title, body, kind) {
	try {
		document.querySelectorAll(".toast").forEach((t) => t.remove());
		const toast = el("div", "toast" + (kind === "error" ? " error" : ""));
		toast.append(el("b", "", title));
		if (body) toast.append(el("p", "", body));
		toast.onclick = () => toast.remove();
		document.body.append(toast);
		setTimeout(() => toast.remove(), kind === "error" ? 8000 : 6000);
	} catch {}
}

async function notifyViaBrowser(body, title = "Agent finished") {
	try {
		if ("serviceWorker" in navigator) {
			const registration = await navigator.serviceWorker.getRegistration();
			if (registration) {
				await registration.showNotification(title, {
					body,
					icon: NOTIFICATION_ICON,
					tag: "prime-agent-done",
				});
				return;
			}
		}
		const n = new Notification(title, {
			body,
			icon: NOTIFICATION_ICON,
			tag: "prime-agent-done",
		});
		n.onclick = () => {
			window.focus();
			n.close();
		};
		return;
	} catch {}
	showToast(title, body);
}

function notifyDone(text, title) {
	playDoneSound();
	const label = title || $("title").textContent || "Prime Agent";
	const snippet = (text ?? "").trim().replace(/\s+/g, " ").slice(0, 140);
	const body = snippet ? (title ? snippet : `${label}\n${snippet}`) : label;
	const toastTitle = title || "Agent finished";
	try {
		if ("Notification" in window && Notification.permission === "granted") {
			void notifyViaBrowser(body, toastTitle);
			return;
		}
	} catch {}
	// Insecure origin (plain HTTP over LAN) or permission missing: browser
	// notifications are unavailable there — show the in-app toast instead.
	showToast(toastTitle, body);
	if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
		console.info("Prime Agent web: browser notifications need HTTPS or localhost; showing in-app toast instead.");
	}
}

// Keep the AudioContext unlocked: browsers only allow audio after a gesture.
// Cover keyboard, pointer, touch, and click.
document.addEventListener("pointerdown", ensureAudio, { capture: true, passive: true });
document.addEventListener("keydown", ensureAudio, { capture: true, passive: true });
document.addEventListener("touchstart", ensureAudio, { capture: true, passive: true });
document.addEventListener("click", ensureAudio, { capture: true, passive: true });

// Service worker notifications: on Android these play the system notification
// sound and show on the lock screen — page-level Notification() is silent there.
if ("serviceWorker" in navigator && window.isSecureContext) {
	navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

function assistantBubble() {
	hideTyping();
	if (!run?.assistant) {
		const bubble = el("div", "bubble assistant md");
		if (typeof attachMessageFooter === "function") {
			attachMessageFooter(bubble, () => run?.assistantRaw || bubble.innerText || "", Date.now());
		} else if (typeof addTimestamp === "function") {
			addTimestamp(bubble);
		}
		appendNode(bubble);
		if (run) {
			run.assistant = bubble;
			run.assistantRaw = "";
			run.renderedAt = 0;
		}
		scroll();
		return bubble;
	}
	return run.assistant;
}

function appendAssistantDelta(delta) {
	const state = ensureRun();
	if (!state.firstTokenAt && state.startedAt) {
		state.firstTokenAt = Date.now();
		state.ttftMs = Math.max(1, state.firstTokenAt - state.startedAt);
	}
	const bubble = assistantBubble();
	if (state.ttftMs) bubble.dataset.ttft = String(state.ttftMs);
	bubble.classList.add("streaming");
	state.assistantRaw += delta ?? "";
	const now = Date.now();
	if (now - state.renderedAt > 90 || !state.streamingRendered) {
		state.renderedAt = now;
		state.streamingRendered = true;
		renderMarkdownInto(bubble, state.assistantRaw);
		if (typeof speedDisplayEnabled !== "undefined" && speedDisplayEnabled && state.startedAt && state.assistantRaw.length > 20 && typeof renderSpeedChip === "function") {
			const estTokens = Math.max(1, Math.round(state.assistantRaw.length / 4));
			const durationSec = Math.max(0.1, (now - state.startedAt) / 1000);
			renderSpeedChip(estTokens / durationSec);
		}
		scroll();
	}
}

function flushAssistantMarkdown() {
	if (!run?.assistant) return;
	run.assistant.classList.remove("streaming");
	if (run.ttftMs) run.assistant.dataset.ttft = String(run.ttftMs);
	renderMarkdownInto(run.assistant, run.assistantRaw);
	if (typeof attachMessageFooter === "function") {
		attachMessageFooter(run.assistant, () => run.assistantRaw, Date.now(), [], run.ttftMs);
	}
	scroll();
}

let toolPaintQueued = false;

function queueToolPaint() {
	if (toolPaintQueued) return;
	toolPaintQueued = true;
	requestAnimationFrame(() => {
		toolPaintQueued = false;
		for (const card of toolCards.values()) {
			if (card.pending) {
				card.out.textContent += card.pending;
				card.pending = "";
			}
		}
		scroll();
	});
}

let thinkingPaintQueued = false;

function queueThinkingPaint() {
	if (thinkingPaintQueued) return;
	thinkingPaintQueued = true;
	requestAnimationFrame(() => {
		thinkingPaintQueued = false;
		if (!run?.thinking || !run.thinkingText) {
			run && (run.thinkingPending = "");
			return;
		}
		if (run.thinkingPending) {
			run.thinkingText.data += run.thinkingPending;
			run.thinkingPending = "";
		}
		scroll();
	});
}

function thinkingBlock() {
	if (!run?.thinking) {
		const block = el("div", "thinking md");
		addTimestamp(block);
		appendNode(block);
		if (run) {
			run.thinking = block;
			run.thinkingRaw = "";
			run.thinkingRenderedAt = 0;
		}
		scroll();
		return block;
	}
	return run.thinking;
}

function closeThinking() {
	if (!run?.thinking) return;
	if (run.thinkingRaw) renderMarkdownInto(run.thinking, run.thinkingRaw);
	else run.thinking.remove?.();
	run.thinking = null;
	run.thinkingRaw = "";
	run.thinkingRenderedAt = 0;
	run.thinkingText = null;
	run.thinkingPending = "";
	if (run) run.assistant = null;
}

function toolGlyph(toolName) {
	const name = (toolName ?? "").toLowerCase();
	if (name === "ipython" || name === "jupyter") return "Py";
	if (name === "bash" || name === "sh") return ">_";
	if (name === "edit") return "✎";
	if (name === "read" || name === "grep" || name === "glob" || name === "ls") return "⌕";
	if (name.startsWith("mcp")) return "M";
	if (name.startsWith("web")) return "◎";
	if (name === "task" || name === "agent" || name === "rlm") return "◇";
	if (name === "refine" || name === "refinement") return "✦";
	return "•";
}

function toolCard(toolCallId, toolName, argsJson, timestamp = Date.now()) {
	let card = toolCards.get(toolCallId);
	if (card) return card;
	const root = el("div", "card");
	const head = el("div", "head");
	const status = el("span", "status");
	const chevron = el("span", "chev", "▾");
	head.onclick = () => root.classList.toggle("collapsed");
	head.append(el("span", "toolicon", toolGlyph(toolName)), el("span", "name", toolName), status, chevron);
	const out = el("pre");
	out.textContent = argsJson ?? "";
	root.append(head, out);
	addTimestamp(root, timestamp);
	root.dataset.tool = (toolName ?? "tool").toLowerCase();
	card = { root, out, status };
	toolCards.set(toolCallId, card);
	appendNode(root);
	scroll();
	return card;
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

function renderUnifiedDiff(container, text) {
	if (!text) return;
	const box = el("div", "diff");
	let oldLn = 0;
	let newLn = 0;

	for (const rawLine of text.split("\n")) {
		// Strip ANSI escape codes from tool terminal output (e.g. \x1b[1;37m)
		const line = rawLine.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
		if (line === "" || line.startsWith("\\ No newline")) continue;

		let cls = "row";
		let marker = " ";
		let code = line;
		let oldNum = "";
		let newNum = "";

		if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("---DIFF---") || line.startsWith("=== ")) {
			cls += " file";
			marker = "#";
		} else if (line.startsWith("@@")) {
			cls += " hunk";
			marker = "@";
			const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (hunkMatch) {
				oldLn = Number.parseInt(hunkMatch[1], 10);
				newLn = Number.parseInt(hunkMatch[2], 10);
			}
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			cls += " add";
			marker = "+";
			code = line.slice(1);
			newNum = newLn > 0 ? String(newLn++) : "";
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			cls += " del";
			marker = "−";
			code = line.slice(1);
			oldNum = oldLn > 0 ? String(oldLn++) : "";
		} else if (line.startsWith("+++") || line.startsWith("---")) {
			cls += " file";
			marker = "#";
			code = line;
		} else {
			// Context line
			if (oldLn > 0) oldNum = String(oldLn++);
			if (newLn > 0) newNum = String(newLn++);
			if (line.startsWith(" ")) code = line.slice(1);
		}

		const row = el("div", cls);
		if (oldNum || newNum) {
			const gutter = el("span", "gutter");
			gutter.append(el("span", "ln old", oldNum), el("span", "ln new", newNum));
			row.append(gutter);
		} else {
			row.append(el("span", "marker", marker));
		}
		row.append(el("span", "code", code));
		box.append(row);
	}
	container.append(box);
	scroll();
}

function countDiffStats(diffText) {
	let added = 0;
	let removed = 0;
	for (const rawLine of (diffText || "").split("\n")) {
		const line = rawLine.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function renderEditDiff(card, diffText) {
	const existing = card.root.querySelector(".diff");
	if (existing) existing.remove();

	// Add or update +N -M diff stats badge in tool card header
	const existingStats = card.root.querySelector(".head .diff-stats");
	if (existingStats) existingStats.remove();

	const stats = countDiffStats(diffText);
	if (stats.added > 0 || stats.removed > 0) {
		const badge = el("span", "diff-stats");
		if (stats.added > 0) badge.append(el("span", "diff-add", `+${stats.added}`));
		if (stats.removed > 0) badge.append(el("span", "diff-del", `-${stats.removed}`));
		const nameEl = card.root.querySelector(".head .name");
		if (nameEl && nameEl.nextSibling) {
			card.root.querySelector(".head").insertBefore(badge, nameEl.nextSibling);
		} else {
			card.root.querySelector(".head")?.append(badge);
		}
	}

	renderUnifiedDiff(card.root, diffText);
}
function entryForDiff(entry) {
	if (!entry) return undefined;
	const obj = {};
	if (entry.title !== undefined) obj.title = entry.title;
	if (entry.content !== undefined) obj.content = entry.content;
	if (entry.path !== undefined) obj.path = entry.path;
	if (entry.reference && Object.keys(entry.reference).length) obj.reference = entry.reference;
	if (entry.arguments && Object.keys(entry.arguments).length) obj.arguments = entry.arguments;
	if (entry.metadata && Object.keys(entry.metadata).length) obj.metadata = entry.metadata;
	return obj;
}

function computeEntryDiff(before, after) {
	const beforeText = before ? (typeof before === "string" ? before : JSON.stringify(before, null, 2)) : "";
	const afterText = after ? (typeof after === "string" ? after : JSON.stringify(after, null, 2)) : "";
	const beforeLines = before ? beforeText.split("\n") : [];
	const afterLines = after ? afterText.split("\n") : [];

	if (!before || beforeLines.length === 0) {
		return afterLines.map((l) => `+${l}`).join("\n");
	}
	if (!after || afterLines.length === 0) {
		return beforeLines.map((l) => `-${l}`).join("\n");
	}

	const m = beforeLines.length;
	const n = afterLines.length;
	if (m * n > 40000) {
		return [
			...beforeLines.map((l) => `-${l}`),
			...afterLines.map((l) => `+${l}`),
		].join("\n");
	}
	const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 0; i < m; i++) {
		for (let j = 0; j < n; j++) {
			if (beforeLines[i] === afterLines[j]) {
				dp[i + 1][j + 1] = dp[i][j] + 1;
			} else {
				dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}
	let i = m;
	let j = n;
	const result = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
			result.unshift(` ${beforeLines[i - 1]}`);
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.unshift(`+${afterLines[j - 1]}`);
			j--;
		} else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
			result.unshift(`-${beforeLines[i - 1]}`);
			i--;
		}
	}
	return result.join("\n");
}

function renderRefinementCard(input, timestamp = Date.now()) {
	let id = "";
	let summary = "";
	let rationale = "";
	let scope = "local";
	let rollbackOf = null;
	let edits = [];

	if (input && input.details) {
		id = input.details.refinementId || "";
		summary = input.details.summary || "";
		scope = input.details.scope || "local";
		rollbackOf = input.details.rollbackOf || null;
		edits = input.details.edits || [];
		timestamp = input.timestamp || timestamp;
	} else if (input && input.result) {
		const res = input.result;
		id = res.id || "";
		summary = res.summary || "";
		rationale = res.rationale || "";
		scope = res.scope || "local";
		rollbackOf = res.rollbackOf || null;
		edits = res.appliedEdits || [];
		timestamp = input.timestamp || timestamp;
	} else if (input) {
		id = input.id || input.refinementId || "";
		summary = input.summary || "";
		rationale = input.rationale || "";
		scope = input.scope || "local";
		rollbackOf = input.rollbackOf || null;
		edits = input.appliedEdits || input.edits || [];
		timestamp = input.timestamp || timestamp;
	}

	if (id && typeof refinementCards !== "undefined" && refinementCards.has(id)) {
		return refinementCards.get(id);
	}

	const root = el("div", "card refinement-card");
	if (!root.dataset) root.dataset = {};
	root.dataset.scope = scope;
	const head = el("div", "head");

	const badge = el("span", "refine-badge");
	badge.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg> REFINE';

	const titleSpan = el("span", "name", "Continual Harness Refinement");
	const scopeTag = el("span", `refine-scope-tag ${scope}`, scope.toUpperCase());

	head.append(badge, scopeTag);
	if (rollbackOf) {
		const rbTag = el("span", "refine-rollback-tag", "ROLLBACK");
		head.append(rbTag);
	}
	head.append(titleSpan);

	const appliedCount = edits.filter((e) => e.applied !== false).length;
	const status = el("span", "status");
	if (edits.length === 0) {
		status.textContent = "0 edits applied";
		status.className = "status dim";
	} else if (appliedCount === edits.length) {
		status.textContent = `${appliedCount} edit${appliedCount === 1 ? "" : "s"} applied`;
		status.className = "status ok";
	} else {
		status.textContent = `${appliedCount}/${edits.length} edits applied`;
		status.className = "status error";
	}

	const chevron = el("span", "chev", "▾");
	head.append(status, chevron);
	root.append(head);

	head.onclick = () => root.classList.toggle("collapsed");

	// Summary box
	const summaryBox = el("div", "refine-summary");
	const sumTitle = el("div", "refine-summary-title", summary || "Refined continual harness state");
	summaryBox.append(sumTitle);
	if (rationale) {
		const rat = el("div", "refine-rationale", rationale);
		summaryBox.append(rat);
	}
	root.append(summaryBox);

	// Edits container
	if (edits.length > 0) {
		const editsContainer = el("div", "refine-edits");
		for (const edit of edits) {
			const editRow = el("div", "refine-edit-row");
			const editHead = el("div", "refine-edit-header");

			const act = (edit.action || "create").toLowerCase();
			const isSuccess = edit.applied !== false;
			const actionTag = el("span", `action-tag ${isSuccess ? act : "failed"}`);
			actionTag.textContent = isSuccess ? act.toUpperCase() : "FAILED";

			const kindSpan = el("span", "edit-kind", edit.kind || "memory");
			const idCode = el("code", "edit-id", edit.id || "entry");
			editHead.append(actionTag, kindSpan, idCode);

			if (edit.path) {
				const pathSpan = el("span", "edit-path", `(${edit.path})`);
				editHead.append(pathSpan);
			}
			if (edit.title && edit.title !== edit.id) {
				const editTitle = el("span", "edit-title", edit.title);
				editHead.append(editTitle);
			}
			editRow.append(editHead);

			if (edit.error) {
				const errBox = el("div", "edit-error", edit.error);
				editRow.append(errBox);
			}

			// Generate diff
			const beforeObj = edit.before ? entryForDiff(edit.before) : undefined;
			const afterObj = edit.after ? entryForDiff(edit.after) : act === "delete" ? undefined : entryForDiff(edit);
			const diffText = computeEntryDiff(beforeObj, afterObj);
			if (diffText) {
				renderUnifiedDiff(editRow, diffText);
			}
			editsContainer.append(editRow);
		}
		root.append(editsContainer);
	} else {
		root.classList.add("collapsed");
	}

	addTimestamp(root, timestamp);
	if (id && typeof refinementCards !== "undefined") refinementCards.set(id, root);
	appendNode(root);
	scroll();
	return root;
}

function renderCompactionCard(message, timestamp = Date.now()) {
	const summary = message.summary || (typeof message.content === "string" ? message.content : "");
	const tokensBefore = message.tokensBefore;
	const tokenStr = typeof tokensBefore === "number" ? tokensBefore.toLocaleString() : (tokensBefore ?? "?");
	const focus = message.customInstructions || message.details?.customInstructions || "";
	const ts = message.timestamp || timestamp;

	const root = el("div", "card compaction-card");
	const head = el("div", "head");

	const badge = el("span", "compact-badge");
	badge.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/></svg> COMPACT';

	const tokenTag = el("span", "compact-tokens-tag", `${tokenStr} TOKENS`);
	const titleSpan = el("span", "name", "Context Compaction");

	head.append(badge, tokenTag);
	if (focus) {
		const focusSpan = el("span", "compact-focus-tag", `focus: ${focus}`);
		head.append(focusSpan);
	}
	head.append(titleSpan);

	const isFailed = message.details?.outcome === "failed";
	const status = el("span", "status " + (isFailed ? "error" : "ok"), isFailed ? "failed" : "done");
	const chevron = el("span", "chev", "▾");
	head.append(status, chevron);
	root.append(head);

	head.onclick = () => root.classList.toggle("collapsed");

	if (summary) {
		const body = el("div", "compact-summary-body md");
		renderMarkdownInto(body, summary);
		root.append(body);
	}

	addTimestamp(root, ts);
	appendNode(root);
	scroll();
	return root;
}

// ---------------------------------------------------------------------------
// Subagent card rendering
// ---------------------------------------------------------------------------

function formatSubagentStatusLabel(status) {
	switch ((status || "").toLowerCase()) {
		case "running": return "● RUNNING";
		case "queued": return "◌ QUEUED";
		case "done": return "✓ DONE";
		case "error": return "✕ ERROR";
		case "cancelled": return "⊘ CANCELLED";
		default: return (status || "SUBAGENT").toUpperCase();
	}
}

function renderSubagentActivity(actBox, activity) {
	actBox.replaceChildren();
	if (!activity) return;
	const dot = el("span", `act-dot ${activity.kind || "waiting"}`);
	actBox.append(dot);
	if (activity.kind === "executing") {
		const label = el("span", "", "Executing tool: ");
		const toolCode = el("code", "", activity.toolName || "tool");
		actBox.append(label, toolCode);
	} else if (activity.kind === "writing") {
		actBox.append(el("span", "", "Generating response…"));
	} else if (activity.kind === "waiting") {
		actBox.append(el("span", "", "Waiting…"));
	} else {
		actBox.append(el("span", "", `Activity: ${activity.kind}`));
	}
}

function updateSubagentMetaDetails(metaDetails, data) {
	metaDetails.replaceChildren();
	if (data.durationMs != null && data.durationMs > 0) {
		const sec = (data.durationMs / 1000).toFixed(1);
		const pill = el("span", "subagent-meta-pill", `⏱ ${sec}s`);
		metaDetails.append(pill);
	}
	if (data.tokenCount != null && data.tokenCount > 0) {
		const pill = el("span", "subagent-meta-pill", `🔤 ${data.tokenCount.toLocaleString()} tok`);
		metaDetails.append(pill);
	}
	if (data.toolUseCount != null && data.toolUseCount > 0) {
		const pill = el("span", "subagent-meta-pill", `🛠 ${data.toolUseCount} tool${data.toolUseCount > 1 ? "s" : ""}`);
		metaDetails.append(pill);
	}
}

function renderSubagentMessagesList(container, messages) {
	container.replaceChildren();
	if (!messages || messages.length === 0) {
		const empty = el("div", "subagent-msg-empty", "No messages found in subagent transcript.");
		container.append(empty);
		return;
	}

	for (const msg of messages) {
		const role = msg.role;
		if (role === "user" || (role === "custom" && msg.customType === "agent_message")) {
			const box = el("div", "subagent-msg user");
			const badge = el("div", "subagent-msg-badge user", role === "custom" ? "TASK FROM PARENT" : "USER");
			const content = el("div", "subagent-msg-text md");
			renderMarkdownInto(content, textOf(msg.content));
			box.append(badge, content);
			container.append(box);
		} else if (role === "assistant") {
			const box = el("div", "subagent-msg assistant");
			for (const part of msg.content ?? []) {
				if (part.type === "thinking" && part.thinking) {
					const thinkBox = el("div", "subagent-thinking collapsed");
					const thinkHead = el("div", "subagent-thinking-head");
					thinkHead.innerHTML = '<span class="think-icon">💭</span> <span class="think-title">Thinking Process</span> <span class="think-chev">▾</span>';
					thinkHead.onclick = (e) => {
						e.stopPropagation();
						thinkBox.classList.toggle("collapsed");
					};
					const thinkText = el("div", "subagent-thinking-text md");
					renderMarkdownInto(thinkText, part.thinking);
					thinkBox.append(thinkHead, thinkText);
					box.append(thinkBox);
				} else if (part.type === "toolCall") {
					const toolBox = el("div", "subagent-tool-item");
					const toolHead = el("div", "subagent-tool-head");
					const glyph = toolGlyph(part.name);
					toolHead.innerHTML = `<span class="tool-icon">${glyph}</span> <span class="tool-name">${part.name || "tool"}</span> <span class="tool-badge">CALL</span>`;
					const toolArgs = el("pre", "subagent-tool-args", JSON.stringify(part.arguments ?? {}, null, 2));
					toolBox.append(toolHead, toolArgs);
					box.append(toolBox);
				} else if (part.type === "text" && part.text) {
					const textEl = el("div", "subagent-msg-text md");
					renderMarkdownInto(textEl, part.text);
					box.append(textEl);
				}
			}
			if (box.children.length > 0) {
				container.append(box);
			}
		} else if (role === "toolResult") {
			const box = el("div", "subagent-msg tool-result");
			const head = el("div", "subagent-result-head");
			head.innerHTML = `<span class="res-badge ${msg.isError ? "error" : "ok"}">${msg.isError ? "TOOL ERROR" : "TOOL RESULT"}</span>`;
			const text = textOf(msg.content);
			const out = el("pre", "subagent-result-out", text || "[empty output]");
			box.append(head, out);
			container.append(box);
		}
	}
}

function openSubagentHistoryModal(name, status, model, label, messages) {
	const statusBadge = (status || "done").toUpperCase();
	openModal({
		title: `Subagent: ${name}`,
		message: `${label ? `Task: ${label} · ` : ""}Model: ${model || "default"} · [${statusBadge}]`,
		wide: true,
		className: "dialog-subagent-modal",
		build(body, actions, close) {
			const modalContainer = el("div", "subagent-modal-transcript");
			renderSubagentMessagesList(modalContainer, messages);
			body.append(modalContainer);

			const closeBtn = el("button", "primarybtn dialog-close-btn", "Close");
			closeBtn.id = "dialogCancel";
			closeBtn.type = "button";
			closeBtn.onclick = close;
			actions.append(closeBtn);
		}
	});
}

async function loadSubagentMessages(cardRef, force = false) {
	if (!active || (!force && cardRef.messagesLoaded)) return;
	cardRef.historyLoading.classList.remove("hidden");
	cardRef.historyEmpty.classList.add("hidden");
	try {
		const res = await api(`/api/subagent-messages?sessionId=${encodeURIComponent(active.id)}&childId=${encodeURIComponent(cardRef.id)}`);
		const msgs = Array.isArray(res?.messages) ? res.messages : [];
		cardRef.messages = msgs;
		cardRef.messagesLoaded = true;
		cardRef.historyLoading.classList.add("hidden");
		if (msgs.length === 0) {
			cardRef.historyEmpty.classList.remove("hidden");
			cardRef.historyList.replaceChildren();
			cardRef.countPill.classList.add("hidden");
			cardRef.modalBtn.classList.add("hidden");
		} else {
			cardRef.historyEmpty.classList.add("hidden");
			cardRef.countPill.textContent = `${msgs.length} msg${msgs.length === 1 ? "" : "s"}`;
			cardRef.countPill.classList.remove("hidden");
			cardRef.modalBtn.classList.remove("hidden");
			renderSubagentMessagesList(cardRef.historyList, msgs);
		}
	} catch (error) {
		cardRef.historyLoading.classList.add("hidden");
		cardRef.historyEmpty.textContent = `Could not load conversation: ${error.message}`;
		cardRef.historyEmpty.classList.remove("hidden");
	}
}

function updateExistingSubagentCard(cardRef, data) {
	const root = cardRef.root;
	const currentStatus = (data.status || "running").toLowerCase();
	root.dataset.status = currentStatus;
	cardRef.statusTag.className = `subagent-status-tag ${currentStatus}`;
	cardRef.statusTag.textContent = formatSubagentStatusLabel(currentStatus);

	if (data.model && !cardRef.modelPill) {
		const shortModel = data.model.split("/").pop() || data.model;
		cardRef.modelPill = el("span", "subagent-model-pill", shortModel);
		cardRef.head.insertBefore(cardRef.modelPill, cardRef.statusTag);
	}

	if (data.label && (!cardRef.taskContent.textContent || cardRef.taskContent.textContent === "[no prompt recorded]")) {
		cardRef.taskContent.textContent = data.label;
	}

	if (data.activity && currentStatus === "running") {
		cardRef.actBox.classList.remove("hidden");
		renderSubagentActivity(cardRef.actBox, data.activity);
	} else {
		cardRef.actBox.classList.add("hidden");
	}

	if (data.answerPreview) {
		cardRef.answerBox.classList.remove("hidden");
		renderMarkdownInto(cardRef.answerContent, data.answerPreview);
	}

	if (data.error) {
		cardRef.errBox.classList.remove("hidden");
		cardRef.errBox.textContent = data.error;
	} else if (currentStatus !== "error") {
		cardRef.errBox.classList.add("hidden");
	}

	cardRef.status = currentStatus;
	if (data.name) cardRef.name = data.name;
	if (data.label) cardRef.label = data.label;
	if (data.model) cardRef.model = data.model;

	updateSubagentMetaDetails(cardRef.metaDetails, data);

	if (cardRef.historyContent && !cardRef.historyContent.classList.contains("collapsed")) {
		loadSubagentMessages(cardRef, true);
	}
}

function renderSubagentCard(input, fallbackTs = Date.now(), anchorNode = null) {
	if (!input) return null;

	let id = "";
	let name = "subagent";
	let label = "";
	let model = "";
	let status = "running";
	let durationMs = null;
	let toolUseCount = 0;
	let tokenCount = 0;
	let answerPreview = "";
	let error = "";
	let activity = null;
	let timestamp = fallbackTs;

	if (input.customType === "rlm_child_terminal_notice" || input.customType === "rlm_child_failure") {
		const det = input.details || {};
		id = det.childId || input.id || "";
		name = det.sessionName || "subagent";
		status = input.customType === "rlm_child_failure" ? "error" : det.kind === "cancelled" ? "cancelled" : "done";
		error = det.error || (det.kind === "cancelled" ? det.reason : "") || "";
		answerPreview = det.lastAssistantTextPreview || "";
		timestamp = input.timestamp || timestamp;
	} else if (input.customType === "agent_message") {
		const det = input.details || {};
		id = det.from?.sessionId || det.from?.activeSessionId || input.id || "";
		name = det.from?.sessionName || "subagent";
		status = "running";
		label = typeof input.content === "string" ? input.content : "";
		timestamp = input.timestamp || timestamp;
	} else {
		// RlmChildAgentSnapshot or generic object
		id = input.id || input.childId || input.rlm_child_id || "";
		name = input.sessionName || input.name || "subagent";
		label = input.label || input.prompt || "";
		model = input.model || "";
		status = input.status || "running";
		durationMs = input.durationMs != null ? input.durationMs : null;
		toolUseCount = input.toolUseCount || 0;
		tokenCount = input.tokenCount || 0;
		answerPreview = input.answerPreview || input.lastAssistantTextPreview || "";
		error = input.error || "";
		activity = input.activity || null;
		timestamp = input.timestamp || timestamp;
	}

	if (!id) id = `sub-${Math.random().toString(36).slice(2, 9)}`;

	// Check if already in transcript
	const existing = typeof subagentCards !== "undefined" ? subagentCards.get(id) : null;
	if (existing) {
		updateExistingSubagentCard(existing, { name, label, model, status, durationMs, toolUseCount, tokenCount, answerPreview, error, activity });
		return existing.root;
	}

	// Create new card: DEFAULT COLLAPSED (accordion closed)
	const root = el("div", "card subagent-card collapsed");
	if (!root.dataset) root.dataset = {};
	root.dataset.subagentId = id;
	root.dataset.status = status;

	const head = el("div", "head");

	const badge = el("span", "subagent-badge");
	badge.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg> <span>SUBAGENT</span>';

	const nameSpan = el("span", "subagent-name", name);

	let modelPill = null;
	if (model) {
		const shortModel = model.split("/").pop() || model;
		modelPill = el("span", "subagent-model-pill", shortModel);
	}

	const statusTag = el("span", `subagent-status-tag ${status.toLowerCase()}`, formatSubagentStatusLabel(status));

	const chevron = el("span", "chev", "▾");

	head.append(badge, nameSpan);
	if (modelPill) head.append(modelPill);
	head.append(statusTag, chevron);
	root.append(head);

	// Click to toggle expand / collapse (accordion mechanism)
	head.onclick = () => root.classList.toggle("collapsed");

	// Card Body
	const body = el("div", "subagent-body");

	// Assigned Task section
	const taskBox = el("div", "subagent-task-box");
	const taskLabel = el("div", "subagent-section-label", "ASSIGNED TASK");
	const taskContent = el("div", "subagent-task-content", label || "[no prompt recorded]");
	taskBox.append(taskLabel, taskContent);
	body.append(taskBox);

	// Activity row (if executing tool or writing)
	const actBox = el("div", "subagent-activity-box" + (activity ? "" : " hidden"));
	if (activity) {
		renderSubagentActivity(actBox, activity);
	}
	body.append(actBox);

	// Answer Preview (if available)
	const answerBox = el("div", "subagent-answer-box" + (answerPreview ? "" : " hidden"));
	const answerLabel = el("div", "subagent-section-label", "RESULT PREVIEW");
	const answerContent = el("div", "subagent-answer-content md");
	if (answerPreview) {
		renderMarkdownInto(answerContent, answerPreview);
	}
	answerBox.append(answerLabel, answerContent);
	body.append(answerBox);

	// Error Box (if error)
	const errBox = el("div", "subagent-error-box" + (error ? "" : " hidden"));
	errBox.textContent = error;
	body.append(errBox);

	// Footer: duration, tokens, tool calls
	const footer = el("div", "subagent-footer");
	const metaDetails = el("div", "subagent-meta-details");
	updateSubagentMetaDetails(metaDetails, { durationMs, toolUseCount, tokenCount });
	footer.append(metaDetails);
	body.append(footer);

	// Actions row (Toggle conversation history + Modal button)
	const actionsRow = el("div", "subagent-actions-row");

	const toggleHistoryBtn = el("button", "subagent-toggle-history-btn");
	toggleHistoryBtn.type = "button";
	toggleHistoryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> <span>Conversation History</span>';
	const countPill = el("span", "subagent-history-count-pill hidden");
	const histChev = el("span", "subagent-history-chevron", "▾");
	toggleHistoryBtn.append(countPill, histChev);

	const modalBtn = el("button", "subagent-modal-view-btn hidden");
	modalBtn.type = "button";
	modalBtn.title = "View conversation in large modal dialog";
	modalBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg> <span>Modal View</span>';

	actionsRow.append(toggleHistoryBtn, modalBtn);
	body.append(actionsRow);

	// History content container
	const historyContent = el("div", "subagent-history-content collapsed");
	const historyLoading = el("div", "subagent-history-loading hidden");
	historyLoading.innerHTML = '<span class="subagent-loading-spinner"></span> <span>Loading conversation…</span>';
	const historyEmpty = el("div", "subagent-history-empty hidden", "No messages recorded yet.");
	const historyList = el("div", "subagent-history-list");

	historyContent.append(historyLoading, historyEmpty, historyList);
	body.append(historyContent);

	root.append(body);
	addTimestamp(root, timestamp);
	const currentMount = (typeof activeMountTarget !== "undefined" && activeMountTarget) ? activeMountTarget : null;
	if (anchorNode && (anchorNode.parentElement === transcript || (currentMount && anchorNode.parentElement === currentMount))) {
		const parent = anchorNode.parentElement;
		if (anchorNode.nextSibling) {
			parent.insertBefore(root, anchorNode.nextSibling);
		} else {
			parent.append(root);
		}
	} else {
		appendNode(root);
	}
	scroll();

	const cardRef = {
		id,
		name,
		label,
		model,
		status,
		root,
		head,
		statusTag,
		modelPill,
		taskContent,
		actBox,
		answerBox,
		answerContent,
		errBox,
		metaDetails,
		actionsRow,
		toggleHistoryBtn,
		countPill,
		histChev,
		modalBtn,
		historyContent,
		historyLoading,
		historyEmpty,
		historyList,
		messages: null,
		messagesLoaded: false
	};

	toggleHistoryBtn.onclick = (e) => {
		e.stopPropagation();
		const collapsed = historyContent.classList.toggle("collapsed");
		histChev.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
		if (!collapsed) {
			loadSubagentMessages(cardRef, cardRef.status === "running");
		}
	};

	modalBtn.onclick = (e) => {
		e.stopPropagation();
		openSubagentHistoryModal(cardRef.name, cardRef.status, cardRef.model, cardRef.label, cardRef.messages || []);
	};

	if (typeof subagentCards !== "undefined") subagentCards.set(id, cardRef);
	return root;
}

// ---------------------------------------------------------------------------
// Transcript hydration + events
// ---------------------------------------------------------------------------

function renderMessage(message) {
	const role = message.role;
	if (role === "user") {
		const text = textOf(message.content);
		const bubble = el("div", "bubble user");
		const msgText = el("div", "user-msg-text", text);
		bubble.append(msgText);

		const forkBtn = el("button", "msg-action-btn fork-btn", "");
		forkBtn.type = "button";
		forkBtn.title = "Fork conversation from this prompt";
		forkBtn.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg> <span>Fork</span>';
		forkBtn.onclick = (e) => {
			e.stopPropagation();
			openForkModalForMessage(text, message.timestamp);
		};
		if (Array.isArray(message.content)) {
			const images = message.content.filter((p) => p && p.type === "image");
			if (images.length > 0) {
				const imgWrap = el("div", "user-msg-images");
				for (const imgPart of images) {
					const imgEl = el("img", "user-msg-img");
					const mime = imgPart.mimeType || "image/png";
					imgEl.src = imgPart.data ? `data:${mime};base64,${imgPart.data}` : (imgPart.url || "");
					imgEl.alt = "Attached image";
					imgWrap.append(imgEl);
				}
				bubble.insertBefore(imgWrap, bubble.firstChild);
			}
		}
		if (typeof attachMessageFooter === "function") {
			attachMessageFooter(bubble, () => text, message.timestamp, [forkBtn]);
		} else {
			const footer = el("div", "user-msg-footer");
			footer.append(forkBtn);
			if (typeof addTimestamp === "function") addTimestamp(footer, message.timestamp);
			bubble.append(footer);
		}
		appendNode(bubble);
		return;
	}
	if (role === "assistant") {
		const content = message.content ?? [];
		const hasFormalThinking = content.some((p) => p && p.type === "thinking");
		for (let i = 0; i < content.length; i++) {
			const part = content[i];
			if (part.type === "text" && part.text) {
				// Text preceding a toolCall in the same turn without formal thinking is pre-tool planning/CoT.
				// Render it as a thinking block so it stays neatly styled and obeys hide-thinking toggle!
				const isPreToolPlanning = !hasFormalThinking && content.slice(i + 1).some((p) => p && p.type === "toolCall");
				const block = el("div", isPreToolPlanning ? "thinking md" : "bubble assistant md");
				block.dataset.raw = part.text;
				const ttft = Number(message.ttftMs || message.details?.ttftMs || message.timing?.ttftMs || 0);
				if (ttft) block.dataset.ttft = String(ttft);
				if (typeof renderMarkdownInto === "function") renderMarkdownInto(block, part.text);
				if (typeof attachMessageFooter === "function") {
					attachMessageFooter(block, () => block.dataset.raw || part.text || "", message.timestamp, [], ttft);
				} else if (typeof addTimestamp === "function") {
					addTimestamp(block, message.timestamp);
				}
				appendNode(block);
			}
			else if (part.type === "thinking" && part.thinking) {
				const block = el("div", "thinking md");
				addTimestamp(block, message.timestamp);
				renderMarkdownInto(block, part.thinking);
				appendNode(block);
			}
			else if (part.type === "toolCall" && part.id) {
				toolCard(part.id, part.name, JSON.stringify(part.arguments ?? {}, null, 2), message.timestamp);
			}
		}
		if (message.errorMessage || message.stopReason === "error") {
			appendNode(createErrorCard(message.errorMessage || "Model request error", message.stopReason));
		}
		return;
	}
	if (role === "toolResult") {
		const card = message.toolCallId ? toolCards.get(message.toolCallId) : undefined;
		let output = textOf(message.content);
		if (!output && message.details && typeof message.details.stdout === "string") {
			output = message.details.stdout;
		}
		let diff = undefined;
		let displayOutput = output;

		if (message.details) {
			if (typeof message.details.diff === "string" && message.details.diff.trim()) {
				diff = message.details.diff;
			} else if (Array.isArray(message.details.diffs) && message.details.diffs.length > 0) {
				const chunks = [];
				for (const d of message.details.diffs) {
					if (typeof d.diff === "string") {
						chunks.push(d.diff);
					} else if (d.path && (d.oldStr !== undefined || d.newStr !== undefined)) {
						const filePath = d.path;
						const oldLines = d.oldStr ? d.oldStr.split("\n") : [];
						const newLines = d.newStr ? d.newStr.split("\n") : [];
						const header = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@`;
						const delLines = oldLines.map((l) => `-${l}`).join("\n");
						const addLines = newLines.map((l) => `+${l}`).join("\n");
						chunks.push([header, delLines, addLines].filter(Boolean).join("\n"));
					}
				}
				if (chunks.length > 0) diff = chunks.join("\n");
			}
		}

		// If no explicit diff, detect unified git diff embedded in text output (e.g. from bash/ipython/patch)
		if (!diff && output && (output.includes("diff --git") || (output.includes("--- a/") && output.includes("+++ b/")) || output.includes("@@ -"))) {
			const match = output.match(/(?:^|\n)(?:diff --git|--- [ab]\/|@@ -\d+)/);
			if (match && match.index !== undefined) {
				const startPos = match.index === 0 ? 0 : match.index + 1;
				displayOutput = output.slice(0, startPos).trim();
				diff = output.slice(startPos).trim();
			}
		}

		if (card) {
			if (displayOutput) card.out.textContent += (card.out.textContent ? "\n" : "") + displayOutput;
			card.status.textContent = message.isError ? "error" : "done";
			card.status.className = "status " + (message.isError ? "error" : "ok");
			if (diff) renderEditDiff(card, diff);

			// Detect if this toolResult returned RLMSpawnHandle(s), and anchor cards for all spawned children
			if (output && output.includes("RLMSpawnHandle(") && typeof renderSubagentCard === "function") {
				const handleRegex = /RLMSpawnHandle\(([\s\S]*?)\)/g;
				let handleMatch;
				while ((handleMatch = handleRegex.exec(output)) !== null) {
					const block = handleMatch[1];
					const id = block.match(/rlm_child_id=['"]([^'"]+)['"]/)?.[1];
					const name = block.match(/name=['"]([^'"]+)['"]/)?.[1];
					const model = block.match(/model=['"]([^'"]+)['"]/)?.[1] || "";
					const dir = block.match(/session_dir=(?:PosixPath\()?['"]([^'"]+)['"]/)?.[1] || "";
					if (id && name) {
						const childObj = {
							id,
							sessionName: name,
							model,
							sessionDir: dir,
							status: "running",
							timestamp: message.timestamp
						};
						renderSubagentCard(childObj, message.timestamp, card.root);
						if (active) {
							if (!active.runningSubagents) active.runningSubagents = new Map();
							active.runningSubagents.set(id, childObj);
							active.hasRunningRlmChildren = true;
							updateSubagentIndicator();
						}
					}
				}
			}
		} else if (diff) {
			const holder = toolCard(message.toolCallId ?? `result-${Math.random()}`, "edit", "");
			card2(holder);
			function card2(target) {
				target.status.textContent = message.isError ? "error" : "done";
				target.status.className = "status " + (message.isError ? "error" : "ok");
				renderEditDiff(target, diff);
			}
		} else {
			appendNode(el("div", "card", output || "[empty tool result]"));
		}
		return;
	}
	if (role === "compactionSummary" || role === "branchSummary") {
		renderCompactionCard(message);
		return;
	}
	if (role === "bashExecution") {
		const card = toolCard(`bash-${message.timestamp ?? Math.random()}`, "bash", `$ ${message.command ?? ""}`, message.timestamp);
		card.out.textContent += (card.out.textContent ? "\n" : "") + (message.output ?? "");
		card.status.textContent = message.exitCode === 0 ? "done" : `exit ${message.exitCode}`;
		card.status.className = "status " + (message.exitCode === 0 ? "ok" : "error");
		return;
	}
	if (role === "custom") {
		if (message.customType === "rlm_child_terminal_notice" || message.customType === "rlm_child_failure") {
			if (typeof renderSubagentCard === "function") renderSubagentCard(message);
			return;
		}
		if (message.customType === "refinement_outcome" || message.customType === "prime-agent.refinement" || message.customType === "refinement") {
			renderRefinementCard(message.data || message.details || message);
			return;
		}
		if (message.customType === "compaction_outcome") {
			renderCompactionCard(message);
			return;
		}
		if (message.customType === "session_slash_command") {
			const bubble = el("div", "bubble user", textOf(message.content));
			addTimestamp(bubble, message.timestamp);
			appendNode(bubble);
			return;
		}
		if (message.customType === "session_slash_command_result") {
			const bubble = el("div", "bubble assistant md");
			addTimestamp(bubble, message.timestamp);
			renderMarkdownInto(bubble, textOf(message.content));
			appendNode(bubble);
			return;
		}
		if (message.display) {
			const card = el("div", "card", textOf(message.content));
			addTimestamp(card, message.timestamp);
			appendNode(card);
		}
		return;
	}
}

function updateLoadEarlierBar() {
	let bar = transcript.querySelector(".load-earlier-bar");
	const unrenderedTurns = totalSessionTurns - renderedTurnCount;
	if (unrenderedTurns <= 0) {
		if (bar) bar.remove();
		return;
	}
	if (!bar) {
		bar = el("div", "load-earlier-bar");
		const btn = el("button", "load-earlier-btn");
		btn.type = "button";
		btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg> <span>Load Earlier Conversation</span>`;
		const info = el("span", "load-earlier-info");
		bar.append(btn, info);
		transcript.insertBefore(bar, transcript.firstChild);

		btn.onclick = (e) => {
			e.stopPropagation();
			loadEarlierMessages();
		};
	}
	const turnsToLoad = Math.min(unrenderedTurns, TRANSCRIPT_TURN_PAGE_SIZE);
	const btnSpan = bar.querySelector(".load-earlier-btn span");
	if (btnSpan) btnSpan.textContent = `Load ${turnsToLoad} Earlier Turns`;
	const info = bar.querySelector(".load-earlier-info");
	if (info) info.textContent = `Showing last ${renderedTurnCount} of ${totalSessionTurns} conversation turns`;
}

function loadEarlierMessages() {
	const boundaries = getTurnBoundaryIndices(fullSessionMessages);
	totalSessionTurns = boundaries.length;
	const unrenderedTurns = totalSessionTurns - renderedTurnCount;
	if (unrenderedTurns <= 0) return;

	const turnsToLoad = Math.min(unrenderedTurns, TRANSCRIPT_TURN_PAGE_SIZE);
	const newRenderedTurns = renderedTurnCount + turnsToLoad;

	// Calculate message array index range:
	// The oldest rendered turn was at index (totalSessionTurns - renderedTurnCount)
	const currentStartMsgIndex = boundaries[totalSessionTurns - renderedTurnCount];
	// The new start turn will be at index (totalSessionTurns - newRenderedTurns)
	const targetTurnIndex = totalSessionTurns - newRenderedTurns;
	const newStartMsgIndex = targetTurnIndex >= 0 ? boundaries[targetTurnIndex] : 0;

	const chunk = fullSessionMessages.slice(newStartMsgIndex, currentStartMsgIndex);

	const oldScrollHeight = transcript.scrollHeight;
	const oldScrollTop = transcript.scrollTop;

	const bar = transcript.querySelector(".load-earlier-bar");
	const fragment = document.createDocumentFragment();

	activeMountTarget = fragment;
	try {
		for (const message of chunk) {
			renderMessage(message);
		}
	} finally {
		activeMountTarget = null;
	}

	renderedTurnCount = newRenderedTurns;

	if (bar && bar.nextSibling) {
		transcript.insertBefore(fragment, bar.nextSibling);
	} else if (bar) {
		transcript.append(fragment);
	} else {
		transcript.insertBefore(fragment, transcript.firstChild);
	}

	updateLoadEarlierBar();

	// Maintain previous scroll viewport so user doesn't jump to the top
	const newScrollHeight = transcript.scrollHeight;
	transcript.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
}

function renderMessages(messages) {
	transcript.replaceChildren();
	toolCards.clear();
	sideCards.clear();
	if (typeof refinementCards !== "undefined") refinementCards.clear();
	if (typeof subagentCards !== "undefined") subagentCards.clear();
	run = null;

	const list = Array.isArray(messages) ? messages : [];
	fullSessionMessages = list;

	// Populate TTFT / response latency from elapsed turn intervals
	let lastTimestamp = 0;
	for (const msg of list) {
		const ts = Number(msg.timestamp || 0);
		if (msg.role === "assistant" && lastTimestamp > 0 && ts > lastTimestamp && !msg.ttftMs) {
			const elapsed = ts - lastTimestamp;
			if (elapsed >= 10 && elapsed <= 180000) {
				msg.ttftMs = elapsed;
			}
		}
		if (ts > 0) lastTimestamp = ts;
	}

	const boundaries = getTurnBoundaryIndices(list);
	totalSessionTurns = boundaries.length;

	if (totalSessionTurns <= TRANSCRIPT_TURN_PAGE_SIZE) {
		renderedTurnCount = totalSessionTurns;
		for (const message of list) renderMessage(message);
	} else {
		renderedTurnCount = TRANSCRIPT_TURN_PAGE_SIZE;
		const startTurnIndex = totalSessionTurns - TRANSCRIPT_TURN_PAGE_SIZE;
		const startMsgIndex = boundaries[startTurnIndex];
		const recentSlice = list.slice(startMsgIndex);
		for (const message of recentSlice) renderMessage(message);
		updateLoadEarlierBar();
	}
	scroll(true);
}

function renderGoalBanner(goal) {
	const banner = $("goalBanner");
	const chip = $("goalChip");

	if (!goal || goal.status === "idle" || !goal.objective) {
		activeGoal = null;
		if (banner) banner.classList.add("hidden");
		if (chip) chip.classList.add("hidden");
		return;
	}

	if (active && (goal.status === "complete" || goal.status === "error")) {
		const keys = [
			goal.goalId,
			goal.objective,
			active.id && goal.goalId ? `${active.id}:${goal.goalId}` : null,
			active.id && goal.objective ? `${active.id}:${goal.objective}` : null,
			active.sessionId && goal.goalId ? `${active.sessionId}:${goal.goalId}` : null,
			active.sessionId && goal.objective ? `${active.sessionId}:${goal.objective}` : null,
		].filter(Boolean);
		if (keys.some((k) => dismissedGoals.has(k))) {
			activeGoal = null;
			if (banner) banner.classList.add("hidden");
			if (chip) chip.classList.add("hidden");
			return;
		}
	}

	activeGoal = goal;
	if (!banner || !chip) return;

	banner.classList.remove("hidden");
	chip.classList.remove("hidden");

	banner.classList.remove("paused", "budget_limited", "complete", "error");
	if (goal.status !== "active") banner.classList.add(goal.status);

	chip.className = `chip goal ${goal.status}`;
	const statusBadge = $("goalStatusBadge");
	if (statusBadge) {
		statusBadge.textContent = (goal.status || "active").replace(/_/g, " ").toUpperCase();
		statusBadge.className = `goal-status-badge status-${goal.status || "active"}`;
	}

	const objEl = $("goalObjective");
	if (objEl) {
		renderMarkdownInto(objEl, goal.objective);
	}
	const summaryText = $("goalSummaryText");
	if (summaryText && goal.objective) {
		const budgetStr = typeof goal.tokenBudget === "number" && goal.tokenBudget > 0
			? ` · ${Math.round(((goal.tokensUsed || 0) / goal.tokenBudget) * 100)}% budget`
			: "";
		summaryText.textContent = `${goal.objective}${budgetStr}`;
	}

	const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
	const RESUME_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
	const RESTART_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

	const pauseIcon = $("goalPauseIcon");
	const pauseLabel = $("goalPauseLabel");
	const pauseBtn = $("goalPauseBtn");
	if (pauseBtn && pauseIcon && pauseLabel) {
		pauseBtn.classList.remove("resume", "restart");
		if (goal.status === "paused" || goal.status === "budget_limited") {
			pauseIcon.innerHTML = RESUME_SVG;
			pauseLabel.textContent = "Resume";
			pauseBtn.title = "Resume goal (/goal resume)";
			pauseBtn.disabled = false;
			pauseBtn.classList.add("resume");
		} else if (goal.status === "error" || goal.status === "complete") {
			pauseIcon.innerHTML = RESTART_SVG;
			pauseLabel.textContent = "Restart";
			pauseBtn.title = `Restart goal (/goal ${goal.objective || ""})`;
			pauseBtn.disabled = false;
			pauseBtn.classList.add("restart");
		} else {
			pauseIcon.innerHTML = PAUSE_SVG;
			pauseLabel.textContent = "Pause";
			pauseBtn.title = "Pause goal (/goal pause)";
			pauseBtn.disabled = false;
		}
	}

	const errorBox = $("goalErrorBox");
	const errorText = $("goalErrorText");
	if (errorBox && errorText) {
		const err = goal.status === "error" ? (goal.lastError || goal.lastReason || "Goal run stopped due to an error.") : "";
		errorText.textContent = err;
		errorBox.classList.toggle("hidden", !err);
	}

	const budgetNotice = $("goalBudgetNotice");
	if (budgetNotice) {
		const hasBudget = (typeof goal.tokenBudget === "number" && goal.tokenBudget > 0) ||
			(typeof goal.maxTurns === "number" && goal.maxTurns > 0);
		budgetNotice.classList.toggle("hidden", !hasBudget);
	}

	const tokensVal = $("goalTokensValue");
	if (tokensVal) {
		const used = (goal.tokensUsed ?? 0).toLocaleString();
		tokensVal.textContent = typeof goal.tokenBudget === "number" && goal.tokenBudget > 0
			? `${used} / ${goal.tokenBudget.toLocaleString()}`
			: `${used}`;
	}

	const progressRow = $("goalProgressRow");
	const progressBar = $("goalProgressBar");
	const progressText = $("goalProgressText");
	if (progressRow && progressBar && progressText) {
		if (typeof goal.tokenBudget === "number" && goal.tokenBudget > 0) {
			progressRow.classList.remove("hidden");
			const pct = Math.min(100, Math.round(((goal.tokensUsed || 0) / goal.tokenBudget) * 100));
			progressBar.style.width = `${pct}%`;
			progressText.textContent = `${pct}%`;
		} else {
			progressRow.classList.add("hidden");
		}
	}

	const timeVal = $("goalTimeValue");
	if (timeVal) {
		const secs = goal.timeUsedSeconds ?? 0;
		if (secs < 60) timeVal.textContent = `${secs}s`;
		else {
			const m = Math.floor(secs / 60);
			const s = secs % 60;
			timeVal.textContent = `${m}m ${s}s`;
		}
	}

	const turnsVal = $("goalTurnsValue");
	if (turnsVal) {
		const used = goal.continuationsUsed ?? 0;
		turnsVal.textContent = typeof goal.maxTurns === "number" && goal.maxTurns > 0
			? `${used} / ${goal.maxTurns}`
			: `${used}`;
	}
}

function openGoalModal() {
	if (!active) return;
	const isError = activeGoal?.status === "error";
	const isRestart = isError || activeGoal?.status === "complete";
	openModal({
		title: isError ? "Restart Mission Goal" : activeGoal?.active ? "Edit Mission Goal" : "Set Mission Goal",
		message: "Define target objective and resource boundaries for the autonomous agent loop.",
		build(body, actions, close) {
			const form = el("form", "goal-modal-form");

			if (isError && (activeGoal.lastError || activeGoal.lastReason)) {
				const alert = el("div", "goal-modal-alert error");
				alert.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> <span><strong>Run halted:</strong> ${activeGoal.lastError || activeGoal.lastReason}</span>`;
				body.append(alert);
			} else if (activeGoal?.status === "paused") {
				const alert = el("div", "goal-modal-alert paused");
				alert.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg> <span><strong>Goal paused:</strong> Update target or limits, then click Restart or Resume.</span>';
				body.append(alert);
			}

			// Objective field
			const objGroup = el("div", "goal-field-group");
			const objLabel = el("label", "goal-field-label");
			objLabel.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="6" r="6"/><circle cx="12" cy="12" r="2"/></svg> <span>Mission Objective</span>';
			const textarea = el("textarea");
			textarea.value = activeGoal?.objective || "";
			textarea.placeholder = "What should the agent achieve? (e.g. Refactor auth module, add unit tests, and verify edge cases)";
			textarea.rows = 3;
			textarea.required = true;
			const objHint = el("span", "goal-field-hint", "Specific, verifiable milestone for the agent loop to audit before completing.");
			objGroup.append(objLabel, textarea, objHint);

			// Dual Grid: Token Budget + Max Turns Limit
			const grid = el("div", "goal-modal-grid");

			// Token budget card
			const budgetCard = el("div", "goal-boundary-card");
			const budgetLabel = el("label", "goal-field-label");
			budgetLabel.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> <span>Token Budget</span>';
			const budgetInput = el("input");
			budgetInput.type = "number";
			budgetInput.min = "1000";
			budgetInput.placeholder = "e.g. 50000";
			if (activeGoal?.tokenBudget) budgetInput.value = activeGoal.tokenBudget;
			const budgetHint = el("span", "goal-field-hint", "Caps cumulative token consumption before pausing.");

			const tokenPresets = el("div", "goal-presets-row");
			for (const val of [25000, 50000, 100000]) {
				const pill = el("button", "goal-preset-pill", `${val / 1000}k`);
				pill.type = "button";
				pill.onclick = (e) => { e.preventDefault(); budgetInput.value = val; };
				tokenPresets.append(pill);
			}
			const clearTokenPill = el("button", "goal-preset-pill", "None");
			clearTokenPill.type = "button";
			clearTokenPill.onclick = (e) => { e.preventDefault(); budgetInput.value = ""; };
			tokenPresets.append(clearTokenPill);

			budgetCard.append(budgetLabel, budgetInput, tokenPresets, budgetHint);

			// Turns limit card
			const turnsCard = el("div", "goal-boundary-card");
			const turnsLabel = el("label", "goal-field-label");
			turnsLabel.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> <span>Max Turns Limit</span>';
			const turnsInput = el("input");
			turnsInput.type = "number";
			turnsInput.min = "1";
			turnsInput.placeholder = "e.g. 10";
			if (activeGoal?.maxTurns) turnsInput.value = activeGoal.maxTurns;
			const turnsHint = el("span", "goal-field-hint", "Caps continuation turn iterations before pausing.");

			const turnPresets = el("div", "goal-presets-row");
			for (const val of [5, 10, 20]) {
				const pill = el("button", "goal-preset-pill", `${val} turns`);
				pill.type = "button";
				pill.onclick = (e) => { e.preventDefault(); turnsInput.value = val; };
				turnPresets.append(pill);
			}
			const clearTurnPill = el("button", "goal-preset-pill", "None");
			clearTurnPill.type = "button";
			clearTurnPill.onclick = (e) => { e.preventDefault(); turnsInput.value = ""; };
			turnPresets.append(clearTurnPill);

			turnsCard.append(turnsLabel, turnsInput, turnPresets, turnsHint);

			grid.append(budgetCard, turnsCard);
			form.append(objGroup, grid);
			body.append(form);

			// Action buttons layout:
			// [ Clear Goal (left) ]  ...  [ Cancel (right) ] [ Save / Restart (right) ]
			const cancelBtn = el("button", "", "Cancel");
			cancelBtn.id = "dialogCancel";
			cancelBtn.type = "button";
			cancelBtn.onclick = close;

			const saveBtnText = isRestart ? "Restart goal" : activeGoal?.active ? "Update goal" : "Start goal";
			const saveBtn = el("button", `goal-modal-submit ${isRestart ? "restart" : ""}`, saveBtnText);
			saveBtn.type = "button";
			saveBtn.onclick = async () => {
				const obj = textarea.value.trim();
				if (!obj) {
					textarea.focus();
					return;
				}
				close();
				if (active && activeGoal) {
					dismissedGoals.delete(`${active.id}:${activeGoal.goalId || activeGoal.objective}`);
				}
				let cmd = `/goal ${obj}`;
				if (isRestart) {
					cmd += " --restart";
				}
				const b = Number.parseInt(budgetInput.value, 10);
				if (Number.isInteger(b) && b > 0) {
					cmd += ` --budget ${b}`;
				} else if (activeGoal?.tokenBudget && !budgetInput.value.trim()) {
					cmd += " --budget none";
				}
				const t = Number.parseInt(turnsInput.value, 10);
				if (Number.isInteger(t) && t > 0) {
					cmd += ` --turns ${t}`;
				} else if (activeGoal?.maxTurns && !turnsInput.value.trim()) {
					cmd += " --turns none";
				}
				try {
					await api("/api/prompt", {
						method: "POST",
						body: JSON.stringify({ sessionId: active.id, message: cmd, streamingBehavior: busy ? "steer" : undefined }),
					});
				} catch (error) {
					showToast("Error", error.message, "error");
				}
			};

			if (activeGoal?.objective) {
				const clearBtn = el("button", "dangerbtn", "Clear goal");
				clearBtn.type = "button";
				clearBtn.onclick = async () => {
					close();
					await handleClearGoalAction();
				};
				actions.append(clearBtn);
			}

			actions.append(cancelBtn, saveBtn);
		},
	});
}
function openRefineModal() {
	if (!active) return;
	openModal({
		title: "Refine continual harness",
		message: "Improve reusable memory, prompts, skills, and subagent specs from conversation lessons.",
		build(body, actions, close) {
			const form = el("form", "panel-form");
			const label = el("label", "", "Refinement instructions (optional)");
			const textarea = el("textarea", "");
			textarea.placeholder = "e.g. Focus on lessons learned from the zero-touch architecture, or leave blank to refine from all turns.";
			textarea.rows = 3;

			const checkRow = el("label", "refine-check-row");
			checkRow.style = "display: flex; align-items: center; gap: 8px; margin-top: 8px; cursor: pointer;";
			const checkbox = el("input");
			checkbox.type = "checkbox";
			const checkText = el("span", "", "Global refinement (save across all sessions)");
			checkRow.append(checkbox, checkText);

			form.append(label, textarea, checkRow);
			body.append(form);

			const runBtn = el("button", "", "Run refinement");
			runBtn.type = "button";
			runBtn.onclick = async () => {
				const instructions = textarea.value.trim();
				const isGlobal = checkbox.checked;
				close();
				let cmd = "/refine";
				if (isGlobal) cmd += " --global";
				if (instructions) cmd += ` ${instructions}`;
				await BUILTIN_HANDLERS.refine(cmd.slice("/refine".length).trim());
			};
			actions.append(runBtn);
		},
	});
}


function updateSubagentIndicator() {
	const chip = $("subagentChip");
	const chipText = $("subagentChipText");
	const count = active?.runningSubagents?.size ?? 0;
	if (count > 0 && chip && chipText) {
		const names = [...active.runningSubagents.values()]
			.map((c) => c.sessionName || c.name || c.label || "subagent")
			.slice(0, 2)
			.join(", ");
		const text = count === 1 ? `Subagent: ${names}` : `${count} subagents`;
		chipText.textContent = text;
		chip.title = `${count} subagent${count > 1 ? "s" : ""} currently running in background`;
		chip.classList.remove("hidden");
		$("busy").classList.remove("hidden");
		$("busy").title = `${count} subagent${count > 1 ? "s" : ""} working in background`;
		$("stopBtn").disabled = false;
		showTyping(`${text} working...`);
	} else if (chip) {
		chip.classList.add("hidden");
		if (!run && !active?.state?.isStreaming) {
			$("busy").classList.add("hidden");
			$("busy").title = "Agent is working";
			$("stopBtn").disabled = !busy;
		}
	}
}


let speedDisplayEnabled = typeof localStorage !== "undefined" ? localStorage.getItem("prime_speed_display") !== "0" : true;
let speedStats = { tokens: 0, durationMs: 0, samples: 0, lastSpeed: 0 };
let quotaParkCountdownTimer = null;

function calculateSpeedFromMessages(messages) {
	let tokens = 0;
	let durationMs = 0;
	let samples = 0;
	let lastSpeed = 0;
	const list = Array.isArray(messages) ? messages : [];
	for (let i = 1; i < list.length; i++) {
		const prev = list[i - 1];
		const curr = list[i];
		if (curr?.role === "assistant" || curr?.message?.role === "assistant") {
			const u = curr.usage || curr.message?.usage;
			const outTok = Number(u?.output ?? 0);
			const tCurr = new Date(curr.timestamp || curr.message?.timestamp || 0).getTime();
			const tPrev = new Date(prev.timestamp || prev.message?.timestamp || 0).getTime();
			if (outTok > 0 && tCurr > tPrev) {
				const delta = tCurr - tPrev;
				if (delta >= 200 && delta <= 60000) {
					tokens += outTok;
					durationMs += delta;
					samples++;
					lastSpeed = outTok / (delta / 1000);
				}
			}
		}
	}
	return samples > 0 ? { tokens, durationMs, samples, lastSpeed } : undefined;
}

function recordSpeedSample(outputTokens, durationMs) {
	if (!speedDisplayEnabled || !(durationMs > 0) || !(outputTokens > 0)) return;
	const currentRate = outputTokens / (durationMs / 1000);
	speedStats.tokens += outputTokens;
	speedStats.durationMs += durationMs;
	speedStats.samples++;
	speedStats.lastSpeed = currentRate;
	renderSpeedChip(currentRate);
}

function renderSpeedChip(lastRate) {
	if (typeof $ !== "function") return;
	const stat = $("speedStat");
	if (!stat) return;
	const rateToUse = lastRate || speedStats.lastSpeed;
	if (!speedDisplayEnabled || (speedStats.samples === 0 && !rateToUse)) {
		stat.classList.add("hidden");
		updateFooterSep();
		return;
	}
	const formatRate = (r) => (r >= 100 ? r.toFixed(0) : r.toFixed(1));
	const lastStr = rateToUse ? formatRate(rateToUse) : null;
	const avgStr = speedStats.durationMs > 0 ? formatRate(speedStats.tokens / (speedStats.durationMs / 1000)) : null;
	stat.textContent = `⚡ ${lastStr ?? avgStr} tok/s`;
	stat.title = `Speed: latest ${lastStr ?? avgStr} tok/s · session avg: ${avgStr ?? lastStr} tok/s (${speedStats.samples} responses, ${speedStats.tokens.toLocaleString()} tokens)`;
	stat.classList.remove("hidden");
	updateFooterSep();
}

function updateFooterSep() {
	if (typeof $ !== "function") return;
	const sep = $("footerSep");
	if (!sep) return;
	const hasSpeed = !$("speedStat")?.classList.contains("hidden");
	const hasCost = !$("costStat")?.classList.contains("hidden");
	sep.classList.toggle("hidden", !(hasSpeed || hasCost));
}

function renderQuotaParkBanner(quotaPark) {
	const banner = $("quotaParkBanner");
	if (!banner) return;
	clearInterval(quotaParkCountdownTimer);
	quotaParkCountdownTimer = null;
	if (!quotaPark || !quotaPark.isParked || !(quotaPark.resumeAtMs > Date.now())) {
		banner.classList.add("hidden");
		return;
	}
	const descEl = $("parkCountdownText");
	const updateCountdown = () => {
		const remainingMs = Math.max(0, quotaPark.resumeAtMs - Date.now());
		if (remainingMs <= 0) {
			banner.classList.add("hidden");
			clearInterval(quotaParkCountdownTimer);
			return;
		}
		const totalSec = Math.ceil(remainingMs / 1000);
		const mins = Math.floor(totalSec / 60);
		const secs = totalSec % 60;
		const timeStr = new Date(quotaPark.resumeAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		descEl.textContent = `Auto-resuming in ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`} (at ${timeStr}) · Park #${quotaPark.parkCount ?? 1}`;
	};
	updateCountdown();
	quotaParkCountdownTimer = setInterval(updateCountdown, 1000);
	banner.classList.remove("hidden");
}

function findSessionUsage(id) {
	if (!id || typeof catalogSessions === "undefined" || !Array.isArray(catalogSessions)) return undefined;
	const found = catalogSessions.find((s) => s.id === id || s.sessionId === id || s.activeSessionId === id);
	return found?.usage;
}

function refreshHeader(state) {
	$("title").textContent = state?.sessionName || `Session ${String(state?.sessionId ?? active?.id ?? "").slice(0, 8)}`;
	const percent = state?.contextUsage?.percent;
	$("ctxChip").textContent = percent == null ? "" : `ctx ${percent}%`;
	$("ctxChip").classList.toggle("hidden", percent == null);

	const costStat = $("costStat");
	if (costStat) {
		const usage = state?.usage || active?.usage || findSessionUsage(active?.id || active?.sessionId || state?.sessionId);
		if (usage && (usage.cost > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)) {
			const costStr = typeof usage.cost === "number" && usage.cost > 0
				? `$${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`
				: "";
			const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
			const tokensStr = typeof formatTokens === "function" ? formatTokens(totalTokens) : String(totalTokens);
			costStat.textContent = costStr ? `${costStr} (${tokensStr})` : `${tokensStr} tok`;
			costStat.title = `Total session spend: ${costStr || "$0.00"} · In: ${(usage.inputTokens || 0).toLocaleString()} · Out: ${(usage.outputTokens || 0).toLocaleString()}`;
			costStat.classList.remove("hidden");
		} else {
			costStat.classList.add("hidden");
		}
		if (typeof updateFooterSep === "function") updateFooterSep();
	}

	const cwd = state?.cwd || active?.cwd;
	const cwdChip = $("cwdChip");
	const cwdChipText = $("cwdChipText");
	if (cwdChip && cwdChipText) {
		if (cwd) {
			cwdChipText.textContent = formatDisplayPath(cwd);
			cwdChip.title = `Working directory: ${cwd}`;
			cwdChip.classList.remove("hidden");
		} else {
			cwdChip.classList.add("hidden");
		}
	}

	$("modelBtn").disabled = false;
	$("thinking").disabled = false;
	enableHeaderButtons(true);
	renderGoalBanner(state?.goal ?? null);
	renderQuotaParkBanner(state?.quotaPark);
	renderSpeedChip();
}

function enableHeaderButtons(enabled) {
	for (const id of ["moreBtn"]) {
		const btn = $(id);
		if (btn) btn.disabled = !enabled || !active;
	}
}

async function refreshModelPicker(state) {
	const session = active;
	$("modelLabel").textContent = state?.model?.id ?? "Model";
	if (!session) return;
	try {
		const { models } = await api(`/api/models?sessionId=${encodeURIComponent(session.id)}`);
		if (active !== session) return;
		modelCache = models ?? [];
	} catch (error) {
		console.warn("model list failed", error);
	}
}

function refreshThinkingPicker(state) {
	const select = $("thinking");
	const levels = [...new Set((state?.availableThinkingLevels ?? []).filter((level) => typeof level === "string"))];
	// A partial/older snapshot can briefly omit the catalog. Do not erase a
	// valid effort list in that window; the next state sync will replace it.
	if (!levels.length) return;
	select.replaceChildren();
	for (const level of levels) select.append(new Option(level, level));
	const current = state?.thinkingLevel ?? "off";
	select.value = levels.includes(current) ? current : levels[0];
}

function setWelcome(show) {
	$("welcome").classList.toggle("hidden", !show);
	$("chatCol")?.classList.toggle("hidden", show);
	$("transcript").classList.toggle("hidden", show);
	$("composer").classList.toggle("hidden", show);
}

function hydrateStreamingMessage(message, isStreaming) {
	if (!message && !isStreaming) return;
	setBusy(true);
	showTyping();
	const state = freshRun();
	run = state;
	if (!message || !Array.isArray(message.content)) return;

	for (let i = 0; i < message.content.length; i++) {
		const part = message.content[i];
		const isLast = i === message.content.length - 1;
		if (part.type === "toolCall" && part.id) {
			if (state.thinking) closeThinking();
			state.assistant = null;
			toolCard(part.id, part.name, JSON.stringify(part.arguments ?? {}, null, 2), message.timestamp);
		} else if (part.type === "thinking" && part.thinking) {
			if (state.assistant) {
				flushAssistantMarkdown();
				state.assistant = null;
			}
			const block = thinkingBlock();
			state.thinkingRaw = part.thinking;
			renderMarkdownInto(block, part.thinking);
			if (!isLast || !isStreaming) {
				closeThinking();
			}
		} else if (part.type === "text" && part.text) {
			if (state.thinking) closeThinking();
			state.assistant = null;
			const bubble = assistantBubble();
			bubble.classList.add("streaming");
			state.assistantRaw = part.text;
			state.streamingRendered = true;
			renderMarkdownInto(bubble, state.assistantRaw);
		}
	}
	scroll();
}

function applySessionSnapshot(snapshot, sequence, force = false) {
	if (!active || !snapshot || !snapshot.state) return;
	if (!force && sequence !== undefined && active.snapshotSequence !== undefined && sequence < active.snapshotSequence) return;
	if (sequence !== undefined) active.snapshotSequence = sequence;
	const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
	const state = snapshot.state;
	if (state) {
		if (state.cwd) active.cwd = state.cwd;
		refreshHeader(state);
		refreshThinkingPicker(state);
	}
	if (force) {
		run = null;
	}
	if (snapshot.children && Array.isArray(snapshot.children) && active) {
		if (typeof renderSubagentCard === "function") {
			for (const child of snapshot.children) {
				if (child.status === "running" || child.status === "queued") {
					renderSubagentCard(child);
				}
			}
		}
		if (!active.runningSubagents) active.runningSubagents = new Map();
		active.runningSubagents.clear();
		for (const child of snapshot.children) {
			if (child.status === "running" || child.status === "queued") {
				active.runningSubagents.set(child.id, child);
			}
		}
		if (active.runningSubagents.size > 0) {
			setBusy(true);
			updateSubagentIndicator();
		} else {
			updateSubagentIndicator();
		}
	}
	const isServerStreaming = Boolean(snapshot.streamingMessage || state?.isStreaming);
	const hasSubagents = Boolean(active?.runningSubagents && active.runningSubagents.size > 0);
	if (!isServerStreaming && run && !force) {
		flushAssistantMarkdown();
		closeThinking();
		const finishedText = (run.assistantRaw || "").trim();
		run = null;
		if (!activeRetry && (!lastStopAt || Date.now() - lastStopAt > 2000)) {
			notifyDone(finishedText);
		}
	}
	if (!run || force) {
		renderMessages(messages);
		if (isServerStreaming || hasSubagents) {
			if (hasSubagents) {
				setBusy(true);
				updateSubagentIndicator();
			}
			if (isServerStreaming) {
				hydrateStreamingMessage(snapshot.streamingMessage, state?.isStreaming);
			}
		} else {
			setBusy(false);
			hideTyping();
		}
	}
}

function closeSessionEventStream() {
	clearTimeout(sessionReconnectTimer);
	sessionReconnectTimer = undefined;
	if (!active?.es) return;
	const es = active.es;
	active.es = null;
	es.onopen = es.onmessage = es.onerror = null;
	es.close();
}

function openSessionEventStream(session) {
	closeSessionEventStream();
	if (active !== session) return;
	const es = new EventSource(`/events?sessionId=${encodeURIComponent(session.id)}&token=${encodeURIComponent(token)}`);
	session.es = es;
	es.onopen = () => {
		if (active === session && session.es === es) {
			updateConnectionStatus();
		}
	};
	es.onmessage = (event) => {
		if (active !== session || session.es !== es) return;
		try {
			const parsed = JSON.parse(event.data);
			lastSessionEventAt = Date.now();
			if (parsed && parsed.type === "heartbeat") return;
			handleEvent(parsed);
		} catch (error) {
			console.warn("invalid session event", error);
		}
	};
	if (typeof es.addEventListener === "function") {
		es.addEventListener("ping", () => {
			if (active === session && session.es === es) {
				lastSessionEventAt = Date.now();
			}
		});
	}
	es.onerror = () => {
		if (active !== session || session.es !== es) return;
		closeSessionEventStream();
		updateConnectionStatus();
		const tryReconnect = () => {
			sessionReconnectTimer = setTimeout(async () => {
				sessionReconnectTimer = undefined;
				if (active !== session) return;
				try {
					const snap = await api("/api/session", {
						method: "POST",
						body: JSON.stringify({
							activeSessionId: session.id,
							...(session.sessionFile ? { sessionPath: session.sessionFile } : {}),
						}),
					});
					if (active !== session) return;
					if (snap.activeSessionId) {
						session.id = snap.activeSessionId;
						active.id = snap.activeSessionId;
						highlightSession(snap.activeSessionId);
					}
					if (snap.state?.sessionFile) {
						session.sessionFile = snap.state.sessionFile;
					}
					session.snapshotSequence = snap.streamSequence;
					active.snapshotSequence = snap.streamSequence;
					applySessionSnapshot(snap, snap.streamSequence, true);
					openSessionEventStream(session);
				} catch {
					if (active === session) {
						tryReconnect();
					}
				}
			}, 2000);
		};
		tryReconnect();
	};
}

function rosterSessionKey(session) {
	return session.sessionId ?? session.id;
}

function isSubagentSession(session) {
	return session?.runtimeKind === "subagent" || Boolean(session?.rlmChildId);
}

function filterSidebarSessions(sessions) {
	return sessions.filter((session) => !isSubagentSession(session));
}

function mergeRosterIntoCatalog() {
	const byKey = new Map(filterSidebarSessions(catalogSessions).map((session) => [rosterSessionKey(session), session]));
	for (const session of filterSidebarSessions([...rosterEntries.values()])) {
		const key = rosterSessionKey(session);
		const existing = byKey.get(key);
		if (existing) {
			const merged = { ...existing };
			for (const [field, value] of Object.entries(session)) {
				if (value !== undefined) merged[field] = value;
			}
			byKey.set(key, merged);
		} else {
			byKey.set(key, session);
		}
	}
	return [...byKey.values()];
}

function handleRosterEvent(event) {
	if (event.type === "roster.connected") {
		if (!event.available) {
			rosterEntries.clear();
			renderSidebarSessions(catalogSessions);
		}
		return;
	}
	if (event.type === "roster.snapshot") {
		rosterEntries = new Map((event.entries ?? []).map((entry) => [entry.agentId, entry.summary ?? entry]));
	} else if (event.type === "roster.update") {
		if (event.resync) rosterEntries.clear();
		for (const entry of event.changed ?? []) rosterEntries.set(entry.agentId, entry.summary ?? entry);
		for (const agentId of event.removed ?? []) rosterEntries.delete(agentId);
	} else {
		return;
	}
	if (typeof renderSidebarSessions === "function" && typeof mergeRosterIntoCatalog === "function") renderSidebarSessions(mergeRosterIntoCatalog());
}

function closeRosterStream() {
	clearTimeout(rosterReconnectTimer);
	rosterReconnectTimer = undefined;
	const es = rosterEs;
	rosterEs = null;
	if (es) {
		es.onopen = es.onmessage = es.onerror = null;
		es.close();
	}
}

function connectRosterStream() {
	closeRosterStream();
	if (document.visibilityState !== "visible") return;
	const suffix = rosterLastEventId ? `&lastEventId=${encodeURIComponent(rosterLastEventId)}` : "";
	const es = new EventSource(`/events/roster?token=${encodeURIComponent(token)}${suffix}`);
	rosterEs = es;
	es.onopen = () => {
		if (rosterEs === es) {
			updateConnectionStatus();
			void refreshSessions().catch(() => undefined);
		}
	};
	es.onmessage = (event) => {
		if (rosterEs !== es) return;
		rosterLastEventId = event.lastEventId || rosterLastEventId;
		try { handleEvent(JSON.parse(event.data)); } catch (error) { console.warn("invalid roster event", error); }
	};
	es.onerror = () => {
		if (rosterEs !== es) return;
		closeRosterStream();
		updateConnectionStatus();
		if (document.visibilityState === "visible") {
			rosterReconnectTimer = setTimeout(() => {
				rosterReconnectTimer = undefined;
				connectRosterStream();
			}, 2000);
		}
	};
}

async function attach(snap) {
	closeSessionEventStream();
	hideTyping();
	setWelcome(false);
	toolCards.clear();
	sideCards.clear();
	if (typeof refinementCards !== "undefined") refinementCards.clear();
	run = null;
	activeRetry = null;
	setBusy(false);
	const session = {
		id: snap.activeSessionId,
		sessionId: snap.sessionId ?? snap.state?.sessionId,
		sessionFile: snap.state?.sessionFile,
		cwd: snap.state?.cwd || snap.cwd,
		hasRunningRlmChildren: snap.state?.hasRunningRlmChildren ?? snap.hasRunningRlmChildren,
		runningSubagents: new Map(),
		es: null,
		snapshotSequence: snap.streamSequence,
	};
	if (Array.isArray(snap.children)) {
		for (const child of snap.children) {
			if (child.status === "running" || child.status === "queued") {
				session.runningSubagents.set(child.id, child);
			}
		}
	}
	active = session;
	modelCache = [];
	closeModelMenu();
	const computedSpeed = typeof calculateSpeedFromMessages === "function" ? calculateSpeedFromMessages(snap.messages) : undefined;
	if (computedSpeed) speedStats = computedSpeed;
	if (snap.state) {
		if (snap.state?.cwd) active.cwd = snap.state.cwd;
		refreshHeader(snap.state);
		refreshThinkingPicker(snap.state);
		await refreshModelPicker(snap.state);
	} else {
		refreshHeader({ sessionId: snap.activeSessionId });
	}
	renderMessages(snap.messages ?? []);
	// Render all subagents recorded in session snapshot (both active and completed)
	if (Array.isArray(snap.children) && typeof renderSubagentCard === "function") {
		for (const child of snap.children) {
			if (child) {
				renderSubagentCard(child);
			}
		}
	}
	const hasSubagents = session.runningSubagents.size > 0;
	if (snap.streamingMessage || snap.state?.isStreaming || hasSubagents) {
		if (hasSubagents) {
			setBusy(true);
			updateSubagentIndicator();
		}
		if (snap.streamingMessage || snap.state?.isStreaming) {
			hydrateStreamingMessage(snap.streamingMessage, snap.state?.isStreaming);
		}
	} else {
		setBusy(false);
		hideTyping();
	}
	if (active !== session) return;
	scroll(true);
	void loadCommands(snap.activeSessionId);
	openSessionEventStream(session);
	highlightSession(snap.activeSessionId);
}

function handleEvent(evt) {
	if (evt.type === "roster.connected" || evt.type === "roster.snapshot" || evt.type === "roster.update") {
		handleRosterEvent(evt);
		return;
	}
	lastSessionEventAt = Date.now();
	if (evt.type === "snapshot") {
		if (!active || evt.sessionId === active.id) applySessionSnapshot(evt.snapshot, evt.sequence);
		return;
	}
	if (evt.type === "session_event") return handleSessionEvent(evt.event);
	if (evt.type === "extension_ui_request") return showDialog(evt.request);
	if (evt.type === "side_question_event") return handleSideQuestion(evt.event);
	if (evt.type === "session_replaced" || evt.type === "session_resynced") return resync();
	if (evt.type === "closed") {
		closeSessionEventStream();
		hideTyping();
		setBusy(false);
		run = null;
		appendNode(el("div", "notice", "Session closed."));
		scroll();
	}
}


let composerImages = [];

function handleImageFiles(files) {
	for (const file of files) {
		if (!file || !file.type.startsWith("image/")) continue;
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") return;
			const commaIdx = result.indexOf(",");
			const base64Data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
			composerImages.push({
				data: base64Data,
				mimeType: file.type || "image/png",
				filename: file.name || "image.png",
				previewUrl: result,
			});
			renderComposerAttachments();
		};
		reader.readAsDataURL(file);
	}
}

function renderComposerAttachments() {
	if (typeof $ !== "function") return;
	const container = $("composerAttachments");
	if (!container) return;
	if (composerImages.length === 0) {
		container.classList.add("hidden");
		container.replaceChildren();
		return;
	}
	container.replaceChildren();
	composerImages.forEach((img, idx) => {
		const pill = el("div", "attachment-pill");
		const thumb = el("img");
		thumb.src = img.previewUrl;
		thumb.alt = img.filename;
		const name = el("span", "", img.filename.length > 18 ? img.filename.slice(0, 15) + "…" : img.filename);
		const removeBtn = el("span", "remove-att", "✕");
		removeBtn.onclick = (e) => {
			e.stopPropagation();
			composerImages.splice(idx, 1);
			renderComposerAttachments();
		};
		pill.append(thumb, name, removeBtn);
		container.append(pill);
	});
	container.classList.remove("hidden");
}

function freshRun() {
	return {
		startedAt: Date.now(),
		assistant: null, thinking: null,
		assistantRaw: "", renderedAt: 0, streamingRendered: false,
		thinkingRaw: "", thinkingRenderedAt: 0, thinkingText: null, thinkingPending: "",
	};
}

function ensureRun() {
	if (!run) run = freshRun();
	return run;
}

function handleSessionEvent(event) {
	switch (event.type) {
		case "agent_start":
			setBusy(true);
			run = freshRun();
			showTyping();
			if (active) {
				const activeKey = active.sessionId ?? active.id;
				previousSessionWorkingState.set(activeKey, true);
				if (active.id) previousSessionWorkingState.set(active.id, true);
				if (active.sessionId) previousSessionWorkingState.set(active.sessionId, true);
			}
			promoteSidebarSession(active?.id);
			if (typeof renderSidebarSessions === "function" && typeof mergeRosterIntoCatalog === "function") renderSidebarSessions(mergeRosterIntoCatalog());
			void refreshSessions().catch(() => undefined);
			break;
		case "turn_start":
			ensureRun();
			if (run) {
				closeThinking();
				if (run.assistant) flushAssistantMarkdown();
				run.assistant = null;
			}
			setBusy(true);
			showTyping();
			if (typeof typingEl !== "undefined" && typingEl) {
				typingEl.querySelector(".retry-note")?.remove();
			}
			break;
		case "rlm_child_update": {
			const child = event.child;
			if (!child || !active) break;
			if (typeof renderSubagentCard === "function") {
				let anchor = null;
				if (!subagentCards.has(child.id)) {
					const allCards = [...toolCards.values()];
					const lastTool = allCards[allCards.length - 1];
					if (lastTool && lastTool.root) anchor = lastTool.root;
				}
				renderSubagentCard(child, Date.now(), anchor);
			}
			if (!active.runningSubagents) active.runningSubagents = new Map();
			if (child.status === "queued" || child.status === "running") {
				active.runningSubagents.set(child.id, child);
				active.hasRunningRlmChildren = true;
				setBusy(true);
				updateSubagentIndicator();
				promoteSidebarSession(active?.id);
			} else {
				active.runningSubagents.delete(child.id);
				updateSubagentIndicator();
				if (active.runningSubagents.size === 0) {
					active.hasRunningRlmChildren = false;
					if (!run && !active.isStreaming) {
						setBusy(false);
						hideTyping();
						notifyDone("Subagent finished");
					}
				}
			}
			void refreshSessions().catch(() => undefined);
			break;
		}
		case "agent_end": {
			const lastAssistant = Array.isArray(event.messages)
				? [...event.messages].reverse().find((m) => m && m.role === "assistant")
				: null;
			const textFromContent = lastAssistant?.content
				? textOf(lastAssistant.content)
				: "";
			const finishedText = (run?.assistantRaw || textFromContent || "").trim();

			flushAssistantMarkdown();
			closeThinking();
			if (typeof recordSpeedSample === "function" && lastAssistant?.usage?.output && run?.startedAt) {
				const durationMs = Math.max(1, Date.now() - run.startedAt);
				recordSpeedSample(Number(lastAssistant.usage.output), durationMs);
			}
			// A crash or missed event may have orphaned a streaming caret — clear it.
			for (const bubble of transcript.querySelectorAll(".bubble.streaming")) bubble.classList.remove("streaming");

			const hasRunningSubagents = Boolean(active?.runningSubagents && active.runningSubagents.size > 0);
			if (hasRunningSubagents) {
				// Parent model turn finished, but subagents are still actively running in background
				run = null;
				setBusy(true);
				updateSubagentIndicator();
			} else {
				hideTyping();
				setBusy(false);
				run = null;
				if (active) {
					const activeKey = active.sessionId ?? active.id;
					previousSessionWorkingState.set(activeKey, false);
					if (active.id) previousSessionWorkingState.set(active.id, false);
					if (active.sessionId) previousSessionWorkingState.set(active.sessionId, false);
				}
				if (typeof renderSidebarSessions === "function" && typeof mergeRosterIntoCatalog === "function") renderSidebarSessions(mergeRosterIntoCatalog());

				// A run is complete when it ends normally without intermediate toolUse, error, abort, or active retry
				const isIntermediateToolTurn = Boolean(lastAssistant?.stopReason === "toolUse");
				const isErrorOrAborted = Boolean(
					isIntermediateToolTurn ||
					lastAssistant?.errorMessage ||
					lastAssistant?.stopReason === "error" ||
					lastAssistant?.stopReason === "aborted" ||
					(lastStopAt && Date.now() - lastStopAt <= 2000)
				);
				const isComplete = !isErrorOrAborted && Boolean(activeRetry) === false;

				if (isComplete) {
					notifyDone(finishedText);
				} else if (lastAssistant?.errorMessage || lastAssistant?.stopReason === "error") {
					const errObj = lastAssistant?.errorMessage || "Model request error";
					appendNode(createErrorCard(errObj, lastAssistant?.stopReason));
					scroll(true);
					const { title, advice } = parseDetailedError(errObj, lastAssistant?.stopReason);
					showToast(title, advice, "error");
				}
			}

			// Reconcile the sidebar immediately; the 2.5 s catalog poll remains the
			// fallback when this tab missed the event from another client.
			void refreshSessions().catch(() => undefined);
			break;
		}
		case "auto_retry_start": {
			activeRetry = {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
			setBusy(true);
			showTyping();
			if (typeof typingEl !== "undefined" && typingEl) {
				let note = typingEl.querySelector(".retry-note");
				if (!note) {
					note = el("span", "retry-note");
					typingEl.append(note);
				}
				const secs = Math.max(1, Math.ceil((event.delayMs || 1000) / 1000));
				note.textContent = `Retrying (${event.attempt}/${event.maxAttempts}) in ${secs}s...`;
			}
			promoteSidebarSession(active?.id);
			break;
		}
		case "auto_retry_end": {
			activeRetry = null;
			if (typeof typingEl !== "undefined" && typingEl) {
				typingEl.querySelector(".retry-note")?.remove();
			}
			if (!event.success) {
				showToast("Retry failed", event.finalError || `Retry failed after ${event.attempt} attempts`, "error");
			}
			break;
		}
		case "turn_end":
			flushAssistantMarkdown();
			closeThinking();
			if (run) run.assistant = null;
			break;
		case "message_update": {
			const ae = event.assistantMessageEvent;
			if (!ae) break;
			if (!run) {
				ensureRun();
				setBusy(true);
				showTyping();
			}
			if (ae.type === "text_start" || ae.type === "text_delta") {
				// a text segment after an open thinking box starts a NEW bubble
				if (run.thinking) closeThinking();
				appendAssistantDelta(ae.delta ?? "");
			}
			if (ae.type === "text_end") {
				flushAssistantMarkdown();
				if (run) run.assistant = null;
			}
			if (ae.type === "thinking_start") {
				// each thinking block is its own box; an open one must finalize first
				if (run.assistant) {
					flushAssistantMarkdown();
					run.assistant = null;
				}
				closeThinking();
				showTyping();
			}
			if (ae.type === "thinking_delta") {
				showTyping();
				if (ae.delta) {
					const state = ensureRun();
					if (!state.thinking) thinkingBlock();
					state.thinkingRaw += ae.delta;
					if (!state.thinkingText) {
						state.thinkingText = document.createTextNode("");
						state.thinking.append(state.thinkingText);
					}
					// Stream through ONE persistent text node, painted once per frame:
					// no full-text replacement, no per-delta repaint strobing.
					state.thinkingPending += ae.delta;
					queueThinkingPaint();
				}
			}
			if (ae.type === "thinking_end") {
				closeThinking();
				scroll();
			}
			if (ae.type === "error" || ae.error) {
				flushAssistantMarkdown();
				closeThinking();
				appendNode(createErrorCard(ae.error || ae.errorMessage || "Stream error", "error"));
				scroll(true);
			}
			break;
		}
		case "tool_execution_start":
			if (run?.thinking) closeThinking();
			if (run?.assistant) {
				flushAssistantMarkdown();
				// Convert pre-tool monologue bubble into a clean thinking block
				run.assistant.classList.remove("bubble", "assistant");
				run.assistant.classList.add("thinking");
				run.assistant = null;
			}
			showTyping();
			toolCard(event.toolCallId, event.toolName ?? "tool", JSON.stringify(event.args ?? {}, null, 2));
			break;
		case "tool_execution_update": {
			const card = toolCards.get(event.toolCallId);
			const text = textOf(event.partialResult?.content);
			if (card && text) {
				// Buffer per card, paint once per frame — chatty tools (bash, builds)
				// otherwise cost O(n²) in textContent appends.
				card.pending = (card.pending ? card.pending + "\n" : "") + text;
				queueToolPaint();
			}
			break;
		}
		case "tool_execution_end": {
			const card = toolCards.get(event.toolCallId);
			if (card) {
				const output = textOf(event.result?.content);
				let diff = event.result?.details?.diff;
				let displayOutput = output;
				if (!diff && output && (output.includes("diff --git") || (output.includes("--- a/") && output.includes("+++ b/")) || output.includes("@@ -"))) {
					const match = output.match(/(?:^|\n)(?:diff --git|--- [ab]\/|@@ -\d+)/);
					if (match && match.index !== undefined) {
						const startPos = match.index === 0 ? 0 : match.index + 1;
						displayOutput = output.slice(0, startPos).trim();
						diff = output.slice(startPos).trim();
					}
				}
				if (card.pending) { card.out.textContent += card.pending; card.pending = ""; }
				if (displayOutput) card.out.textContent += (card.out.textContent ? "\n" : "") + displayOutput;
				card.status.textContent = event.isError ? "error" : "done";
				card.status.className = "status " + (event.isError ? "error" : "ok");
				if (typeof diff === "string") renderEditDiff(card, diff);
				scroll();
			}
			break;
		}
		case "bash_start":
			if (run?.thinking) closeThinking();
			if (run?.assistant) {
				flushAssistantMarkdown();
				// Convert pre-tool monologue bubble into a clean thinking block
				run.assistant.classList.remove("bubble", "assistant");
				run.assistant.classList.add("thinking");
				run.assistant = null;
			}
			showTyping();
			toolCard(`bash-${event.command}-${Math.random()}`, "bash", `$ ${event.command}`);
			break;
		case "bash_output": {
			const cards = [...toolCards.values()];
			const last = cards[cards.length - 1];
			if (last && last.root.querySelector(".name")?.textContent === "bash") {
				last.pending = (last.pending ?? "") + (event.chunk ?? "");
				queueToolPaint();
			}
			break;
		}
		case "goal_update":
			if (event.goal) renderGoalBanner(event.goal);
			break;
		case "session_info_changed": $("title").textContent = event.name || active?.id || ""; break;
		case "thinking_level_changed": {
			const select = $("thinking");
			if (![...select.options].some((option) => option.value === event.level)) {
				select.append(new Option(event.level, event.level));
			}
			select.value = event.level;
			break;
		}
		case "refine_complete":
			if (event.result && typeof renderRefinementCard === "function") {
				renderRefinementCard(event);
			}
			break;
		case "refine_failed":
			showToast("Refinement failed", event.error || "Continual harness refinement failed", "error");
			break;
		case "compaction_start":
			showToast("Compacting context", "Compressing prior conversation tokens...", "info");
			break;
		case "compaction_end":
			if (event.result) {
				renderCompactionCard({
					summary: event.result.summary,
					tokensBefore: event.result.tokensBefore,
					customInstructions: event.customInstructions,
					timestamp: Date.now(),
				});
			} else if (event.errorMessage) {
				showToast("Compaction error", event.errorMessage, "error");
			}
			break;
		case "message_end":
			if (event.message && typeof renderMessage === "function") {
				const r = event.message.role;
				if (r === "custom" || r === "compactionSummary" || r === "branchSummary") {
					renderMessage(event.message);
				}
			}
			break;
		default: break;
	}
}

function handleSideQuestion(event) {
	let entry = sideCards.get(event.id);
	if (!entry) {
		const box = el("div", "sideq");
		box.append(el("div", "q", event.question));
		const answer = el("div", "a", event.answer ?? "");
		box.append(answer);
		appendNode(box);
		entry = { box, answer };
		sideCards.set(event.id, entry);
	}
	renderMarkdownInto(entry.answer, event.answer ?? "");
	if (event.status === "error" && event.errorMessage) entry.answer.textContent += `\n[error] ${event.errorMessage}`;
	scroll();
}

async function resync() {
	hideTyping();
	const session = active;
	if (!session) return;
	try {
		const snap = await api(`/api/state?sessionId=${encodeURIComponent(session.id)}`);
		if (active !== session) return;
		refreshHeader(snap.state);
		refreshThinkingPicker(snap.state);
		// Always render from the authoritative snapshot — the daemon sends
		// catchup snapshots when we missed events (reconnects, another client
		// touching the session). Re-establish the run so deltas keep building.
		renderMessages(snap.messages ?? []);
		const isStillStreaming = Boolean(snap.state?.isStreaming);
		if (snap.streamingMessage || isStillStreaming) {
			hydrateStreamingMessage(snap.streamingMessage, isStillStreaming);
		} else {
			setBusy(false);
			run = null;
			hideTyping();
		}
	} catch (error) {
		console.warn("resync failed", error);
	}
}

// ---------------------------------------------------------------------------
// Extension dialogs (approvals)
// ---------------------------------------------------------------------------

function respond(id, payload) {
	return api("/api/dialog", { method: "POST", body: JSON.stringify({ sessionId: active.id, id, ...payload }) });
}

function showDialog(request) {
	openModal({
		title: request.payload?.title ?? "Prime Agent asks",
		message: request.payload?.message ?? "",
		build(body, actions, close) {
			const finish = (payload) => {
				close();
				respond(request.id, payload).catch(console.error);
			};
			const method = request.payload?.input?.kind ?? request.method;
			if (method === "select" && Array.isArray(request.payload?.options)) {
				for (const option of request.payload.options) {
					const button = el("button", "", String(option));
					button.onclick = () => finish({ value: String(option) });
					body.append(button);
				}
			} else if (method === "confirm") {
				const yes = el("button", "", "Yes"), no = el("button", "", "No");
				yes.onclick = () => finish({ confirmed: true });
				no.onclick = () => finish({ confirmed: false });
				body.append(yes, no);
			} else {
				const field = el("input");
				field.placeholder = request.payload?.placeholder ?? "";
				if (method === "text" && request.payload?.input?.value) field.value = request.payload.input.value;
				const submit = el("button", "", "Submit");
				submit.onclick = () => finish({ value: field.value });
				field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit.click(); } });
				body.append(field, submit);
				field.focus();
			}
			const cancel = actions.querySelector("button");
			if (cancel) cancel.onclick = () => { close(); respond(request.id, { cancelled: true }).catch(console.error); };
		},
	});
}

// ---------------------------------------------------------------------------
// Transcript visibility toggles (thinking / tool calls)
// ---------------------------------------------------------------------------

let showThinking = localStorage.getItem("primeAgentShowThinking") !== "0";
let showToolCalls = localStorage.getItem("primeAgentShowToolCalls") !== "0";

function applyVisibility() {
	transcript.classList.toggle("hide-thinking", !showThinking);
	transcript.classList.toggle("hide-toolcalls", !showToolCalls);
	const thinkingCheck = $("menuThinkingCheck");
	const toolCallsCheck = $("menuToolCallsCheck");
	if (thinkingCheck) thinkingCheck.textContent = showThinking ? "✓" : "";
	if (toolCallsCheck) toolCallsCheck.textContent = showToolCalls ? "✓" : "";
	const soundCheck = $("menuSoundCheck");
	if (soundCheck) soundCheck.textContent = soundEnabled ? "✓" : "";
	const speedCheck = $("menuSpeedCheck");
	if (speedCheck) speedCheck.textContent = speedDisplayEnabled ? "✓" : "";
}

function toggleThinkingPref() {
	showThinking = !showThinking;
	localStorage.setItem("primeAgentShowThinking", showThinking ? "1" : "0");
	applyVisibility();
}

function toggleToolCallsPref() {
	showToolCalls = !showToolCalls;
	localStorage.setItem("primeAgentShowToolCalls", showToolCalls ? "1" : "0");
	applyVisibility();
}

async function reloadConfig() {
	const result = await api("/api/reload", { method: "POST", body: JSON.stringify({ sessionId: active.id }) });
	cmdCache.set(active.id, mergeBuiltins(await loadCommands(active.id)));
	if (result.state) {
		refreshThinkingPicker(result.state);
		refreshHeader(result.state);
	}
}

// checkable rows: biarkan dropdown tetap terbuka saat toggle
$("menuSound").addEventListener("click", () => toggleSoundPref());
$("menuSpeed").addEventListener("click", () => {
	closeMoreMenu();
	void BUILTIN_HANDLERS.speed();
});
const parkDismissBtn = $("parkDismissBtn");
if (parkDismissBtn) {
	parkDismissBtn.addEventListener("click", () => {
		$("quotaParkBanner")?.classList.add("hidden");
	});
}
$("menuTestSound").addEventListener("click", () => {
	closeMoreMenu();
	soundEnabled = true;
	localStorage.setItem("primeAgentSound", "1");
	applyVisibility();
	ensureAudio();
	playDoneSound();
});
$("menuThinking").addEventListener("click", () => toggleThinkingPref());
$("menuToolCalls").addEventListener("click", () => toggleToolCallsPref());
$("menuRefine").addEventListener("click", () => { closeMoreMenu(); if (active) openRefineModal(); });
$("menuGoal").addEventListener("click", () => { closeMoreMenu(); if (active) openGoalModal(); });
async function handleClearGoalAction() {
	if (!active) return;
	const banner = $("goalBanner");
	const chip = $("goalChip");

	// 1. Immediately dismiss locally and hide from UI
	dismissGoalBanner();
	if (banner) banner.classList.add("hidden");
	if (chip) chip.classList.add("hidden");

	// 2. Always persist clear on the backend session via /goal clear
	try {
		await api("/api/prompt", {
			method: "POST",
			body: JSON.stringify({ sessionId: active.id, message: "/goal clear" }),
		});
		showToast("Goal cleared", "Goal cleared from session", "info");
	} catch (error) {
		console.warn("Prime Agent web: error clearing goal:", error);
		showToast("Error", error.message, "error");
	}
}

$("goalPauseBtn").addEventListener("click", async () => {
	if (!active || !activeGoal) return;
	let cmd;
	if (activeGoal.status === "paused" || activeGoal.status === "budget_limited") {
		cmd = "/goal resume";
	} else if (activeGoal.status === "error" || activeGoal.status === "complete") {
		cmd = `/goal ${activeGoal.objective}`;
		if (typeof activeGoal.tokenBudget === "number" && activeGoal.tokenBudget > 0) {
			cmd += ` --budget ${activeGoal.tokenBudget}`;
		}
		if (typeof activeGoal.maxTurns === "number" && activeGoal.maxTurns > 0) {
			cmd += ` --turns ${activeGoal.maxTurns}`;
		}
	} else {
		cmd = "/goal pause";
	}
	try {
		await api("/api/prompt", {
			method: "POST",
			body: JSON.stringify({ sessionId: active.id, message: cmd }),
		});
	} catch (error) {
		showToast("Error", error.message, "error");
	}
});
$("goalEditBtn").addEventListener("click", () => {
	if (active) openGoalModal();
});
$("goalClearBtn").addEventListener("click", () => handleClearGoalAction());
$("goalToggleBtn").addEventListener("click", () => {
	const banner = $("goalBanner");
	const chevron = $("goalChevron");
	const summaryLine = $("goalSummaryLine");
	if (!banner || !chevron) return;
	const collapsed = banner.classList.toggle("collapsed");
	chevron.textContent = collapsed ? "▸" : "▾";
	if (summaryLine) summaryLine.classList.toggle("hidden", !collapsed);
});
$("goalChip").addEventListener("click", () => {
	const banner = $("goalBanner");
	const chevron = $("goalChevron");
	const summaryLine = $("goalSummaryLine");
	if (banner) {
		banner.classList.remove("collapsed");
		if (chevron) chevron.textContent = "▾";
		if (summaryLine) summaryLine.classList.add("hidden");
		banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}
});
$("menuCompact").addEventListener("click", () => { closeMoreMenu(); if (active) BUILTIN_HANDLERS.compact("").catch((e) => showToast("Error", e.message, "error")); });
$("menuFork").addEventListener("click", () => { closeMoreMenu(); if (active) openForkPicker(); });
$("menuClone").addEventListener("click", () => { closeMoreMenu(); if (active) BUILTIN_HANDLERS.clone().catch((e) => showToast("Error", e.message, "error")); });
$("menuReload").addEventListener("click", () => { closeMoreMenu(); if (active) reloadConfig().catch((e) => showToast("Error", e.message, "error")); });
$("menuAsk").addEventListener("click", () => { closeMoreMenu(); if (active) openSideQuestion(); });
$("menuPanel").addEventListener("click", () => { closeMoreMenu(); if (active) openToolsPanel(); });
$("menuChangePassword").addEventListener("click", () => { closeMoreMenu(); openChangePasswordModal(); });

applyVisibility();

// ---------------------------------------------------------------------------
// Header actions: compact / fork / clone / side question
// ---------------------------------------------------------------------------

async function executeFork(entryId, position) {
	if (!active) return;
	setBusy(true);
	showTyping();
	try {
		const res = await api("/api/fork", {
			method: "POST",
			body: JSON.stringify({ sessionId: active.id, entryId, position }),
		});
		if (res.cancelled) return;

		// If position is "before", populate the composer input with the branched prompt text for immediate re-editing
		if (position === "before" && res.selectedText) {
			input.value = res.selectedText;
			resizeInput();
			input.focus();
		}

		// Update active session metadata and transcript
		if (res.state && res.messages) {
			active.sessionId = res.state.sessionId;
			active.sessionFile = res.state.sessionFile;
			if (res.state.cwd) active.cwd = res.state.cwd;
			refreshHeader(res.state);
			refreshThinkingPicker(res.state);
			await refreshModelPicker(res.state);
			renderMessages(res.messages);
		} else {
			await resync();
		}
		await refreshSessions();
		showToast(
			"Forked to new session",
			position === "before"
				? "Branched before prompt: prompt loaded into input for editing"
				: "Branched session up to this prompt",
			"info"
		);
	} catch (error) {
		showToast("Fork error", error.message, "error");
	} finally {
		setBusy(false);
		hideTyping();
	}
}

async function forkAtPromptText(text, position) {
	if (!active) return;
	setBusy(true);
	showTyping();
	try {
		const { messages } = await api(`/api/fork-messages?sessionId=${encodeURIComponent(active.id)}`);
		if (!messages || messages.length === 0) {
			showToast("Fork error", "No user messages available to fork in this session", "error");
			return;
		}
		const trimmed = text.trim();
		const target = messages.find((m) => m.text.trim() === trimmed) ||
			messages.find((m) => m.text.trim().startsWith(trimmed.slice(0, 50))) ||
			messages[messages.length - 1];

		if (!target) {
			showToast("Fork error", "Could not locate the message entry in session tree", "error");
			return;
		}
		await executeFork(target.entryId, position);
	} catch (error) {
		showToast("Fork error", error.message, "error");
	} finally {
		setBusy(false);
		hideTyping();
	}
}

function openForkModalForMessage(text, timestamp) {
	if (!active) return;
	openModal({
		title: "Fork Conversation from Prompt",
		message: "Branch the conversation into a new session starting from this prompt turn.",
		build(body, actions, close) {
			const promptBox = el("div", "fork-modal-prompt");
			const promptHeader = el("div", "fork-modal-prompt-label");
			promptHeader.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> <span>SELECTED PROMPT TURN</span>';
			promptBox.append(promptHeader);
			promptBox.append(el("div", "fork-modal-prompt-text", text));
			body.append(promptBox);

			const choices = el("div", "fork-choices-grid");

			// Option 1: Branch & Edit
			const card1 = el("div", "fork-choice-card edit");
			const icon1 = el("div", "fork-choice-icon");
			icon1.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

			const content1 = el("div", "fork-choice-content");
			const head1 = el("div", "fork-choice-header");
			head1.append(el("span", "fork-choice-title", "Branch & Edit this Prompt"), el("span", "fork-choice-pill edit", "NEW DIRECTION"));
			const desc1 = el("p", "fork-choice-desc", "Creates a new session branching before this turn. The prompt will be loaded into your chat composer so you can edit and re-submit.");
			content1.append(head1, desc1);

			const arrow1 = el("div", "fork-choice-arrow");
			arrow1.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

			card1.append(icon1, content1, arrow1);
			card1.onclick = async () => {
				close();
				await forkAtPromptText(text, "before");
			};

			// Option 2: Branch Here
			const card2 = el("div", "fork-choice-card branch");
			const icon2 = el("div", "fork-choice-icon");
			icon2.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

			const content2 = el("div", "fork-choice-content");
			const head2 = el("div", "fork-choice-header");
			head2.append(el("span", "fork-choice-title", "Branch from Here (Keep Response)"), el("span", "fork-choice-pill branch", "MILESTONE"));
			const desc2 = el("p", "fork-choice-desc", "Preserves this prompt and the agent\'s response in the new session, allowing you to branch out from this exact point.");
			content2.append(head2, desc2);

			const arrow2 = el("div", "fork-choice-arrow");
			arrow2.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

			card2.append(icon2, content2, arrow2);
			card2.onclick = async () => {
				close();
				await forkAtPromptText(text, "at");
			};

			choices.append(card1, card2);
			body.append(choices);
		},
	});
}

function openForkPicker() {
	if (!active) return;
	openModal({
		title: "Fork Conversation",
		message: "Select a previous prompt turn to branch into a new session thread.",
		build(body, actions, close) {
			const loadingNotice = el("div", "notice", "Loading conversation prompts…");
			body.append(loadingNotice);

			api(`/api/fork-messages?sessionId=${encodeURIComponent(active.id)}`)
				.then(({ messages }) => {
					loadingNotice.remove();
					if (!messages?.length) {
						body.append(el("div", "notice", "No user prompts found to fork from yet in this session."));
						return;
					}

					// Search Filter Bar
					const searchWrap = el("div", "fork-search-wrap");
					searchWrap.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
					const searchInput = el("input");
					searchInput.type = "text";
					searchInput.placeholder = "Filter previous prompts…";
					searchInput.autocomplete = "off";
					searchInput.spellcheck = false;

					const countBadge = el("span", "fork-search-count", `${messages.length} prompts`);
					searchWrap.append(searchInput, countBadge);
					body.append(searchWrap);

					const listWrap = el("div", "fork-list");
					const indexed = messages.map((m, idx) => ({ ...m, turnNum: idx + 1 })).reverse();
					const cardElements = [];

					for (const item of indexed) {
						const card = el("div", "fork-item-card");
						card.dataset.text = (item.text || "").toLowerCase();

						const cardHead = el("div", "fork-item-head");
						const meta = el("div", "fork-item-meta");
						const turnBadge = el("span", "fork-turn-badge", `TURN #${item.turnNum}`);
						const charsBadge = el("span", "fork-turn-chars", `${(item.text || "").length} chars`);
						meta.append(turnBadge, charsBadge);

						const actionsBar = el("div", "fork-item-actions");
						const editBtn = el("button", "fork-action-btn edit", "");
						editBtn.type = "button";
						editBtn.title = "Branch before this prompt and edit it in composer";
						editBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> <span>Branch & Edit</span>';
						editBtn.onclick = async () => {
							close();
							await executeFork(item.entryId, "before");
						};

						const branchBtn = el("button", "fork-action-btn branch", "");
						branchBtn.type = "button";
						branchBtn.title = "Branch after this prompt (keep prompt & response)";
						branchBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg> <span>Branch Here</span>';
						branchBtn.onclick = async () => {
							close();
							await executeFork(item.entryId, "at");
						};

						actionsBar.append(editBtn, branchBtn);
						cardHead.append(meta, actionsBar);

						const promptPreview = el("div", "fork-item-text", item.text);
						card.append(cardHead, promptPreview);
						listWrap.append(card);
						cardElements.push(card);
					}
					body.append(listWrap);

					searchInput.oninput = () => {
						const query = searchInput.value.trim().toLowerCase();
						let visibleCount = 0;
						for (const card of cardElements) {
							const text = card.dataset.text || "";
							const match = !query || text.includes(query);
							card.style.display = match ? "" : "none";
							if (match) visibleCount++;
						}
						countBadge.textContent = query ? `${visibleCount} of ${messages.length}` : `${messages.length} prompts`;
					};
				})
				.catch((error) => {
					loadingNotice.remove();
					body.append(el("div", "notice error", error.message || "Failed to load messages for forking"));
				});
		},
	});
}

function openSideQuestion() {
	const session = active;
	openModal({
		title: "Side question",
		message: "Ask a quick question without touching the main conversation.",
		build(body, actions, close) {
			const field = el("textarea");
			body.append(field);
			const go = el("button", "", "Ask");
			go.onclick = async () => {
				const question = field.value.trim();
				if (!question || !session || active !== session) return;
				go.disabled = true;
				try {
					const { id } = await api("/api/side-question", {
						method: "POST",
						body: JSON.stringify({ sessionId: session.id, question }),
					});
					if (active !== session) return;
					close();
					if (sideCards.has(id)) return;
					const box = el("div", "sideq");
					box.append(el("div", "q", question));
					const answer = el("div", "a", "…");
					box.append(answer);
					appendNode(box);
					sideCards.set(id, { box, answer });
					scroll();
				} catch (error) { showToast("Error", error.message, "error"); go.disabled = false; }
			};
			actions.replaceChildren(go);
		},
	});
}

function openChangePasswordModal() {
	openModal({
		title: "Change Password",
		message: "Update the password used to access Prime Agent web.",
		build(body, actions, close) {
			const form = el("form", "dialog-form");
			const curPass = el("input");
			curPass.type = "password";
			curPass.placeholder = "Current password";
			curPass.required = true;
			curPass.autocomplete = "current-password";

			const newPass = el("input");
			newPass.type = "password";
			newPass.placeholder = "New password (min 4 chars)";
			newPass.required = true;
			newPass.autocomplete = "new-password";

			const confPass = el("input");
			confPass.type = "password";
			confPass.placeholder = "Confirm new password";
			confPass.required = true;
			confPass.autocomplete = "new-password";

			const errBox = el("div", "error hidden");

			form.append(
				el("label", "", "Current password:"), curPass,
				el("label", "", "New password:"), newPass,
				el("label", "", "Confirm new password:"), confPass,
				errBox,
			);
			body.append(form);

			const saveBtn = el("button", "", "Update Password");
			saveBtn.type = "submit";
			form.onsubmit = async (event) => {
				event.preventDefault();
				errBox.classList.add("hidden");
				if (newPass.value !== confPass.value) {
					errBox.textContent = "New passwords do not match.";
					errBox.classList.remove("hidden");
					return;
				}
				if (newPass.value.length < 4) {
					errBox.textContent = "Password must be at least 4 characters.";
					errBox.classList.remove("hidden");
					return;
				}
				saveBtn.disabled = true;
				try {
					await api("/api/change-password", {
						method: "POST",
						body: JSON.stringify({
							currentPassword: curPass.value,
							newPassword: newPass.value,
						}),
					});
					close();
					showToast("Password updated", "Your password has been changed successfully.");
				} catch (error) {
					errBox.textContent = error.message;
					errBox.classList.remove("hidden");
					saveBtn.disabled = false;
				}
			};
			actions.replaceChildren(saveBtn);
		},
	});
}

// ---------------------------------------------------------------------------
// Right panel: Files / Git / Jobs
// ---------------------------------------------------------------------------

function openToolsPanel() { togglePanel(panelState.tab ?? "files"); }
$("panelClose").addEventListener("click", () => togglePanel(null));
for (const button of $("panelTabs").querySelectorAll("button[data-tab]")) {
	button.addEventListener("click", () => togglePanel(button.dataset.tab));
}

function togglePanel(tab) {
	panelState.tab = tab;
	$("panel").classList.toggle("hidden", !tab);
	for (const button of $("panelTabs").querySelectorAll("button[data-tab]")) {
		button.classList.toggle("active", button.dataset.tab === tab);
	}
	if (tab === "files") void renderFiles();
	if (tab === "git") void renderGit();
	if (tab === "jobs") void renderJobs();
	if (tab === "terminal") void renderTerminal();
}

function panelBody() { return $("panelBody"); }

async function renderFiles() {
	const body = panelBody();
	body.replaceChildren();
	if (!active) { body.append(el("div", "notice", "No session open.")); return; }

	const pathForm = el("div", "panel-form");
	const pathInput = el("input");
	pathInput.value = panelState.path;
	pathInput.placeholder = "relative/path (empty = workspace root)";
	const go = el("button", "", "Go");
	pathForm.append(pathInput, go);
	pathForm.addEventListener("submit", (event) => {
		event.preventDefault();
		panelState.path = pathInput.value.trim();
		panelState.file = null;
		panelState.editing = false;
		void renderFiles();
	});
	body.append(pathForm);

	if (panelState.file) {
		const view = el("div", "fileview");
		view.append(el("div", "", `Editing: ${panelState.file.path}${panelState.file.truncated ? " (truncated preview)" : ""}`));
		const field = el("textarea");
		field.style.minHeight = "240px";
		field.value = panelState.file.content ?? "";
		const save = el("button", "", "Save");
		const close = el("button", "", "Close");
		save.onclick = async () => {
			try {
				await api("/api/fs/file", {
					method: "PUT",
					body: JSON.stringify({ sessionId: active.id, path: panelState.file.path, content: field.value }),
				});
				panelState.file = null;
				panelState.editing = false;
				await renderFiles();
			} catch (error) { showToast("Error", error.message, "error"); }
		};
		close.onclick = () => { panelState.file = null; panelState.editing = false; void renderFiles(); };
		view.append(field, save, close);
		body.append(view);
	}

	if (panelState.file) return;

	const list = el("div", "filelist");
	body.append(list);
	try {
		const { path, entries } = await api(`/api/fs/list?sessionId=${encodeURIComponent(active.id)}&path=${encodeURIComponent(panelState.path)}`);
		panelState.path = path;
		pathInput.value = path;
		if (path) {
			const up = el("div", "entry");
			up.append(el("span", "name", "…"));
			up.onclick = () => {
				panelState.path = path.split("/").slice(0, -1).join("/");
				panelState.file = null;
				void renderFiles();
			};
			list.append(up);
		}
		for (const entry of entries) {
			const row = el("div", `entry ${entry.type}`);
			row.append(el("span", "name", entry.name));
			row.append(el("span", "size", entry.type === "file" ? fmtBytes(entry.size) : ""));
			row.onclick = () => {
				const next = path ? `${path}/${entry.name}` : entry.name;
				if (entry.type === "dir") {
					panelState.path = next;
					panelState.file = null;
					void renderFiles();
				} else {
					void openFileEditor(next);
				}
			};
			list.append(row);
		}
		const newFile = el("div", "panel-form");
		const nameInput = el("input");
		nameInput.placeholder = "new-file.txt";
		const create = el("button", "", "Create file");
		newFile.append(nameInput, create);
		create.onclick = async () => {
			const next = path ? `${path}/${nameInput.value.trim()}` : nameInput.value.trim();
			if (!next) return;
			panelState.path = path;
			await openFileEditor(next, true);
		};
		body.append(newFile);
	} catch (error) {
		body.append(el("div", "notice", error.message));
	}
}

async function openFileEditor(path, create = false) {
	const view = { path, content: "", truncated: false };
	if (!create) {
		try {
			const result = await api(`/api/fs/file?sessionId=${encodeURIComponent(active.id)}&path=${encodeURIComponent(path)}`);
			if (result.binary) { showToast("Error", `Binary file (${result.size} bytes, "error"); not editable here.`); return; }
			view.content = result.content;
			view.truncated = result.truncated;
		} catch (error) { showToast("Error", error.message, "error"); return; }
	}
	panelState.file = view;
	panelState.editing = true;
	void renderFiles();
}

async function renderGit() {
	const body = panelBody();
	body.replaceChildren();
	if (!active) { body.append(el("div", "notice", "No session open.")); return; }
	const refresh = el("button", "", "Refresh");
	refresh.onclick = () => void renderGit();
	body.append(refresh);
	const wrap = el("div");
	body.append(wrap);
	try {
		const info = await api(`/api/git/diff?sessionId=${encodeURIComponent(active.id)}`);
		if (!info.available) {
			wrap.append(el("div", "notice", info.error ?? "Not a git work tree"));
			return;
		}
		if (info.status) {
			const status = el("div", "fileview");
			status.append(el("div", "", "Status"));
			status.append(el("pre", "", info.status));
			wrap.append(status);
		} else {
			wrap.append(el("div", "notice", "Working tree clean."));
		}
		if (info.diff) renderUnifiedDiff(wrap, info.diff);
	} catch (error) {
		wrap.append(el("div", "notice", error.message));
	}
}

async function renderJobs() {
	const body = panelBody();
	body.replaceChildren();
	if (!active) { body.append(el("div", "notice", "No session open.")); return; }

	const cronSection = el("div");
	cronSection.append(el("h4", "", "Scheduled jobs (cron)"));
	const cronList = el("div");
	cronSection.append(cronList);
	const cronForm = el("div", "panel-form");
	const cronSchedule = el("input");
	cronSchedule.placeholder = 'cron expression, e.g. "0 9 * * *"';
	const cronPrompt = el("textarea");
	cronPrompt.placeholder = "prompt to run on schedule";
	const cronAdd = el("button", "", "Add schedule");
	cronForm.append(cronSchedule, cronPrompt, cronAdd);
	cronAdd.onclick = async () => {
		try {
			await api("/api/cron", {
				method: "POST",
				body: JSON.stringify({ sessionId: active.id, schedule: cronSchedule.value.trim(), prompt: cronPrompt.value.trim() }),
			});
			cronSchedule.value = ""; cronPrompt.value = "";
			await renderJobs();
		} catch (error) { showToast("Error", error.message, "error"); }
	};
	cronSection.append(cronForm);
	body.append(cronSection);

	const hbSection = el("div");
	hbSection.append(el("h4", "", "Heartbeats"));
	const hbList = el("div");
	hbSection.append(hbList);
	const hbForm = el("div", "panel-form");
	const hbSchedule = el("input");
	hbSchedule.placeholder = 'heartbeat schedule, e.g. "*/30 * * * *"';
	const hbInstruction = el("textarea");
	hbInstruction.placeholder = "what the agent should check on each beat";
	const hbAdd = el("button", "", "Set heartbeat");
	hbForm.append(hbSchedule, hbInstruction, hbAdd);
	hbAdd.onclick = async () => {
		try {
			await api("/api/heartbeat", {
				method: "POST",
				body: JSON.stringify({ sessionId: active.id, schedule: hbSchedule.value.trim(), instruction: hbInstruction.value.trim() }),
			});
			hbSchedule.value = ""; hbInstruction.value = "";
			await renderJobs();
		} catch (error) { showToast("Error", error.message, "error"); }
	};
	hbSection.append(hbForm);
	body.append(hbSection);

	try {
		const { jobs } = await api(`/api/cron?sessionId=${encodeURIComponent(active.id)}&includeInactive=1`);
		if (!jobs?.length) cronList.append(el("div", "notice", "No scheduled jobs."));
		for (const job of jobs ?? []) {
			const row = el("div", "job");
			const row1 = el("div", "row1");
			row1.append(el("span", "sched", `${job.schedule?.kind ?? "?"}: ${job.schedule?.expression ?? ""}`));
			const del = el("button", "", "Delete");
			del.onclick = async () => {
				try {
					await api(`/api/cron?sessionId=${encodeURIComponent(active.id)}&jobId=${encodeURIComponent(job.id)}`, { method: "DELETE" });
					await renderJobs();
				} catch (error) { showToast("Error", error.message, "error"); }
			};
			row1.append(del);
			row.append(row1, el("div", "prompt", job.label || job.prompt || job.id));
			if (job.nextRunAt) row.append(el("div", "meta", `next: ${job.nextRunAt}`));
			if (job.lastError) row.append(el("div", "err", job.lastError));
			cronList.append(row);
		}
	} catch (error) {
		cronList.append(el("div", "notice", error.message));
	}

	try {
		const { heartbeats } = await api(`/api/heartbeats?sessionId=${encodeURIComponent(active.id)}`);
		if (!heartbeats?.length) hbList.append(el("div", "notice", "No heartbeats."));
		for (const heartbeat of heartbeats ?? []) {
			const job = heartbeat.job ?? {};
			const row = el("div", "job");
			const row1 = el("div", "row1");
			row1.append(el("span", "sched", `${job.schedule?.kind ?? "?"}: ${job.schedule?.expression ?? ""}`));
			row.append(row1, el("div", "prompt", job.label || job.prompt || job.id));
			if (job.status) row.append(el("div", "meta", `status: ${job.status}`));
			const buttons = el("div", "buttons");
			for (const action of ["pause", "resume", "stop"]) {
				const button = el("button", "", action);
				button.onclick = async () => {
					try {
						await api("/api/heartbeat-action", {
							method: "POST",
							body: JSON.stringify({ sessionId: active.id, jobId: job.id, action }),
						});
						await renderJobs();
					} catch (error) { showToast("Error", error.message, "error"); }
				};
				buttons.append(button);
			}
			row.append(buttons);
			hbList.append(row);
		}
	} catch (error) {
		hbList.append(el("div", "notice", error.message));
	}
}

// ---------------------------------------------------------------------------
// Slash commands: autocomplete + config reload
// ---------------------------------------------------------------------------

let cmdLoading = false;
let cmdNoticeShown = false;

const BUILTIN_COMMANDS = [
	{ name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory", argumentHint: "[instructions] [--global] [rollback <id>]", source: "builtin" },
	{ name: "goal", description: "Set or view persistent goal (status, pause, resume, clear, --budget, --turns)", argumentHint: "[--budget <tokens>] [--turns <n>] [objective|clear|pause|resume]", source: "builtin" },
	{ name: "compact", description: "Compact conversation context", argumentHint: "[instructions]", source: "builtin" },
	{ name: "clone", description: "Clone the session at the current point", source: "builtin" },
	{ name: "fork", description: "Fork the session from an earlier prompt", source: "builtin" },
	{ name: "reload", description: "Reload extensions, skills, prompts, themes", source: "builtin" },
	{ name: "export", description: "Export session to HTML", source: "builtin" },
	{ name: "new", description: "Start a fresh conversation", source: "builtin" },
	{ name: "name", description: "Rename the session", argumentHint: "<name>", source: "builtin" },
];

function mergeBuiltins(serverCommands) {
	const list = serverCommands ?? [];
	return [...list, ...BUILTIN_COMMANDS.filter((builtin) => !list.some((cmd) => cmd.name === builtin.name))];
}


let activeTerminalSession = null;

function cleanupActiveTerminal() {
	if (activeTerminalSession) {
		try {
			if (activeTerminalSession.ws) activeTerminalSession.ws.close();
			if (activeTerminalSession.resizeObserver) activeTerminalSession.resizeObserver.disconnect();
			if (activeTerminalSession.term) activeTerminalSession.term.dispose();
		} catch {}
		activeTerminalSession = null;
	}
}

async function renderTerminal() {
	const body = panelBody();
	body.replaceChildren();
	if (!active) {
		body.append(el("div", "notice", "No session open."));
		return;
	}

	// If we already have an active live terminal for this session, reuse it
	if (activeTerminalSession && activeTerminalSession.sessionId === active.id && activeTerminalSession.ws?.readyState === WebSocket.OPEN) {
		body.append(activeTerminalSession.containerEl);
		if (activeTerminalSession.fitAddon) {
			setTimeout(() => {
				activeTerminalSession.fitAddon.fit();
				activeTerminalSession.term.focus();
			}, 30);
		}
		return;
	}

	cleanupActiveTerminal();

	const container = el("div", "terminal-container");

	// Header: CWD + Status Badge + Actions
	const header = el("div", "terminal-header");
	const cwdLabel = el("span", "terminal-cwd", `cwd: ${formatDisplayPath(active.state?.cwd || "~")}`);

	const headerRight = el("div", "");
	headerRight.style.display = "flex";
	headerRight.style.alignItems = "center";
	headerRight.style.gap = "8px";

	const badge = el("span", "terminal-status-badge", "Connecting...");

	const ctrlCBtn = el("button", "terminal-pill sigint", "Ctrl+C");
	ctrlCBtn.type = "button";
	ctrlCBtn.title = "Kirim sinyal interupsi SIGINT (Ctrl+C)";
	ctrlCBtn.onclick = () => {
		if (activeTerminalSession?.ws && activeTerminalSession.ws.readyState === WebSocket.OPEN) {
			activeTerminalSession.ws.send(JSON.stringify({ type: "input", data: "\x03" }));
			activeTerminalSession.term?.focus();
		}
	};

	const clearBtn = el("button", "terminal-pill", "Clear");
	clearBtn.type = "button";

	const restartBtn = el("button", "terminal-pill", "Restart PTY");
	restartBtn.type = "button";
	restartBtn.onclick = () => {
		cleanupActiveTerminal();
		void renderTerminal();
	};

	headerRight.append(badge, ctrlCBtn, clearBtn, restartBtn);
	header.append(cwdLabel, headerRight);

	const sendPtyInput = (data) => {
		if (activeTerminalSession?.ws && activeTerminalSession.ws.readyState === WebSocket.OPEN) {
			activeTerminalSession.ws.send(JSON.stringify({ type: "input", data }));
			activeTerminalSession.term?.focus();
		}
	};

	// Virtual Navigation Keys Toolbar
	const keysRow = el("div", "terminal-keys-row");

	const tabBtn = el("button", "terminal-key-btn", "⇥ Tab");
	tabBtn.type = "button";
	tabBtn.title = "Kirim tombol Tab (Auto-complete)";
	tabBtn.onclick = () => sendPtyInput("\t");

	const upBtn = el("button", "terminal-key-btn arrow", "↑");
	upBtn.type = "button";
	upBtn.title = "Panah Atas (Riwayat Perintah)";
	upBtn.onclick = () => sendPtyInput("\x1b[A");

	const downBtn = el("button", "terminal-key-btn arrow", "↓");
	downBtn.type = "button";
	downBtn.title = "Panah Bawah (Riwayat Perintah)";
	downBtn.onclick = () => sendPtyInput("\x1b[B");

	const leftBtn = el("button", "terminal-key-btn arrow", "←");
	leftBtn.type = "button";
	leftBtn.title = "Panah Kiri";
	leftBtn.onclick = () => sendPtyInput("\x1b[D");

	const rightBtn = el("button", "terminal-key-btn arrow", "→");
	rightBtn.type = "button";
	rightBtn.title = "Panah Kanan";
	rightBtn.onclick = () => sendPtyInput("\x1b[C");

	const escBtn = el("button", "terminal-key-btn", "Esc");
	escBtn.type = "button";
	escBtn.title = "Escape Key";
	escBtn.onclick = () => sendPtyInput("\x1b");

	keysRow.append(tabBtn, upBtn, downBtn, leftBtn, rightBtn, escBtn);

	// Quick Command Pills
	const pills = el("div", "terminal-pills");
	const quickCommands = ["git status", "git diff", "pwd", "ls -la", "node -v", "npm test", "htop"];
	for (const cmd of quickCommands) {
		const pill = el("button", "terminal-pill", cmd);
		pill.type = "button";
		pill.onclick = () => sendPtyInput(cmd + "\r");
		pills.append(pill);
	}

	// Terminal Host Container for xterm.js
	const terminalHost = el("div", "xterm-host");
	container.append(header, keysRow, pills, terminalHost);
	body.append(container);

	// Fallback if xterm is not loaded yet
	if (typeof Terminal === "undefined") {
		terminalHost.append(el("div", "notice", "Loading xterm.js terminal engine..."));
		return;
	}

	const term = new Terminal({
		cursorBlink: true,
		fontSize: 12.5,
		lineHeight: 1.25,
		fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
		theme: {
			background: "#090d13",
			foreground: "#e6edf3",
			cursor: "#58a6ff",
			cursorAccent: "#090d13",
			selectionBackground: "rgba(56, 139, 253, 0.35)",
			black: "#0d1117",
			red: "#ff7b72",
			green: "#3fb950",
			yellow: "#d29922",
			blue: "#58a6ff",
			magenta: "#bc8cff",
			cyan: "#39c5cf",
			white: "#d0d7de",
			brightBlack: "#484f58",
			brightRed: "#ffa198",
			brightGreen: "#56d364",
			brightYellow: "#e3b341",
			brightBlue: "#79c0ff",
			brightMagenta: "#d2a8ff",
			brightCyan: "#56d4dd",
			brightWhite: "#ffffff",
		},
	});

	let fitAddon = null;
	if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
		fitAddon = new FitAddon.FitAddon();
		term.loadAddon(fitAddon);
	}

	term.open(terminalHost);

	clearBtn.onclick = () => {
		term.clear();
		term.focus();
	};

	// Open WebSocket connection to PTY backend
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const sessionCwd = active.state?.cwd || active.cwd || "";
	const wsUrl = `${protocol}//${location.host}/api/terminal/ws?sessionId=${encodeURIComponent(active.id)}&cwd=${encodeURIComponent(sessionCwd)}&token=${encodeURIComponent(token)}`;
	const ws = new WebSocket(wsUrl);

	term.onData((data) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "input", data }));
		}
	});

	ws.onopen = () => {
		badge.textContent = "Live PTY";
		badge.className = "terminal-status-badge online";
		if (fitAddon) {
			fitAddon.fit();
			ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
		}
		term.focus();
	};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data);
			if (msg.type === "output" && typeof msg.data === "string") {
				term.write(msg.data);
			} else if (msg.type === "exit") {
				badge.textContent = `Exited (${msg.code})`;
				badge.className = "terminal-status-badge offline";
				term.writeln(`\r\n\x1b[33m[Process exited with code ${msg.code}]\x1b[0m`);
			}
		} catch {
			term.write(event.data);
		}
	};

	ws.onclose = () => {
		badge.textContent = "Disconnected";
		badge.className = "terminal-status-badge offline";
	};

	ws.onerror = (err) => {
		badge.textContent = "Connection Error";
		badge.className = "terminal-status-badge offline";
	};

	// Handle resize dynamically
	let resizeObserver = null;
	if (typeof ResizeObserver !== "undefined" && fitAddon) {
		resizeObserver = new ResizeObserver(() => {
			if (fitAddon && terminalHost.clientWidth > 0 && terminalHost.clientHeight > 0) {
				fitAddon.fit();
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
				}
			}
		});
		resizeObserver.observe(terminalHost);
	}

	activeTerminalSession = {
		sessionId: active.id,
		containerEl: container,
		term,
		fitAddon,
		ws,
		resizeObserver,
	};

	setTimeout(() => {
		if (fitAddon) fitAddon.fit();
		term.focus();
	}, 50);
}

async function loadCommands(sessionId) {
	if (cmdLoading) return cmdCache.get(sessionId) ?? [];
	cmdLoading = true;
	try {
		const { commands } = await api(`/api/commands?sessionId=${encodeURIComponent(sessionId)}`);
		const merged = mergeBuiltins(commands);
		cmdCache.set(sessionId, merged);
		return merged;
	} catch (error) {
		if (/No route/i.test(error.message) && !cmdNoticeShown) {
			cmdNoticeShown = true;
			appendNode(el("div", "notice", "Gateway out of date: restart the web gateway to enable slash commands and reload."));
			scroll();
		}
		console.warn("command list failed", error);
		return [];
	} finally {
		cmdLoading = false;
	}
}

function filteredCommands(prefix) {
	const commands = cmdCache.get(active?.id) ?? [];
	const query = prefix.slice(1).toLowerCase();
	return commands.filter((cmd) => cmd.name.toLowerCase().startsWith(query));
}

function closeCmdMenu() {
	cmdMenuState = { open: false, items: [], highlighted: -1 };
	$("cmdMenu").classList.add("hidden");
	$("cmdMenu").replaceChildren();
}

function renderCmdMenu(items) {
	const menu = $("cmdMenu");
	menu.replaceChildren();
	if (items.length === 0) { closeCmdMenu(); return; }
	items.forEach((cmd, index_) => {
		const row = el("div", "cmditem" + (index_ === cmdMenuState.highlighted ? " active" : ""));
		row.append(el("span", "cmdname", `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}`));
		if (cmd.description) row.append(el("span", "cmddesc", cmd.description));
		row.append(el("span", "cmdsrc", cmd.source));
		row.onmousedown = (event) => {
			event.preventDefault();
			completeCommand(cmd);
		};
		menu.append(row);
	});
	cmdMenuState.items = items;
	menu.classList.remove("hidden");
	cmdMenuState.open = true;
}

function completeCommand(cmd) {
	input.value = `/${cmd.name} `;
	closeCmdMenu();
	input.focus();
}

function updateCmdMenu() {
	const value = input.value;
	if (!value.startsWith("/") || value.includes(" ")) { closeCmdMenu(); return; }
	if (!active) { closeCmdMenu(); return; }
	const items = filteredCommands(value).slice(0, 8);
	cmdMenuState.highlighted = -1;
	renderCmdMenu(items);
}

function resizeInput() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

input.addEventListener("input", () => updateCmdMenu());
input.addEventListener("input", resizeInput);



// ---------------------------------------------------------------------------
// Folder picker (server-side browse, machine-wide)
// ---------------------------------------------------------------------------

function openFolderPicker(onSelect) {
	openModal({
		title: "Choose a folder",
		message: "Pick the project folder for the new session.",
		build(body, actions, close) {
			actions.replaceChildren();
			const state = { path: "", parent: null };
			const wrap = el("div", "picker");
			const bar = el("div", "pickerbar");
			const up = el("button", "", "↑");
			up.title = "Parent folder";
			up.disabled = true;
			const home = el("button", "", "Home");
			const pathLabel = el("code", "pickerpath", "");
			bar.append(up, home, pathLabel);
			const list = el("div", "filelist pickerlist");
			wrap.append(bar, list);
			body.append(wrap);
			const select = el("button", "", "Use this folder");
			select.onclick = () => {
				close();
				onSelect(state.path);
			};
			actions.prepend(select);

			async function load(path) {
				list.replaceChildren(el("div", "notice", "Loading…"));
				try {
					const result = await api(`/api/fs/browse?path=${encodeURIComponent(path)}`);
					state.path = result.path;
					state.parent = result.parent;
					pathLabel.textContent = result.path;
					up.disabled = !result.parent;
					list.replaceChildren();
					if (!result.entries?.length) list.append(el("div", "notice", "No subfolders here."));
					for (const entry of result.entries ?? []) {
						const row = el("div", "entry file");
						row.append(el("span", "name", entry.name));
						row.onclick = () => void load(entry.path);
						list.append(row);
					}
				} catch (error) {
					list.replaceChildren(el("div", "notice", error.message));
				}
			}
			up.onclick = () => { if (state.parent) void load(state.parent); };
			const homeDir = meta.home || "";
			const initialPath = $("welcomeCwd").value.trim() || homeDir;
			home.onclick = () => void load(homeDir);
			void load(initialPath);
		},
	});
}

$("browseBtn").addEventListener("click", () => {
	openFolderPicker((chosen) => {
		$("welcomeCwd").value = chosen;
	});
});

// ---------------------------------------------------------------------------
// Sessions + boot
// ---------------------------------------------------------------------------

function highlightSession(id) {
	for (const node of $("sessionList").children) {
		node.classList.toggle("active", node.dataset.id === id);
	}
}

function sessionIdentity(session) {
	return session.sessionId ?? session.id;
}

function sessionActivityTime(session) {
	const values = [session.lastActivityAt, session.modified, session.created];
	for (const value of values) {
		const time = Date.parse(value ?? "");
		if (Number.isFinite(time)) return time;
	}
	return 0;
}

function sessionIsWorking(session) {
	if (!session) return false;
	if (isCurrentActiveSession(session)) {
		const hasSubagents = Boolean(
			active?.hasRunningRlmChildren ||
			(active?.runningSubagents && active.runningSubagents.size > 0)
		);
		return Boolean(busy || hasSubagents || Boolean(run && (run.assistant || run.thinking)));
	}
	// Real in-flight execution check: only consider working if actively executing work, streaming, or running subagents
	return Boolean(
		session.isSessionActive === true ||
		session.hasRunningRlmChildren === true ||
		session.hasRunningChildren === true ||
		session.isStreaming === true ||
		session.isCompacting === true ||
		session.isBashRunning === true ||
		session.isRunningTools === true
	);
}

function sortSidebarSessions(sessions) {
	return [...sessions].sort((left, right) => {
		const workingDelta = Number(sessionIsWorking(right)) - Number(sessionIsWorking(left));
		if (workingDelta) return workingDelta;
		const timeDelta = sessionActivityTime(right) - sessionActivityTime(left);
		if (timeDelta) return timeDelta;
		return String(sessionIdentity(left)).localeCompare(String(sessionIdentity(right)));
	});
}

function sidebarItemSignature(session) {
	const activityTime = sessionActivityTime(session);
	const activityLabel = activityTime ? formatRelativeTime(new Date(activityTime)) : "";
	return [
		sessionIdentity(session),
		session.id ?? "",
		session.name ?? session.sessionName ?? "",
		session.cwd ?? "",
		activityTime,
		activityLabel,
		sessionIsWorking(session) ? "working" : "idle",
	].join("|");
}

function promoteSidebarSession(id) {
	if (!id) return;
	const list = $("sessionList");
	const node = [...list.children].find((candidate) => candidate.dataset.id === id);
	if (node && list.firstElementChild !== node) list.prepend(node);
}

const TRASH_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>'

function isCurrentActiveSession(session) {
	if (!active || !session) return false;
	const activeId = active.id;
	const activeSid = active.sessionId;
	if (session.activeSessionId && (session.activeSessionId === activeId || session.activeSessionId === activeSid)) return true;
	if (session.id && (session.id === activeId || session.id === activeSid)) return true;
	if (session.sessionId && (session.sessionId === activeSid || session.sessionId === activeId)) return true;
	if (session.sessionFile && active.sessionFile && session.sessionFile === active.sessionFile) return true;
	return false;
}

function checkBackgroundSessionCompletions(sessions) {
	for (const session of sessions) {
		const key = sessionIdentity(session);
		if (!key) continue;
		const isWorking = sessionIsWorking(session);
		const wasWorking = previousSessionWorkingState.get(key);

		// Record current working state
		previousSessionWorkingState.set(key, isWorking);

		// If the session was previously working and is now finished:
		if (wasWorking === true && !isWorking) {
			// Foreground active session handles its own notification via agent_end
			if (isCurrentActiveSession(session)) continue;

			// Skip empty or transient drafts that never had any messages
			if ((session.messageCount ?? 0) === 0 && !session.summary && !session.firstMessage && !session.name && !session.sessionName) continue;

			const name =
				session.name ||
				session.sessionName ||
				session.firstMessage ||
				(session.sessionId ? `Session ${session.sessionId.slice(0, 8)}` : "Session");
			const title = `Agent finished: ${name}`;
			const summary = (session.summary || "").trim();
			notifyDone(summary, title);
		}
	}
}

function renderSidebarSessions(sessions) {
	checkBackgroundSessionCompletions(sessions);
	const list = $("sessionList");
	const items = sortSidebarSessions(filterSidebarSessions(sessions));
	const signature = items.map(sidebarItemSignature).join(";");
	if (signature === sidebarSignature) return;

	const next = document.createDocumentFragment();
	if (!items.length) {
		next.append(el("div", "sideempty", "No sessions yet."));
	} else {
		for (const session of items) {
			const id = session.activeSessionId ?? session.id;
			const isLive = Boolean(session.workerPid || session.activeSessionId || session.lifecycle === "live");
			const node = el("div", "session" + (active?.id === id ? " active" : ""));
			node.dataset.id = id;
			if (session.sessionId) node.dataset.sessionId = session.sessionId;
			if (session.sessionFile) node.dataset.sessionFile = session.sessionFile;
			node.dataset.live = isLive ? "1" : "";

			const main = el("div", "session-main");
			main.append(el("div", "session-name", session.name || session.firstMessage || `Session ${id.slice(0, 8)}`));
			const cwdDisplay = formatCwdTail(session.cwd);
			const meta = el("div", "meta");
			const cwdSpan = el("span", "session-cwd");
			cwdSpan.title = session.cwd ? `Folder: ${session.cwd}` : "";
			cwdSpan.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:0.7;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> <span>${cwdDisplay || "session"}</span>`;
			meta.append(cwdSpan);
			const activityAt = session.lastActivityAt ?? session.modified ?? session.created;
			if (activityAt) {
				const time = timestampDate(activityAt);
				const stamp = el("time", "session-time", formatRelativeTime(time));
				stamp.dateTime = time.toISOString();
				stamp.title = time.toLocaleString();
				meta.append(stamp);
			}
			if (sessionIsWorking(session)) meta.append(el("span", "session-live", "● working"));
			main.append(meta);

			const del = el("button", "session-delete");
			del.type = "button";
			del.title = "Delete session";
			del.innerHTML = TRASH_SVG;
			del.onclick = async (event) => {
				event.stopPropagation();
				if (!del.classList.contains("confirm")) {
					del.classList.add("confirm");
					del.textContent = "Sure?";
					setTimeout(() => {
						del.classList.remove("confirm");
						del.innerHTML = TRASH_SVG;
					}, 2500);
					return;
				}
				try {
					await api(`/api/session?sessionId=${encodeURIComponent(id)}`, { method: "DELETE" });
					if (active?.id === id) goHome();
					await refreshSessions();
				} catch (error) { showToast("Error", error.message, "error"); }
			};

			node.append(main, del);
			node.onclick = () => openSessionById(id, node.dataset.sessionFile, node.dataset.live).catch((err) => {
				console.error("openSessionById error:", err);
				showToast("Error", err.message || "Failed to open session", "error");
			});
			next.append(node);
		}
	}
	list.replaceChildren(next);
	sidebarSignature = signature;
}

async function refreshSessions() {
	if (sidebarRefreshPromise) {
		sidebarRefreshQueued = true;
		return sidebarRefreshPromise;
	}
	sidebarRefreshPromise = (async () => {
		const { sessions } = await api("/api/sessions");
		catalogSessions = sessions ?? [];
		if (typeof renderSidebarSessions === "function" && typeof mergeRosterIntoCatalog === "function") renderSidebarSessions(mergeRosterIntoCatalog());
	})();
	try {
		await sidebarRefreshPromise;
	} finally {
		sidebarRefreshPromise = null;
		if (sidebarRefreshQueued) {
			sidebarRefreshQueued = false;
			void refreshSessions().catch(() => undefined);
		}
	}
}

// Sessions started from TUI/another client do not share this tab's SSE stream.
// Poll only the sidebar catalog. Keep it slow and visibility-aware: a catalog
// scan opens a daemon connection and reads all saved sessions, while local
// agent_start/agent_end events still refresh immediately.
const SIDEBAR_POLL_MS = 5_000;
let lastStreamWatchdogCheck = Date.now();

setInterval(() => {
	if (document.visibilityState !== "visible") return;
	void refreshSessions().catch(() => undefined);

	// Stream health watchdog
	if (active) {
		const now = Date.now();
		// If EventSource is dead or missing, revive it immediately
		if (!active.es || active.es.readyState === 2) {
			openSessionEventStream(active);
		} else if (busy && now - lastSessionEventAt > 15_000 && now - lastStreamWatchdogCheck > 10_000) {
			// If we are waiting/busy but haven't received a single heartbeat or event in 15s,
			// poll server state to see if the turn finished in the background
			lastStreamWatchdogCheck = now;
			void api(`/api/state?sessionId=${encodeURIComponent(active.id)}`)
				.then((snap) => {
					if (!snap || !active) return;
					if (!snap.state?.isStreaming && !snap.streamingMessage && !active.hasRunningRlmChildren) {
						// Server is idle; resync transcript so latest messages appear immediately
						void resync();
					}
				})
				.catch(() => undefined);
		}
	}
}, SIDEBAR_POLL_MS);

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		void refreshSessions().catch(() => undefined);
		if (!rosterEs) connectRosterStream();
		if (active && !active.es) openSessionEventStream(active);
	} else {
		closeRosterStream();
		// Active session stream is intentionally kept alive in background so
		// agent_end notifications and finish chimes fire in real-time!
	}
});

async function openSessionById(id, sessionFile, live) {
	const sequence = ++sessionOpenSequence;
	// 1. Instant mobile feedback: close drawer immediately so user sees the transition
	closeSidebar();
	if (id) highlightSession(id);
	if (!active || active.id !== id) {
		setWelcome(false);
		showTyping("Opening session…");
	}

	const isLive = Boolean(live && live !== "0");
	const body = {
		...(id ? { activeSessionId: id } : {}),
		...(sessionFile ? { sessionPath: sessionFile } : {}),
	};
	try {
		const snap = await api("/api/session", { method: "POST", body: JSON.stringify(body) });
		if (sequence !== sessionOpenSequence) return;
		await attach(snap);
	} catch (error) {
		if (sessionFile) {
			try {
				const snap = await api("/api/session", {
					method: "POST",
					body: JSON.stringify({ sessionPath: sessionFile }),
				});
				if (sequence !== sessionOpenSequence) return;
				await attach(snap);
				void refreshSessions().catch(() => undefined);
				return;
			} catch (resumeErr) {
				console.warn("Fallback resume failed:", resumeErr);
			}
		}
		hideTyping();
		void refreshSessions().catch(() => undefined);
		throw error;
	}
	void refreshSessions().catch(() => undefined);
}

function updateConnectionStatus() {
	const ok = active ? Boolean(active.es) : Boolean(rosterEs);
	setConn(ok);
}

function setConn(ok) {
	$("connChip").classList.toggle("hidden", ok);
}

function toggleSoundPref() {
	soundEnabled = !soundEnabled;
	localStorage.setItem("primeAgentSound", soundEnabled ? "1" : "0");
	applyVisibility();
	if (soundEnabled) ensureAudio();
}

function closeSidebar() {
	$("sidebar").classList.remove("open");
	$("scrim").classList.add("hidden");
}

function toggleSidebar() {
	const open = !$("sidebar").classList.contains("open");
	$("sidebar").classList.toggle("open", open);
	$("scrim").classList.toggle("hidden", !open);
}

function goHome() {
	const lastCwd = active?.cwd;
	sessionOpenSequence += 1;
	closeSessionEventStream();
	toolCards.clear();
	sideCards.clear();
	if (typeof refinementCards !== "undefined") refinementCards.clear();
	modelCache = [];
	closeModelMenu();
	active = null;
	run = null;
	setBusy(false);
	closeCmdMenu();
	closeSidebar();
	updateConnectionStatus();
	hideTyping();
	setWelcome(true);
	$("panel").classList.add("hidden");
	$("cwdChip").classList.add("hidden");
	$("subagentChip")?.classList.add("hidden");
	$("modelBtn").disabled = true;
	$("thinking").disabled = true;
	$("moreBtn").disabled = true;
	renderGoalBanner(null);
	highlightSession(null);
	if (lastCwd) $("welcomeCwd").value = lastCwd;
	void refreshSessions();
}

$("brandHome").addEventListener("click", goHome);
$("brandMini").addEventListener("click", goHome);

$("navBtn").addEventListener("click", toggleSidebar);
$("scrim").addEventListener("click", closeSidebar);

$("welcomeNew").addEventListener("submit", async (event) => {
	event.preventDefault();
	const sequence = ++sessionOpenSequence;
	try {
		const snap = await api("/api/session", { method: "POST", body: JSON.stringify({ cwd: $("welcomeCwd").value }) });
		if (sequence !== sessionOpenSequence) return;
		await attach(snap);
		await refreshSessions();
	} catch (error) { showToast("Error", error.message, "error"); }
});

const BUILTIN_HANDLERS = {
	async speed(args) {
		const arg = (args || "").trim().toLowerCase();
		if (arg && arg !== "on" && arg !== "off") {
			appendNode(el("div", "card", "Usage: /speed [on|off]"));
			return;
		}
		const enabled = arg === "on" ? true : arg === "off" ? false : !speedDisplayEnabled;
		speedDisplayEnabled = enabled;
		localStorage.setItem("prime_speed_display", enabled ? "1" : "0");
		if (!enabled) {
			speedStats = { tokens: 0, durationMs: 0, samples: 0 };
		}
		renderSpeedChip();
		applyVisibility();
		showToast("Speed display", enabled ? "Speed readout enabled (⚡ tok/s)" : "Speed readout disabled");
	},
	async refine(args) {
		let rest = (args || "").trim();
		let global = false;
		let rollbackId = undefined;
		if (/^--global(?:\s|$)/.test(rest)) {
			global = true;
			rest = rest.replace(/^--global(?:\s|$)/, "").trim();
		}
		const rollbackMatch = /^rollback(?:\s+|$)/i.exec(rest);
		if (rollbackMatch) {
			let targetId = rest.slice(rollbackMatch[0].length).trim();
			if (/\s--global$/.test(targetId)) {
				global = true;
				targetId = targetId.replace(/\s--global$/, "").trim();
			}
			rollbackId = targetId || undefined;
			rest = "";
		} else if (/\s--global$/.test(rest)) {
			global = true;
			rest = rest.replace(/\s--global$/, "").trim();
		}

		setBusy(true);
		showTyping();
		try {
			const result = await api("/api/refine", {
				method: "POST",
				body: JSON.stringify({
					sessionId: active.id,
					instructions: rest || undefined,
					rollbackId,
					global,
				}),
			});
			renderRefinementCard(result);
		} catch (error) {
			showToast("Refinement error", error.message, "error");
			appendNode(el("div", "notice", `Refinement failed: ${error.message}`));
			scroll();
		} finally {
			setBusy(false);
			hideTyping();
		}
	},
	async compact(args) {
		setBusy(true);
		showTyping();
		try {
			const result = await api("/api/compact", {
				method: "POST",
				body: JSON.stringify({ sessionId: active.id, instructions: args || undefined }),
			});
			renderCompactionCard({
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				customInstructions: args || undefined,
				timestamp: Date.now(),
			});
			await resync();
		} catch (error) {
			showToast("Compaction error", error.message, "error");
		} finally {
			setBusy(false);
			hideTyping();
		}
	},
	async clone() {
		try {
			const res = await api("/api/clone", { method: "POST", body: JSON.stringify({ sessionId: active.id }) });
			if (res.state && res.messages) {
				active.sessionId = res.state.sessionId;
				active.sessionFile = res.state.sessionFile;
				refreshHeader(res.state);
				refreshThinkingPicker(res.state);
				await refreshModelPicker(res.state);
				renderMessages(res.messages);
			} else {
				await resync();
			}
			await refreshSessions();
			showToast("Session Cloned", "Cloned entire conversation into a new branch", "info");
		} catch (error) {
			showToast("Clone error", error.message, "error");
		}
	},
	async fork() { openForkPicker(); },
	async reload() {
		await api("/api/reload", { method: "POST", body: JSON.stringify({ sessionId: active.id }) });
		cmdCache.set(active.id, mergeBuiltins(await loadCommands(active.id)));
		appendNode(el("div", "notice", "Config reloaded: extensions, skills, prompts, and themes refreshed."));
	},
	async export(args) {
		const result = await api("/api/export", {
			method: "POST",
			body: JSON.stringify({ sessionId: active.id, outputPath: args || undefined }),
		});
		appendNode(el("div", "notice", `Exported to ${result.path}`));
	},
	async new() {
		const result = await api("/api/new", { method: "POST", body: JSON.stringify({ sessionId: active.id }) });
		if (result.cancelled) { appendNode(el("div", "notice", "An extension cancelled /new.")); return; }
		await resync();
	},
	async name(args) {
		await api("/api/session-name", { method: "POST", body: JSON.stringify({ sessionId: active.id, name: args || "" }) });
		await resync();
	},
};

// Clipboard image pasting support for composer
window.addEventListener("paste", (event) => {
	const items = event.clipboardData?.items;
	if (!items) return;
	const imageFiles = [];
	for (const item of items) {
		if (item.type && item.type.startsWith("image/")) {
			const file = item.getAsFile();
			if (file) imageFiles.push(file);
		}
	}
	if (imageFiles.length > 0) {
		handleImageFiles(imageFiles);
	}
});

const attachImageBtn = $("attachImageBtn");
const imageInput = $("imageInput");
if (attachImageBtn && imageInput) {
	attachImageBtn.addEventListener("click", () => imageInput.click());
	imageInput.addEventListener("change", (e) => {
		if (e.target.files && e.target.files.length > 0) {
			handleImageFiles(e.target.files);
			imageInput.value = "";
		}
	});
}

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	closeCmdMenu();
	ensureAudio();
	try {
		if (window.isSecureContext && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => undefined);
	} catch {}
	const message = input.value.trim();
	if (!message || !active) return;
	input.value = "";
	activeRetry = null;
	resizeInput();
	const slashMatch = message.match(/^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/);
	const builtin = slashMatch ? BUILTIN_HANDLERS[slashMatch[1]] : undefined;
	if (builtin) {
		scroll();
		try {
			await builtin((slashMatch[2] ?? "").trim());
		} catch (error) {
			appendNode(el("div", "card", error.message));
			scroll();
		}
		return;
	}
	const userBubble = el("div", "bubble user");
	const userMsgText = el("div", "user-msg-text", message);
	userBubble.append(userMsgText);
	attachMessageFooter(userBubble, () => message, Date.now());
	appendNode(userBubble);
	scroll(true);
	try {
		if (active && (!active.es || active.es.readyState === 2)) {
			openSessionEventStream(active);
		}
		const wasBusy = busy;
		const promptPayload = {
			sessionId: active.id,
			message,
			streamingBehavior: busy ? "steer" : undefined,
			...(composerImages.length > 0 ? { images: composerImages.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
		};
		composerImages = [];
		renderComposerAttachments();
		await api("/api/prompt", {
			method: "POST",
			body: JSON.stringify(promptPayload),
		});
		if (!wasBusy) showTyping();
	} catch (error) {
		appendNode(createErrorCard(error.message));
		scroll(true);
		const { title, advice } = parseDetailedError(error.message);
		showToast(title, advice, "error");
	}
});

input.addEventListener("keydown", (event) => {
	if (cmdMenuState.open) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			const count = cmdMenuState.items.length;
			cmdMenuState.highlighted = (cmdMenuState.highlighted + delta + count) % count;
			renderCmdMenu(cmdMenuState.items);
			return;
		}
		if (event.key === "Tab" && cmdMenuState.highlighted >= 0) {
			event.preventDefault();
			completeCommand(cmdMenuState.items[cmdMenuState.highlighted]);
			return;
		}
		if (event.key === "Escape") { closeCmdMenu(); return; }
		if (event.key === "Enter" && !event.shiftKey && cmdMenuState.highlighted >= 0) {
			event.preventDefault();
			completeCommand(cmdMenuState.items[cmdMenuState.highlighted]);
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		closeCmdMenu();
		$("composer").requestSubmit();
	}
});

for (const id of ["stopBtn"]) {
	const btn = document.getElementById(id);
	if (!btn) {
		console.warn(`Prime Agent web: #` + id + ` missing (stale HTML? hard reload)`);
		continue;
	}
	btn.addEventListener("click", () => {
		lastStopAt = Date.now();
		btn.disabled = true;
		if (active) api("/api/abort", { method: "POST", body: JSON.stringify({ sessionId: active.id }) }).catch(console.error);
	});
}

// --- custom model dropdown with search -------------------------------------

function closeModelMenu() {
	modelMenuOpen = false;
	modelHighlight = -1;
	$("modelMenu").classList.add("hidden");
}

function renderModelList(query) {
	const list = $("modelList");
	list.replaceChildren();
	const q = (query ?? "").trim().toLowerCase();
	modelItems = modelCache.filter((model) => `${model.provider}/${model.id}`.toLowerCase().includes(q));
	if (!modelItems.length) {
		list.append(el("div", "notice", "No models match."));
		return;
	}
	const current = $("modelLabel").textContent;
	modelItems.forEach((model, index_) => {
		const value = `${model.provider}/${model.id}`;
		const row = el("div", "modelitem" + (index_ === modelHighlight ? " active" : "") + (value === current ? " selected" : ""));
		row.append(el("span", "modelprov", model.provider));
		row.append(el("span", "modelname", model.id));
		if (value === current) row.append(el("span", "check", "✓"));
		row.onclick = () => chooseModel(model);
		list.append(row);
	});
}

async function chooseModel(model) {
	const session = active;
	$("modelLabel").textContent = model.id;
	closeModelMenu();
	if (!active) return;
	try {
		const result = await api("/api/model", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, provider: model.provider, modelId: model.id }),
		});
		if (active !== session) return;
		// Model-specific thinkingLevelMap (including models.json custom levels)
		// is recalculated by the core on setModel; replace the effort options.
		if (result.state) {
			refreshThinkingPicker(result.state);
			refreshHeader(result.state);
		}
	} catch (error) {
		appendNode(createErrorCard(error.message));
		scroll(true);
		const { title, advice } = parseDetailedError(error.message);
		showToast(title, advice, "error");
	}
}

function openModelMenu() {
	if ($("modelBtn").disabled || !active) return;
	modelMenuOpen = true;
	modelHighlight = -1;
	$("modelMenu").classList.remove("hidden");
	const search = $("modelSearch");
	search.value = "";
	renderModelList("");
	search.focus();
}

$("modelBtn").addEventListener("click", () => {
	if (modelMenuOpen) closeModelMenu();
	else openModelMenu();
});

$("modelSearch").addEventListener("input", () => renderModelList($("modelSearch").value));

$("modelSearch").addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		const count = modelItems.length;
		if (!count) return;
		const delta = event.key === "ArrowDown" ? 1 : -1;
		modelHighlight = (modelHighlight + delta + count) % count;
		renderModelList($("modelSearch").value);
		$("modelList").querySelector(".modelitem.active")?.scrollIntoView({ block: "nearest" });
	} else if (event.key === "Enter") {
		event.preventDefault();
		const model = modelItems[modelHighlight] ?? modelItems[0];
		if (model) chooseModel(model);
	} else if (event.key === "Escape") {
		event.preventDefault();
		closeModelMenu();
	}
});

document.addEventListener("click", (event) => {
	if (!modelMenuOpen) return;
	if ($("modelSelect").contains(event.target)) return;
	closeModelMenu();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && modelMenuOpen) closeModelMenu();
});

function closeMoreMenu() {
	$("moreMenu").classList.add("hidden");
}

$("moreBtn").addEventListener("click", () => {
	if ($("moreBtn").disabled) return;
	const menu = $("moreMenu");
	const opening = menu.classList.contains("hidden");
	if (opening) {
		menu.classList.remove("hidden");
		applyVisibility();
	} else closeMoreMenu();
});

document.addEventListener("click", (event) => {
	if ($("moreMenu").classList.contains("hidden")) return;
	if ($("moreSelect").contains(event.target)) return;
	closeMoreMenu();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !$("moreMenu").classList.contains("hidden")) closeMoreMenu();
});

$("thinking").addEventListener("change", async (event) => {
	const session = active;
	if (!session) return;
	try {
		const result = await api("/api/thinking", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, level: event.target.value }),
		});
		if (active !== session) return;
		if (result.state) refreshThinkingPicker(result.state);
	} catch (error) {
		showToast("Error", error.message, "error");
	}
});

(async () => {
	try {
		meta = await api("/api/meta");
		if (!$("welcomeCwd").value) $("welcomeCwd").value = meta.home || "";
		if (meta.authMode === "password") $("userBox").classList.remove("hidden");
		if (meta.version) $("verChip").textContent = `v${meta.version}`;
	} catch {
		// 401 handled by api(); token mode failures surface below
	}
	try {
		ensureAudio();
		await refreshSessions();
		connectRosterStream();
	} catch (error) {
		appendNode(el("div", "notice", error.message));
	}
})();

// Startup self-audit: if the served HTML is older/newer than this script, wired
// controls go missing and listeners would throw mid-file, killing everything after.
// Fail loudly and name the missing elements instead.
const WIRED_IDS = ["brandHome", "brandMini", "browseBtn", "chatCol", "composer", "costStat", "quotaParkBanner", "speedStat", "cwdChip", "subagentChip", "goalBanner", "goalChip", "goalClearBtn", "goalEditBtn", "goalPauseBtn", "goalToggleBtn", "jumpBtn", "loginForm", "logoutBtn", "menuAsk", "menuChangePassword", "menuClone", "menuCompact", "menuFork", "menuGoal", "menuPanel", "menuRefine", "menuReload", "menuSpeed", "menuThinking", "menuToolCalls", "modelBtn", "modelSearch", "moreBtn", "navBtn", "panelClose", "scrim", "stopBtn", "thinking", "welcomeNew"];
const missingWired = WIRED_IDS.filter((id) => !document.getElementById(id));
if (missingWired.length) {
	console.error("Prime Agent web: HTML/JS version mismatch: missing #" + missingWired.join(", #") + ". Hard reload the page.");
}
