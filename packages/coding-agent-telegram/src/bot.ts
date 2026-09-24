
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";



interface InflightTurn {
	chatId: number;
	sessionId: string;
	promptText: string;
	timestamp: number;
}

function getInflightJournalPath(): string {
	const dir = join(getAgentDir(), "prime-agent-telegram");
	mkdirSync(dir, { recursive: true });
	return join(dir, "inflight-journal.json");
}

function recordInflightTurn(turn: InflightTurn): void {
	try {
		const file = getInflightJournalPath();
		writeFileSync(file, JSON.stringify(turn, null, 2), { mode: 0o600 });
	} catch {}
}

function clearInflightTurn(): void {
	try {
		const file = getInflightJournalPath();
		rmSync(file, { force: true });
	} catch {}
}

function readInflightTurn(): InflightTurn | null {
	try {
		const file = getInflightJournalPath();
		if (existsSync(file)) {
			return JSON.parse(readFileSync(file, "utf8")) as InflightTurn;
		}
	} catch {}
	return null;
}

function getUserSessionsFilePath(): string {
	const dir = join(getAgentDir(), "prime-agent-telegram");
	mkdirSync(dir, { recursive: true });
	return join(dir, "user-sessions.json");
}

function loadSavedUserSessions(): Map<number, string> {
	const map = new Map<number, string>();
	const file = getUserSessionsFilePath();
	if (existsSync(file)) {
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			for (const [k, v] of Object.entries(data)) {
				map.set(Number(k), String(v));
			}
		} catch {}
	}
	return map;
}

function saveUserSessions(map: Map<number, string>): void {
	const file = getUserSessionsFilePath();
	const obj: Record<string, string> = {};
	for (const [k, v] of map.entries()) {
		obj[String(k)] = v;
	}
	try {
		writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
	} catch {}
}
function reprText(t: string): string {
	return JSON.stringify(t);
}
import { Bot, InlineKeyboard, InputFile, Keyboard } from "grammy";
import { PrimeApiClient, type SessionSnapshot } from "./api-client.js";
import type { BotConfig } from "./config.js";
import { escapeHtml, formatSessionSummary, splitMessage, formatSessionItemLabel, formatMessageForChat, markdownToTelegramHtml, formatModelIdentifier, formatDetailedError } from "./formatters.js";

interface PinnedStatusInfo {
	chatId: number;
	messageId: number;
}


function getMainReplyKeyboard(): Keyboard {
	return new Keyboard()
		.text("📊 Status").text("📋 Sessions")
		.row()
		.text("➕ New Session").text("⚙️ Menu")
		.resized()
		.persistent();
}


	function buildFullFeatureInlineMenu(): { text: string; keyboard: InlineKeyboard } {
		const keyboard = new InlineKeyboard()
			.text("📜 History", "menu_action:history")
			.text("🤖 Model", "menu_action:model")
			.text("💭 Thinking", "menu_action:thinking")
			.row()
			.text("📂 Files (/ls)", "menu_action:ls")
			.text("🔍 Git Diff", "menu_action:diff")
			.text("📡 Pantau Sesi", "menu_action:track")
			.row()
			.text("🤖 Subagents", "menu_action:subagents")
			.text("❓ Side Question", "menu_action:side")
			.text("📄 Export", "menu_action:export")
			.row()
			.text("🛑 Abort Sesi", "menu_action:abort");

		const header = [
			"⚙️ <b>Menu Fitur Prime Agent:</b>",
			"",
			"Pilih salah satu tindakan di bawah ini:",
		].join("\n");

		return { text: header, keyboard };
	}


	
async function sendTelegramMessageSafe(
	sendFn: () => Promise<any>,
	maxRetries: number = 3
): Promise<any> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await sendFn();
		} catch (err: any) {
			const is429 = err.error_code === 429 || err.message?.includes("429") || err.description?.includes("Too Many Requests");
			const isNetworkErr = err.message?.includes("Network request") || err.message?.includes("fetch failed") || err.message?.includes("ETIMEDOUT") || err.message?.includes("ECONNRESET");
			if ((is429 || isNetworkErr) && attempt < maxRetries) {
				const retrySec = is429 ? ((err.parameters?.retry_after || 5) + 1) : 1;
				console.log(`[TG RETRY] ${is429 ? '429 Rate-limit' : 'Network error'}, waiting ${retrySec}s before retry (attempt ${attempt}/${maxRetries})...`);
				await new Promise((r) => setTimeout(r, retrySec * 1000));
				continue;
			}
			throw err;
		}
	}
}

export function createTelegramBot(config: BotConfig, apiClient: PrimeApiClient): Bot {
	const bot = new Bot(config.botToken, { client: { fetch: globalThis.fetch } });
	bot.catch((err) => {
		console.error("[GRAMMY ERROR in bot update]", err);
	});
	// Slash commands registered once

	const userActiveSessions = loadSavedUserSessions();
	const activeUserUnsubscribes = new Map<number, () => void>();
	const pinnedMessages = new Map<number, PinnedStatusInfo>();

	function detachUserSessionListeners(userId?: number, chatId?: number): void {
		if (userId) {
			const activeSub = activeUserUnsubscribes.get(userId);
			if (activeSub) {
				try { activeSub(); } catch {}
				activeUserUnsubscribes.delete(userId);
			}
		}
		if (chatId) {
			stopTrackingSession(chatId);
		}
		clearInflightTurn();
	}
	bot.use(async (ctx, next) => {
		console.log(`[INCOMING] user=${ctx.from?.id} text=${reprText(ctx.message?.text || ctx.callbackQuery?.data || '')}`);
		const userId = ctx.from?.id;
		if (!userId) return;

		if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
			console.warn(`Unauthorized access: Telegram user ID ${userId}`);
			await ctx.reply(`⛔ Unauthorized.`);
			return;
		}

		// Normalize keyboard buttons directly to slash commands in-place without update re-injection:
		if (ctx.message?.text) {
			const buttonMap: Record<string, string> = {
				"⚙️ Menu": "/menu",
				"📊 Status": "/status",
				"📋 Sessions": "/sessions",
				"📜 History": "/history",
				"🤖 Model": "/model",
				"💭 Thinking": "/thinking",
				"📂 Files (/ls)": "/ls",
				"➕ New Session": "/new",
				"🔍 Git Diff": "/diff",
				"🛑 Abort": "/abort",
				"🤖 Subagents": "/subagents",
				"❓ Side Question": "/side",
				"📄 Export": "/export",
			};
			const mapped = buttonMap[ctx.message.text.trim()];
			if (mapped) {
				ctx.message.text = mapped;
				ctx.message.entities = [{ type: "bot_command", offset: 0, length: mapped.length }];
			}
		}

		return next();
	});

			async function getOrCreateSession(userId: number): Promise<string> {
		let sessionId = userActiveSessions.get(userId);
		if (sessionId) {
			try {
				await apiClient.openSession({ activeSessionId: sessionId });
				return sessionId;
			} catch {
				userActiveSessions.delete(userId);
			}
		}

		// Utamakan sesi aktif yang sedang berjalan di daemon / sistem
		const sessions = await apiClient.getSessions();
		if (sessions.length > 0) {
			// Cari sesi yang sedang live/active terlebih dahulu
			const activeMatch = sessions.find((s) => s.workerPid || s.activeSessionId) || sessions[0];
			const chosenId = activeMatch.activeSessionId ?? activeMatch.id;
			try {
				await apiClient.openSession({ activeSessionId: chosenId });
				userActiveSessions.set(userId, chosenId); saveUserSessions(userActiveSessions);
				return chosenId;
			} catch {}
		}

		// Fallback: Jika belum ada sesi sama sekali di sistem, buat sesi baru
		const created = await apiClient.openSession();
		sessionId = created.activeSessionId;
		userActiveSessions.set(userId, sessionId); saveUserSessions(userActiveSessions);
		return sessionId;
	}

	async function updatePinnedStatus(userId: number): Promise<void> {
		const pinInfo = pinnedMessages.get(userId);
		if (!pinInfo) return;

		const sessionId = userActiveSessions.get(userId);
		if (!sessionId) return;

		try {
			const state = await apiClient.getState(sessionId);
			const lines = [
				"📌 <b>Prime Agent Live Status</b>",
				"",
				`🆔 <b>Session:</b> <code>${state.activeSessionId.slice(0, 8)}</code>`,
				`📂 <b>Directory:</b> <code>${state.state?.cwd || "default"}</code>`,
				`🤖 <b>Model:</b> ${formatModelIdentifier(state.state?.model)}`,
				`💭 <b>Thinking:</b> ${state.state?.thinkingLevel || "off"}`,
			];

			if (state.state?.usage) {
				const u = state.state.usage;
				lines.push(
					`📈 <b>Tokens:</b> In: ${u.inputTokens?.toLocaleString()} | Out: ${u.outputTokens?.toLocaleString()}`,
				);
				if (u.cost) {
					lines.push(`💰 <b>Cost:</b> $${u.cost.toFixed(4)}`);
				}
			}
			if (state.children && state.children.length > 0) {
				lines.push(`🤖 <b>Subagents:</b> ${state.children.length} subagent (lihat via <b>🤖 Subagents</b>)`);
			}
			lines.push(`⏱️ <i>Updated: ${new Date().toLocaleTimeString()}</i>`);

			await bot.api.editMessageText(pinInfo.chatId, pinInfo.messageId, lines.join("\n"), {
				parse_mode: "HTML",
			});
		} catch {}
	}

	/**
	 * Core streaming prompt executor shared across text, photo, document, and voice notes.
	 */
	async function runPromptAndStream(
		ctx: any,
		sessionId: string,
		promptText: string,
		images?: Array<{ type: string; data: string; mimeType: string }>,
	): Promise<void> {
		const sendTyping = () => {
			ctx.replyWithChatAction("typing").catch(() => undefined);
		};
		sendTyping();
		const typingTimer = setInterval(sendTyping, 4000);
		const promptStartTime = Date.now();
		recordInflightTurn({ chatId: ctx.chat.id, sessionId, promptText, timestamp: promptStartTime });

		

		let currentOutputText = "";
		let isCompleted = false;

		// Cancel any existing subscription for this user
		activeUserUnsubscribes.get(ctx.from.id)?.();

		const { unsubscribe, ready } = apiClient.subscribeEvents(
			sessionId,
			async (event) => {
				const raw = event.type === "session_event" ? event.event : event;
				const type = raw.type;

				if (type === "message_update") {
					const ae = raw.assistantMessageEvent ?? raw;
					if (ae.type === "text_delta" && typeof ae.delta === "string") {
						currentOutputText += ae.delta;
					}
				} else if (type === "auto_retry_start") {
					const attempt = raw.attempt ?? 1;
					const max = raw.maxAttempts ?? 3;
					const secs = Math.max(1, Math.ceil((raw.delayMs || 1000) / 1000));
					await ctx.reply(`🔄 <i>Model gagal, mencoba ulang (${attempt}/${max}) dalam ${secs}s...</i>\n<code>${escapeHtml(raw.errorMessage || "Network error")}</code>`, {
						parse_mode: "HTML",
					}).catch(() => {});
								} else if (type === "rlm_child_update") {
					const child = raw.child;
					if (child && child.status === "running") {
						const modelName = child.model ? `${child.model.provider}/${child.model.id || child.model.modelId}` : "default";
						await ctx.reply(
							`🤖 <b>Subagent Diluncurkan (RLM Depth ${raw.child?.depth ?? 1}):</b>\n` +
							`Nama: <code>${escapeHtml(child.name || child.id || "subagent")}</code>\n` +
							`Tugas: <i>${escapeHtml(child.task || "proses analisis")}</i>\n` +
							`Model: <code>${escapeHtml(modelName)}</code>`,
							{ parse_mode: "HTML" }
						).catch(() => {});
					} else if (child && (child.status === "completed" || child.status === "failed")) {
						const icon = child.status === "completed" ? "✅" : "❌";
						await ctx.reply(
							`${icon} <b>Subagent Selesai:</b> <code>${escapeHtml(child.name || child.id)}</code> (${child.status})`,
							{ parse_mode: "HTML" }
						).catch(() => {});
					}
} else if (type === "auth_stale") {
					await ctx.reply(`🔑 <b>Peringatan:</b> Token autentikasi untuk provider <b>${escapeHtml(raw.provider || "model")}</b> kadaluarsa.`, {
						parse_mode: "HTML",
					}).catch(() => {});
				} else if (type === "extension_ui_request" || event.type === "extension_ui_request") {
					const reqObj = event.request ?? raw;
					const keyboard = new InlineKeyboard()
						.text("✅ Allow", `dialog:${reqObj.id}:allow`)
						.text("❌ Deny", `dialog:${reqObj.id}:deny`);
					await ctx.reply(
						`⚠️ <b>Permission Required:</b>\n${escapeHtml(reqObj.message || "Do you approve this action?")}`,
						{ parse_mode: "HTML", reply_markup: keyboard },
					);
				} else if (type === "agent_end") {
					clearInterval(typingTimer);
					isCompleted = true;
					clearInflightTurn();

					const messages = Array.isArray(raw.messages) ? raw.messages : [];

										let modelError = "";
					for (let i = messages.length - 1; i >= 0; i--) {
						const m = messages[i];
						if (!m || (m.role !== "assistant" && m.message?.role !== "assistant")) continue;
						const err = m.errorMessage || m.message?.errorMessage || m.error || m.message?.error;
						if (err) {
							modelError = typeof err === "string" ? err : JSON.stringify(err);
						}
						const c = m.content ?? m.message?.content;
						if (typeof c === "string" && c.trim().length > 0) {
							currentOutputText = c;
							break;
						} else if (Array.isArray(c)) {
							const textParts = c.filter((p: any) => p && p.type === "text").map((p: any) => p.text ?? "");
							if (textParts.length > 0 && textParts.join("").trim().length > 0) {
								currentOutputText = textParts.join("\n");
								break;
							}
						}
						if (modelError && currentOutputText.trim().length === 0) {
							break;
						}
					}

					let stopReason: string | undefined;
					for (let i = messages.length - 1; i >= 0; i--) {
						const m = messages[i];
						if (m?.role === "assistant" || m?.message?.role === "assistant") {
							stopReason = m.stopReason || m.message?.stopReason;
							if (stopReason) break;
						}
					}

					let replyBody = currentOutputText.trim();
					if (replyBody.length === 0) {
						if (modelError || stopReason === "error" || stopReason === "aborted" || stopReason === "maxTokens") {
							replyBody = formatDetailedError(modelError || stopReason || "Terjadi kesalahan pada model", stopReason);
						} else {
							const tools = messages.flatMap((m: any) => Array.isArray(m?.content) ? m.content.filter((b: any) => b.type === "toolCall") : []);
							if (tools.length > 0) {
								const lastT = tools[tools.length - 1];
								replyBody = `⚙️ <i>Aksi tool <code>${escapeHtml(lastT.name || "tool")}</code> selesai diproses.</i>`;
							} else {
								replyBody = "✓ (Tugas selesai diproses)";
							}
						}
					}

					const elapsedSec = Math.max(1, Math.round((Date.now() - promptStartTime) / 1000));
					const footer = `\n\n\`⏱️ ${elapsedSec}s\``;
					const finalReply = replyBody + footer;
					const chunks = splitMessage(finalReply, 3800);

					for (const chunk of chunks) {
						try {
							await sendTelegramMessageSafe(async () => {
								try {
									return await ctx.reply(markdownToTelegramHtml(chunk), {
										parse_mode: "HTML",
										reply_markup: getMainReplyKeyboard(),
									});
								} catch {
									return await ctx.reply(chunk, {
										reply_markup: getMainReplyKeyboard(),
									});
								}
							});
						} catch (e: any) {
							console.error("[TG BOT] Failed to send reply message after retries:", e.message);
						}
					}

					unsubscribe();
					activeUserUnsubscribes.delete(ctx.from.id);
					void updatePinnedStatus(ctx.from.id);
				}
			},
			(err) => {
				console.error("SSE stream error:", err);
			},
		);

		try {
			// Ensure SSE stream is established before triggering prompt execution
			await ready;
			const sessionList = await apiClient.getSessions().catch(() => []);
			const curSess = sessionList.find(s => s.id === sessionId || s.activeSessionId === sessionId);
			const isBusy = curSess?.isSessionActive || curSess?.activity === "working";
			const streamingBehavior = isBusy ? "steer" : undefined;

			await apiClient.prompt(sessionId, promptText, images, streamingBehavior);
		} catch (err: any) {
			clearInterval(typingTimer);
			isCompleted = true;
			clearInflightTurn();
			unsubscribe();
			await ctx.reply(`❌ Prompt error: ${err.message}`);
		}
	}

	async function transcribeVoice(fileBuffer: Buffer): Promise<string> {
		if (!config.whisperApiKey) {
			throw new Error(
				"Whisper API key is not configured. Set OPENAI_API_KEY or WHISPER_API_KEY to enable voice note transcription.",
			);
		}

		const form = new FormData();
		form.append("file", new Blob([fileBuffer], { type: "audio/ogg" }), "voice.ogg");
		form.append("model", "whisper-1");

		const endpoint = `${config.whisperBaseUrl ? config.whisperBaseUrl.replace(/\/+$/, "") : "https://api.openai.com/v1"}/audio/transcriptions`;
		const res = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${config.whisperApiKey}`,
			},
			body: form,
		});

		if (!res.ok) {
			throw new Error(`Whisper transcription failed: HTTP ${res.status}`);
		}

		const data = (await res.json()) as { text: string };
		return data.text;
	}

	bot.command("menu", async (ctx) => {
		const { text: menuText, keyboard } = buildFullFeatureInlineMenu();
		await ctx.reply(menuText, {
			parse_mode: "HTML",
			reply_markup: keyboard,
		});
	});

	bot.command(["start", "help"], async (ctx) => {
		const helpText = [
			"✨ <b>Prime Agent Telegram Bot</b>",
			"",
			"Send any text, photo, voice note, or code file to start coding!",
			"",
			"<b>Commands:</b>",
			"/status - Current session info, model & tokens",
			"/new - Start a fresh session",
			"/sessions - Browse & switch between recent sessions",
			"/history - Lihat riwayat percakapan sesi saat ini",
			"/model - Select model & provider",
			"/thinking - Configure thinking level",
			"/diff - View git diff for current session",
			"/rename &lt;nama&gt; - Ganti nama sesi saat ini",
			"/side &lt;tanya&gt; - Tanya sekilas tanpa menambah konteks",
			"/export - Ekspor transkrip percakapan sesi (Markdown)",
			"/ls [path] - Interactive workspace file browser",
			"/pin - Pin a live updating status message in this chat",
			"/task &lt;cron&gt; &lt;prompt&gt; - Schedule an automated task",
			"/tasks - List and manage scheduled tasks",
			"/compact - Compact session context",
			"/abort - Abort currently running task",
			"/help - Show this guide",
		].join("\n");

		await ctx.reply(helpText, { parse_mode: "HTML", reply_markup: getMainReplyKeyboard() });
	});

	bot.command("status", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const state = await apiClient.getState(sessionId);
			const lines = [
				"📊 <b>Prime Agent Status</b>",
				"",
				`🆔 <b>Session:</b> <code>${state.activeSessionId.slice(0, 8)}</code>`,
				`📂 <b>Directory:</b> <code>${state.state?.cwd || "default"}</code>`,
				`🤖 <b>Model:</b> ${formatModelIdentifier(state.state?.model)}`,
				`💭 <b>Thinking:</b> ${state.state?.thinkingLevel || "off"}`,
			];

			if (state.state?.usage) {
				const u = state.state.usage;
				lines.push(
					`📈 <b>Tokens:</b> In: ${u.inputTokens?.toLocaleString()} | Out: ${u.outputTokens?.toLocaleString()}`,
				);
				if (u.cost) {
					lines.push(`💰 <b>Cost:</b> $${u.cost.toFixed(4)}`);
				}
			}
			if (state.children && state.children.length > 0) {
				lines.push(`🤖 <b>Subagents:</b> ${state.children.length} subagent (lihat via <b>🤖 Subagents</b>)`);
			}

						const sessions = await apiClient.getSessions().catch(() => []);
			const curSess = sessions.find((s) => s.id === sessionId || s.activeSessionId === sessionId);
			const isWorking = Boolean(curSess && (curSess.isStreaming || curSess.isRunningTools || curSess.isBashRunning));

			if (isWorking) {
				lines.push("", "⚡ <b>Sesi ini sedang aktif bekerja di latar belakang!</b>");
				const trackKb = new InlineKeyboard().text("📡 Pantau & Kirim Notif", `track_session:${sessionId}`);
				await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: trackKb });
			} else {
				await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: getMainReplyKeyboard() });
			}
		} catch (err: any) {
			await ctx.reply(`❌ Failed to retrieve status: ${err.message}`);
		}
	});

	bot.command("pin", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const state = await apiClient.getState(sessionId);
			const lines = [
				"📌 <b>Prime Agent Live Status</b>",
				"",
				`🆔 <b>Session:</b> <code>${state.activeSessionId.slice(0, 8)}</code>`,
				`📂 <b>Directory:</b> <code>${state.state?.cwd || "default"}</code>`,
				`🤖 <b>Model:</b> ${formatModelIdentifier(state.state?.model)}`,
				`💭 <b>Thinking:</b> ${state.state?.thinkingLevel || "off"}`,
			];
			if (state.state?.usage) {
				const u = state.state.usage;
				lines.push(
					`📈 <b>Tokens:</b> In: ${u.inputTokens?.toLocaleString()} | Out: ${u.outputTokens?.toLocaleString()}`,
				);
			}
			lines.push(`⏱️ <i>Updated: ${new Date().toLocaleTimeString()}</i>`);

			const msg = await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: getMainReplyKeyboard() });
			await ctx.pinChatMessage(msg.message_id).catch(() => undefined);
			pinnedMessages.set(ctx.from!.id, { chatId: ctx.chat.id, messageId: msg.message_id });
		} catch (err: any) {
			await ctx.reply(`❌ Could not create pinned status: ${err.message}`);
		}
	});

	
	const dirKeyCache = new Map<string, string>();
	let dirKeyCounter = 0;

	function storeDirKey(dir: string): string {
		const k = `d_${++dirKeyCounter}`;
		dirKeyCache.set(k, dir);
		return k;
	}

	async function buildNewSessionMenu(): Promise<{ text: string; keyboard: InlineKeyboard }> {
		const sessions = await apiClient.getSessions().catch(() => []);
		const meta = await apiClient.getMeta().catch(() => ({ cwd: process.cwd(), home: "" }));
		const uniqueDirs = new Set<string>();

		if (meta.cwd) uniqueDirs.add(meta.cwd);
		for (const s of sessions) {
			if (s.cwd && s.cwd.trim().length > 0) {
				uniqueDirs.add(s.cwd);
			}
		}

		const keyboard = new InlineKeyboard();

		for (const dir of Array.from(uniqueDirs).slice(0, 5)) {
			const folderName = dir.split("/").pop() || dir;
			const key = storeDirKey(dir);
			keyboard.text(`📂 ${folderName} (${dir.slice(-25)})`, `create_in:${key}`).row();
		}

		const browseKey = storeDirKey(meta.home || meta.cwd || "/");
		keyboard.text("🔍 Jelajahi Folder Lain...", `browse_dir:${browseKey}`).row();

		const header = [
			"➕ <b>Buat Sesi Baru (Pilih Working Directory)</b>",
			"",
			"Pilih folder kerja proyek untuk sesi baru di bawah ini:",
		].join("\n");

		return { text: header, keyboard };
	}

	async function buildBrowseDirMenu(targetPath?: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
		const res = await apiClient.browseFs(targetPath);
		const keyboard = new InlineKeyboard();

		// Tombol pilih folder ini
		const currentKey = storeDirKey(res.path);
		keyboard.text("✅ Buat Sesi di Folder Ini", `create_in:${currentKey}`).row();

		// Tombol naik ke parent
		if (res.parent && res.parent !== res.path) {
			const parentKey = storeDirKey(res.parent);
			keyboard.text("⬆️ Folder Induk (Naik)", `browse_dir:${parentKey}`).row();
		}

		// Daftar sub-folder
		for (const entry of (res.entries || []).slice(0, 8)) {
			const entryKey = storeDirKey(entry.path);
			keyboard.text(`📁 ${entry.name}`, `browse_dir:${entryKey}`).row();
		}

		keyboard.text("🔙 Kembali ke Folder Terakhir", `new_recent`).row();

		const header = [
			`📁 <b>Jelajahi Folder:</b>`,
			`<code>${escapeHtml(res.path)}</code>`,
			"",
			"Pilih sub-folder atau tap '✅ Buat Sesi di Folder Ini':",
		].join("\n");

		return { text: header, keyboard };
	}


	bot.command("new", async (ctx) => {
		try {
			detachUserSessionListeners(ctx.from?.id, ctx.chat?.id);
			const { text: menuText, keyboard } = await buildNewSessionMenu();
			await ctx.reply(menuText, {
				parse_mode: "HTML",
				reply_markup: keyboard,
			});
		} catch (err: any) {
			await ctx.reply(`❌ Failed to load directory menu: ${err.message}`);
		}
	});

		const SESSIONS_PER_PAGE = 5;

	function buildSessionsMenu(list: any[], page: number, currentId?: string): { text: string; keyboard: InlineKeyboard } {
		const totalPages = Math.ceil(list.length / SESSIONS_PER_PAGE);
		const start = page * SESSIONS_PER_PAGE;
		const pageItems = list.slice(start, start + SESSIONS_PER_PAGE);

		const keyboard = new InlineKeyboard();

		for (let i = 0; i < pageItems.length; i++) {
			const s = pageItems[i];
			const isCurrent = s.id === currentId || s.activeSessionId === currentId || s.sessionId === currentId;
			const label = formatSessionItemLabel(s, start + i, isCurrent);
			keyboard.text(label, `switch:${s.activeSessionId ?? s.id}`).row();
		}

		// Navigation buttons
		const navRow = [];
		if (page > 0) {
			keyboard.text("⬅️ Prev", `sessions_page:${page - 1}`);
		}
		if (page < totalPages - 1) {
			keyboard.text("Next ➡️", `sessions_page:${page + 1}`);
		}
		keyboard.row();

		const header = [
			`📋 <b>Active & Saved Sessions</b> (Page ${page + 1}/${totalPages})`,
			`Total Sessions: <b>${list.length}</b>`,
			"",
			"Klik sesi di bawah untuk beralih dan memantau sesi tersebut:",
		].join("\n");

		return { text: header, keyboard };
	}

	bot.command("sessions", async (ctx) => {
		try {
			const list = await apiClient.getSessions();
			if (list.length === 0) {
				await ctx.reply("No sessions found. Send /new to create one.");
				return;
			}

			const currentId = userActiveSessions.get(ctx.from!.id);
			const { text: menuText, keyboard } = buildSessionsMenu(list, 0, currentId);

			await ctx.reply(menuText, {
				parse_mode: "HTML",
				reply_markup: keyboard,
			});
		} catch (err: any) {
			await ctx.reply(`❌ Failed to list sessions: ${err.message}`);
		}
	});

	bot.command(["history", "messages"], async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const state = await apiClient.getState(sessionId);
			const allMessages = state.messages || [];

			const chatMessages: string[] = [];
			for (const m of allMessages) {
				const formatted = formatMessageForChat(m);
				if (formatted) chatMessages.push(formatted);
			}

			if (chatMessages.length === 0) {
				await sendTelegramMessageSafe(async () => {
					return await ctx.reply("📭 <i>Belum ada riwayat percakapan di sesi ini.</i>", { parse_mode: "HTML" });
				});
				return;
			}

			const recent = chatMessages.slice(-5);
			const header = `📜 <b>5 Percakapan Terakhir (Sesi <code>${sessionId.slice(0, 8)}</code>):</b>`;
			
			// Pack messages into compact bubbles to avoid spamming multiple network requests
			const bubbles: string[] = [];
			let currentBubble = header;

			for (const msg of recent) {
				const candidate = `${currentBubble}\n\n───────────────\n\n${msg}`;
				if (candidate.length <= 3600) {
					currentBubble = candidate;
				} else {
					bubbles.push(currentBubble);
					currentBubble = msg;
				}
			}
			if (currentBubble) {
				bubbles.push(currentBubble);
			}

			for (const bubble of bubbles) {
				const chunks = splitMessage(bubble, 3800);
				for (const chunk of chunks) {
					await sendTelegramMessageSafe(async () => {
						try {
							return await ctx.reply(chunk, {
								parse_mode: "HTML",
								reply_markup: getMainReplyKeyboard(),
							});
						} catch {
							return await ctx.reply(chunk.replace(/<[^>]*>/g, ""), {
								reply_markup: getMainReplyKeyboard(),
							});
						}
					});
					await new Promise((r) => setTimeout(r, 250));
				}
			}
		} catch (err: any) {
			await sendTelegramMessageSafe(async () => {
				return await ctx.reply(`❌ Failed to fetch history: ${err.message}`);
			});
		}
	});

		const MODELS_PAGE_SIZE = 6;
	const modelCache = new Map<string, { provider: string; modelId: string }>();
	let modelKeySeq = 0;

	function storeModelKey(provider: string, modelId: string): string {
		const key = `m_${++modelKeySeq}`;
		modelCache.set(key, { provider, modelId });
		return key;
	}

	async function buildProviderMenu(sessionId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
		const { models } = await apiClient.getModels(sessionId);
		const state = await apiClient.getState(sessionId);
		const currentModel = state.state?.model;

		const providers = Array.from(new Set(models.map((m: any) => m.provider))).sort();
		const keyboard = new InlineKeyboard();

		for (const p of providers) {
			const count = models.filter((m: any) => m.provider === p).length;
			const isCurrent = currentModel?.provider === p;
			keyboard.text(`${isCurrent ? "👉 " : ""}${p} (${count} models)`, `model_prov:${p}:0`).row();
		}

		const header = [
			"🤖 <b>Pilih Model Provider:</b>",
			`Model saat ini: <b>${formatModelIdentifier(currentModel)}</b>`,
			"",
			"Pilih salah satu provider untuk melihat daftar model:",
		].join("\n");

		return { text: header, keyboard };
	}

	async function buildModelListMenu(sessionId: string, provider: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
		const { models } = await apiClient.getModels(sessionId);
		const state = await apiClient.getState(sessionId);
		const currentModel = state.state?.model;

		const providerModels = models.filter((m: any) => m.provider === provider);
		const totalPages = Math.ceil(providerModels.length / MODELS_PAGE_SIZE);
		const start = page * MODELS_PAGE_SIZE;
		const pageItems = providerModels.slice(start, start + MODELS_PAGE_SIZE);

		const keyboard = new InlineKeyboard();

		for (const m of pageItems) {
			const isCurrent = currentModel?.provider === provider && (currentModel?.id === m.id || currentModel?.modelId === m.id);
			const key = storeModelKey(provider, m.id);
			const label = `${isCurrent ? "🟢 " : ""}${m.name || m.id}`;
			keyboard.text(label, `set_model:${key}`).row();
		}

		// Navigation buttons
		if (page > 0) {
			keyboard.text("⬅️ Prev", `model_prov:${provider}:${page - 1}`);
		}
		if (page < totalPages - 1) {
			keyboard.text("Next ➡️", `model_prov:${provider}:${page + 1}`);
		}
		keyboard.row();
		keyboard.text("🔙 Kembali ke Provider", `model_providers`).row();

		const header = [
			`🤖 <b>Pilih Model (${provider})</b> - Halaman ${page + 1}/${totalPages}`,
			`Total: <b>${providerModels.length} models</b>`,
			"",
			"Klik model yang ingin digunakan untuk sesi ini:",
		].join("\n");

		return { text: header, keyboard };
	}

	bot.command("model", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const { text: menuText, keyboard } = await buildProviderMenu(sessionId);
			await ctx.reply(menuText, {
				parse_mode: "HTML",
				reply_markup: keyboard,
			});
		} catch (err: any) {
			await ctx.reply(`❌ Failed to list models: ${err.message}`);
		}
	});

	
	bot.command("rename", async (ctx) => {
		const newName = ctx.match?.trim();
		if (!newName) {
			await ctx.reply("Gunakan: <code>/rename &lt;nama_baru&gt;</code>", { parse_mode: "HTML" });
			return;
		}
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			await apiClient.renameSession(sessionId, newName);
			await ctx.reply(`🏷️ <b>Nama sesi berhasil diubah menjadi:</b> <i>${escapeHtml(newName)}</i>`, {
				parse_mode: "HTML",
			});
		} catch (err: any) {
			await ctx.reply(`❌ Gagal mengubah nama sesi: ${err.message}`);
		}
	});

	bot.command(["side", "ask"], async (ctx) => {
		const question = ctx.match?.trim();
		if (!question) {
			await ctx.reply("Gunakan: <code>/side &lt;pertanyaan_sekilas&gt;</code>\n<i>(Bertanya tanpa menambah context window sesi utama)</i>", {
				parse_mode: "HTML",
			});
			return;
		}
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			await ctx.replyWithChatAction("typing").catch(() => {});
			const { id } = await apiClient.askSideQuestion(sessionId, question);

			// Listen briefly on events for the side question answer
			const answerPromise = new Promise<string>((resolve) => {
				const { unsubscribe } = apiClient.subscribeEvents(sessionId, (event) => {
					const raw = event.type === "side_question_event" ? event.event : event;
					if (raw && (raw.id === id || raw.type === "side_question_event")) {
						if (raw.answer && raw.answer.trim().length > 0) {
							unsubscribe();
							resolve(raw.answer);
						} else if (raw.status === "error") {
							unsubscribe();
							resolve(`❌ Error: ${raw.errorMessage || "Gagal menjawab pertanyaan sampingan"}`);
						}
					}
				});
				setTimeout(() => {
					unsubscribe();
					resolve("⏱️ Side question timeout.");
				}, 15000);
			});

			const answer = await answerPromise;
			await ctx.reply(
				`❓ <b>Side Question:</b> <i>${escapeHtml(question)}</i>\n\n` +
				`💡 <b>Jawaban:</b>\n${markdownToTelegramHtml(answer)}`,
				{ parse_mode: "HTML" },
			);
		} catch (err: any) {
			await ctx.reply(`❌ Gagal memproses side question: ${err.message}`);
		}
	});

	
	bot.command("subagents", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const state = await apiClient.getState(sessionId);
			const children = state.children || [];

			if (children.length === 0) {
				await ctx.reply("ℹ️ <b>Tidak ada subagent</b> yang sedang atau pernah berjalan di sesi ini.", {
					parse_mode: "HTML",
				});
				return;
			}

			const keyboard = new InlineKeyboard();
			for (const c of children) {
				const id = c.id || c.childId || c.rlm_child_id || "sub";
				const name = c.sessionName || c.name || "subagent";
				const status = c.status || "running";
				const icon = status === "running" ? "⏳" : status === "completed" || status === "done" ? "✅" : "❌";
				keyboard.text(`${icon} ${name} (${status})`, `view_sub:${sessionId}:${id}`).row();
			}

			await ctx.reply(`🤖 <b>Subagents di Sesi Ini (${children.length}):</b>\n\nKlik salah satu subagent untuk melihat transkrip percakapannya:`, {
				parse_mode: "HTML",
				reply_markup: keyboard,
			});
		} catch (err: any) {
			await ctx.reply(`❌ Gagal mengambil daftar subagent: ${err.message}`);
		}
	});


	bot.command("export", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			await ctx.replyWithChatAction("upload_document").catch(() => {});
			const res = await apiClient.exportSession(sessionId);

			// If export returned a file path
			if (res.path && existsSync(res.path)) {
				const buffer = readFileSync(res.path);
				const filename = res.path.split("/").pop() || `session-${sessionId.slice(0, 8)}.html`;
				await ctx.replyWithDocument(new InputFile(buffer, filename), {
					caption: `📄 <b>Export Sesi (${sessionId.slice(0, 8)})</b>`,
					parse_mode: "HTML",
				});
				return;
			}

			// Fallback: build markdown transcript from state messages
			const state = await apiClient.getState(sessionId);
			const lines = [
				`# Transcript Session ${sessionId}`,
				`Date: ${new Date().toISOString()}`,
				`Directory: ${state.state?.cwd || "default"}`,
				`Model: ${formatModelIdentifier(state.state?.model)}`,
				"",
				"---",
				"",
			];
			for (const m of state.messages || []) {
				const role = m.role || m.message?.role;
				const content = m.content || m.message?.content;
				let text = "";
				if (typeof content === "string") text = content;
				else if (Array.isArray(content)) text = content.filter((p: any) => p && p.type === "text").map((p: any) => p.text || "").join("\n");
				if (text) {
					lines.push(`### ${role === "user" ? "👤 User" : "🤖 Assistant"}`);
					lines.push(text);
					lines.push("");
				}
			}
			const buffer = Buffer.from(lines.join("\n"), "utf8");
			await ctx.replyWithDocument(new InputFile(buffer, `session-${sessionId.slice(0, 8)}.md`), {
				caption: `📄 <b>Export Sesi (${sessionId.slice(0, 8)})</b>`,
				parse_mode: "HTML",
			});
		} catch (err: any) {
			await ctx.reply(`❌ Gagal mengekspor sesi: ${err.message}`);
		}
	});


	bot.command("thinking", async (ctx) => {
		const keyboard = new InlineKeyboard()
			.text("Off", "think:off")
			.text("Low", "think:low")
			.text("Medium", "think:medium")
			.row()
			.text("High", "think:high")
			.text("Max", "think:max");

		await ctx.reply("💭 <b>Select thinking level:</b>", {
			parse_mode: "HTML",
			reply_markup: keyboard,
		});
	});

	
	bot.command(["track", "follow"], async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const isWorking = await startTrackingSession(ctx.chat.id, sessionId);
			if (isWorking) {
				await sendTelegramMessageSafe(async () => {
					return await ctx.reply(`📡 <b>Memantau Sesi</b> <code>${sessionId.slice(0, 8)}</code>\n\n<i>Bot akan memberi notifikasi dan mengirimkan balasan ke sini begitu tugas yang berjalan selesai...</i>`, {
						parse_mode: "HTML",
					});
				});
			} else {
				await sendTelegramMessageSafe(async () => {
					return await ctx.reply(`⚠️ <b>Tidak Ada Tugas Aktif</b>\n\nSesi <code>${sessionId.slice(0, 8)}</code> saat ini sedang menganggur (idle). Listener tracking hanya dapat diaktifkan jika sesi sedang memproses tugas di Web/CLI.`, {
						parse_mode: "HTML",
					});
				});
			}
		} catch (err: any) {
			await sendTelegramMessageSafe(async () => {
				return await ctx.reply(`❌ Gagal memantau sesi: ${err.message}`);
			});
		}
	});

	bot.command("abort", async (ctx) => {
		try {
			const sessionId = userActiveSessions.get(ctx.from!.id);
			if (!sessionId) {
				await ctx.reply("No active session.");
				return;
			}
			await apiClient.abort(sessionId);
			await ctx.reply("🛑 Task aborted.");
		} catch (err: any) {
			await ctx.reply(`❌ Abort failed: ${err.message}`);
		}
	});

	bot.command("diff", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const info = await apiClient.getGitDiff(sessionId);
			if (!info.diff || info.diff.trim().length === 0) {
				await ctx.reply("✨ Clean working directory (no git diff).");
				return;
			}
			const chunks = splitMessage(info.diff, 3800);
			for (const chunk of chunks.slice(0, 3)) {
				await ctx.reply(`<pre><code>${escapeHtml(chunk)}</code></pre>`, { parse_mode: "HTML" });
			}
		} catch (err: any) {
			await ctx.reply(`❌ Git diff failed: ${err.message}`);
		}
	});

	bot.command("compact", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			await ctx.reply("📦 Compacting context...");
			await apiClient.compact(sessionId);
			await ctx.reply("✅ Context compacted successfully.");
			void updatePinnedStatus(ctx.from!.id);
		} catch (err: any) {
			await ctx.reply(`❌ Compact failed: ${err.message}`);
		}
	});

	// Interactive File Browser (/ls)
	bot.command("ls", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const args = ctx.match?.trim() ?? "";
			const res = await apiClient.listWorkspace(sessionId, args);

			const keyboard = new InlineKeyboard();
			if (res.path && res.path !== ".") {
				const parent = res.path.includes("/") ? res.path.slice(0, res.path.lastIndexOf("/")) : "";
				keyboard.text("⬅️ Back", `ls:${parent}`).row();
			}

			for (const item of res.entries.slice(0, 12)) {
				const full = res.path && res.path !== "." ? `${res.path}/${item.name}` : item.name;
				if (item.type === "dir") {
					keyboard.text(`📁 ${item.name}`, `ls:${full}`).row();
				} else {
					keyboard.text(`📄 ${item.name}`, `cat:${full}`).row();
				}
			}

			await ctx.reply(`📂 <b>Workspace:</b> <code>${escapeHtml(res.path || "/")}</code>`, {
				parse_mode: "HTML",
				reply_markup: keyboard,
			});
		} catch (err: any) {
			await ctx.reply(`❌ /ls failed: ${err.message}`);
		}
	});

	// Scheduled Tasks (/task and /tasks)
	bot.command("task", async (ctx) => {
		const match = ctx.match?.trim();
		if (!match) {
			await ctx.reply(
				"Usage: <code>/task &lt;cron-schedule&gt; &lt;prompt&gt;</code>\\nExample: <code>/task \"0 2 * * *\" Run tests and report issues</code>",
				{ parse_mode: "HTML" },
			);
			return;
		}

		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const parts = match.split(" ");
			// First 5 parts are cron expression (e.g. 0 2 * * *)
			if (parts.length < 6) {
				await ctx.reply("Invalid task syntax. Please provide a 5-part cron schedule followed by prompt.");
				return;
			}
			const schedule = parts.slice(0, 5).join(" ");
			const prompt = parts.slice(5).join(" ");

			const { job } = await apiClient.addCronJob(sessionId, schedule, prompt);
			await ctx.reply(
				`⏰ <b>Task scheduled!</b>\nID: <code>${job.id}</code>\nSchedule: <code>${schedule}</code>\nPrompt: <i>${escapeHtml(prompt)}</i>`,
				{ parse_mode: "HTML" },
			);
		} catch (err: any) {
			await ctx.reply(`❌ Failed to schedule task: ${err.message}`);
		}
	});

	bot.command("tasks", async (ctx) => {
		try {
			const sessionId = await getOrCreateSession(ctx.from!.id);
			const { jobs } = await apiClient.listCronJobs(sessionId);
			if (!jobs || jobs.length === 0) {
				await ctx.reply("No scheduled tasks found.");
				return;
			}

			const keyboard = new InlineKeyboard();
			for (const j of jobs) {
				keyboard.text(`❌ Cancel: ${j.schedule} (${j.prompt.slice(0, 15)}...)`, `cron_cancel:${j.id}`).row();
			}

			await ctx.reply("⏰ <b>Scheduled Tasks:</b>", {
				parse_mode: "HTML",
				reply_markup: keyboard,
			});
		} catch (err: any) {
			await ctx.reply(`❌ Failed to list tasks: ${err.message}`);
		}
	});

	bot.on("callback_query:data", async (ctx) => {
		const data = ctx.callbackQuery.data;
				if (data.startsWith("track_session:")) {
			const targetId = data.slice("track_session:".length);
			const ok = await startTrackingSession(ctx.chat.id, targetId);
			if (ok) {
				await ctx.answerCallbackQuery({ text: "📡 Mulai memantau sesi..." });
				await ctx.reply(`📡 <b>Memantau Sesi</b> <code>${targetId.slice(0, 8)}</code>\n\n<i>Responnya akan langsung dikirimkan ke sini begitu selesai...</i>`, {
					parse_mode: "HTML",
				});
			} else {
				await ctx.answerCallbackQuery({ text: "⚠️ Sesi sedang tidak aktif / menganggur!", show_alert: true });
			}
			return;
		}
		const userId = ctx.from.id;

				if (data.startsWith("sessions_page:")) {
			const page = Number(data.slice("sessions_page:".length));
			try {
				const list = await apiClient.getSessions();
				const currentId = userActiveSessions.get(userId);
				const { text: menuText, keyboard } = buildSessionsMenu(list, page, currentId);
				await ctx.editMessageText(menuText, {
					parse_mode: "HTML",
					reply_markup: keyboard,
				});
				await ctx.answerCallbackQuery();
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

				if (data.startsWith("session_action:rename:")) {
			const targetId = data.slice("session_action:rename:".length);
			await ctx.answerCallbackQuery();
			await ctx.reply(`Untuk mengubah nama sesi <code>${targetId.slice(0, 8)}</code>, ketik:\n<code>/rename &lt;nama_baru&gt;</code>`, {
				parse_mode: "HTML",
			});
			return;
		}

		if (data.startsWith("session_action:delete:")) {
			const targetId = data.slice("session_action:delete:".length);
			try {
				await apiClient.deleteSession(targetId);
				await ctx.answerCallbackQuery({ text: "Sesi berhasil dihapus" });
				await ctx.editMessageText(`🗑️ <b>Sesi ${targetId.slice(0, 8)} berhasil dihapus.</b>`, {
					parse_mode: "HTML",
				});
				userActiveSessions.delete(userId);
				saveUserSessions(userActiveSessions);
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Gagal menghapus: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("menu_action:")) {
			const action = data.slice("menu_action:".length);
			await ctx.answerCallbackQuery();
			const cmdMap: Record<string, string> = {
				history: "/history",
				model: "/model",
				thinking: "/thinking",
				ls: "/ls",
				diff: "/diff",
				track: "/track",
				abort: "/abort",
				subagents: "/subagents",
				side: "/side",
				export: "/export",
			};
			const targetCmd = cmdMap[action];
			if (targetCmd) {
				return (bot as any).handleUpdate({
					update_id: ctx.update.update_id,
					message: {
						message_id: ctx.callbackQuery.message?.message_id,
						from: ctx.from,
						chat: ctx.chat,
						date: Math.floor(Date.now() / 1000),
						text: targetCmd,
						entities: [{ type: "bot_command", offset: 0, length: targetCmd.length }],
					},
				});
			}
			return;
		}

if (data === "new_recent") {
			try {
				const { text: menuText, keyboard } = await buildNewSessionMenu();
				await ctx.editMessageText(menuText, {
					parse_mode: "HTML",
					reply_markup: keyboard,
				});
				await ctx.answerCallbackQuery();
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("browse_dir:")) {
			const key = data.slice("browse_dir:".length);
			const targetDir = dirKeyCache.get(key);
			try {
				const { text: menuText, keyboard } = await buildBrowseDirMenu(targetDir);
				await ctx.editMessageText(menuText, {
					parse_mode: "HTML",
					reply_markup: keyboard,
				});
				await ctx.answerCallbackQuery();
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("create_in:")) {
			const key = data.slice("create_in:".length);
			const targetCwd = dirKeyCache.get(key);
			try {
				await ctx.answerCallbackQuery({ text: "Membuat sesi baru..." });
				detachUserSessionListeners(userId, ctx.chat?.id);
				const res = await apiClient.openSession({ cwd: targetCwd });
				userActiveSessions.set(userId, res.activeSessionId);
				saveUserSessions(userActiveSessions);

				const folderName = (targetCwd || "").split("/").pop() || "default";
				await ctx.editMessageText(
					`🆕 <b>Sesi Baru Berhasil Dibuat!</b>\n\n` +
					`🆔 <b>ID:</b> <code>${res.activeSessionId.slice(0, 8)}</code>\n` +
					`📂 <b>Folder:</b> <code>${escapeHtml(res.state?.cwd || targetCwd || "default")}</code>\n` +
					`🤖 <b>Model:</b> ${formatModelIdentifier(res.state?.model)}\n\n` +
					`💡 <i>Ketik pesan atau instruksi untuk mulai bekerja di folder ini.</i>`,
					{ parse_mode: "HTML" },
				);
				void updatePinnedStatus(userId);
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Gagal membuat sesi: ${err.message}` });
			}
			return;
		}

				if (data.startsWith("view_sub:")) {
			const [, sessId, childId] = data.split(":");
			try {
				await ctx.answerCallbackQuery({ text: "Memuat transkrip subagent..." });
				const res = await apiClient.getSubagentMessages(sessId, childId);
				const messages = res.messages || [];

				if (messages.length === 0) {
					await ctx.reply(`📄 <b>Transkrip Subagent (${childId.slice(0, 8)}):</b>\n<i>Belum ada pesan tercatat.</i>`, {
						parse_mode: "HTML",
					});
					return;
				}

				const formattedList: string[] = [];
				for (const m of messages.slice(-5)) {
					const formatted = formatMessageForChat(m);
					if (formatted) formattedList.push(formatted);
				}

				await ctx.reply(
					`🤖 <b>Transkrip Subagent (5 pesan terakhir):</b>\n\n` + formattedList.join("\n\n──────────────\n\n"),
					{ parse_mode: "HTML" }
				);
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Gagal: ${err.message}` });
			}
			return;
		}

if (data.startsWith("switch:")) {
			const targetId = data.slice("switch:".length);
			try {
				// Eagerly open/attach to the session on the gateway
				detachUserSessionListeners(userId, ctx.chat?.id);
				const snapshot = await apiClient.openSession({ activeSessionId: targetId });
				userActiveSessions.set(userId, targetId); saveUserSessions(userActiveSessions);
				await ctx.answerCallbackQuery({ text: `Switched to session ${targetId.slice(0, 8)}` });
				
				const lines = [
					`✅ <b>Active session switched!</b>`,
					"",
					`🆔 <b>Session:</b> <code>${targetId.slice(0, 8)}</code>`,
					`📂 <b>Directory:</b> <code>${snapshot.state?.cwd || "default"}</code>`,
					`🤖 <b>Model:</b> ${formatModelIdentifier(snapshot.state?.model)}`,
				];
								const sessionList = await apiClient.getSessions().catch(() => []);
				const matchedSess = sessionList.find(s => s.id === targetId || s.activeSessionId === targetId);
				const isWorking = Boolean(matchedSess && (matchedSess.isStreaming || matchedSess.isRunningTools || matchedSess.isBashRunning));

				const switchKb = new InlineKeyboard();
				if (isWorking) {
					switchKb.text("📡 Pantau Sesi Ini", `track_session:${targetId}`).row();
				}
				switchKb.text("🏷️ Rename Sesi", `session_action:rename:${targetId}`)
					.text("🗑️ Hapus Sesi", `session_action:delete:${targetId}`);
				await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: switchKb });

				// Otomatis tampilkan percakapan terakhir agar user langsung tahu konteks sesi
				const chatMessages: string[] = [];
				for (const m of snapshot.messages || []) {
					const formatted = formatMessageForChat(m);
					if (formatted) chatMessages.push(formatted);
				}
				if (chatMessages.length > 0) {
					const recent = chatMessages.slice(-2);
					const previewText = `📜 <b>Riwayat Terakhir Sesi (<code>${targetId.slice(0, 8)}</code>):</b>\n\n` + recent.join("\n\n───────────────\n\n");
					const chunks = splitMessage(previewText, 3800);
					for (const chunk of chunks) {
						await sendTelegramMessageSafe(async () => {
							try {
								return await ctx.reply(chunk, { parse_mode: "HTML" });
							} catch {
								return await ctx.reply(chunk.replace(/<[^>]*>/g, ""));
							}
						});
					}
				} else {
					await sendTelegramMessageSafe(async () => {
						return await ctx.reply("ℹ️ <i>Sesi ini belum memiliki percakapan.</i>", { parse_mode: "HTML" });
					});
				}


				void updatePinnedStatus(userId);
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Failed to switch: ${err.message}` });
			}
			return;
		}

		if (data === "model_providers") {
			stopTrackingSession(ctx.chat.id);
		const sessionId = await getOrCreateSession(userId);
			try {
				const { text: menuText, keyboard } = await buildProviderMenu(sessionId);
				await ctx.editMessageText(menuText, {
					parse_mode: "HTML",
					reply_markup: keyboard,
				});
				await ctx.answerCallbackQuery();
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("model_prov:")) {
			const [, provider, pageStr] = data.split(":");
			const page = Number(pageStr || "0");
			const sessionId = await getOrCreateSession(userId);
			try {
				const { text: menuText, keyboard } = await buildModelListMenu(sessionId, provider, page);
				await ctx.editMessageText(menuText, {
					parse_mode: "HTML",
					reply_markup: keyboard,
				});
				await ctx.answerCallbackQuery();
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("set_model:")) {
			const key = data.slice("set_model:".length);
			const item = modelCache.get(key);
			if (!item) {
				await ctx.answerCallbackQuery({ text: "Model selection expired, please run /model again" });
				return;
			}
			const sessionId = await getOrCreateSession(userId);
			try {
				await apiClient.setModel(sessionId, item.provider, item.modelId);
				await ctx.answerCallbackQuery({ text: `Model updated to ${item.modelId}` });
				await ctx.editMessageText(
					`✅ <b>Model berhasil diubah!</b>\n\nProvider: <b>${item.provider}</b>\nModel: <code>${item.modelId}</code>`,
					{ parse_mode: "HTML" },
				);
				void updatePinnedStatus(userId);
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("think:")) {
			const level = data.slice("think:".length);
			const sessionId = await getOrCreateSession(userId);
			try {
				await apiClient.setThinking(sessionId, level);
				await ctx.answerCallbackQuery({ text: `Thinking set to ${level}` });
				await ctx.editMessageText(`✅ Thinking level set to: <b>${level}</b>`, { parse_mode: "HTML" });
				void updatePinnedStatus(userId);
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("dialog:")) {
			const [, dialogId, action] = data.split(":");
			const sessionId = await getOrCreateSession(userId);
			try {
				const response =
					action === "allow"
						? { confirmed: true }
						: action === "deny"
							? { confirmed: false }
							: { cancelled: true };
				await apiClient.respondDialog(sessionId, dialogId, response);
				await ctx.answerCallbackQuery({ text: `Response sent: ${action}` });
				await ctx.editMessageText(`✅ Dialog response recorded: <b>${action}</b>`, {
					parse_mode: "HTML",
				});
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("ls:")) {
			const targetPath = data.slice("ls:".length);
			const sessionId = await getOrCreateSession(userId);
			try {
				const res = await apiClient.listWorkspace(sessionId, targetPath);
				const keyboard = new InlineKeyboard();
				if (res.path && res.path !== ".") {
					const parent = res.path.includes("/") ? res.path.slice(0, res.path.lastIndexOf("/")) : "";
					keyboard.text("⬅️ Back", `ls:${parent}`).row();
				}
				for (const item of res.entries.slice(0, 12)) {
					const full = res.path && res.path !== "." ? `${res.path}/${item.name}` : item.name;
					if (item.type === "dir") {
						keyboard.text(`📁 ${item.name}`, `ls:${full}`).row();
					} else {
						keyboard.text(`📄 ${item.name}`, `cat:${full}`).row();
					}
				}
				await ctx.editMessageText(`📂 <b>Workspace:</b> <code>${escapeHtml(res.path || "/")}</code>`, {
					parse_mode: "HTML",
					reply_markup: keyboard,
				});
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}

		if (data.startsWith("cat:")) {
			const filePath = data.slice("cat:".length);
			const sessionId = await getOrCreateSession(userId);
			try {
				await ctx.answerCallbackQuery({ text: `Fetching ${filePath}...` });
				const res = await apiClient.readWorkspaceFile(sessionId, filePath);
				if (res.binary || (res.content && res.content.length > 3000)) {
					// Send as file document
					const filename = filePath.split("/").pop() || "file.txt";
					const buffer = Buffer.from(res.content || "");
					await ctx.replyWithDocument(new InputFile(buffer, filename));
				} else if (res.content) {
					await ctx.reply(`📄 <b>${escapeHtml(filePath)}:</b>\n<pre><code>${escapeHtml(res.content)}</code></pre>`, {
						parse_mode: "HTML",
					});
				}
			} catch (err: any) {
				await ctx.reply(`❌ Failed to read file: ${err.message}`);
			}
			return;
		}

		if (data.startsWith("cron_cancel:")) {
			const jobId = data.slice("cron_cancel:".length);
			const sessionId = await getOrCreateSession(userId);
			try {
				await apiClient.cancelCronJob(sessionId, jobId);
				await ctx.answerCallbackQuery({ text: "Task cancelled" });
				await ctx.editMessageText(`✅ Scheduled task <code>${jobId}</code> cancelled.`, {
					parse_mode: "HTML",
				});
			} catch (err: any) {
				await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
			}
			return;
		}
	});

	bot.on("message:photo", async (ctx) => {
		const userId = ctx.from.id;
		const sessionId = await getOrCreateSession(userId);

		const photo = ctx.message.photo.pop();
		if (!photo) return;

		const file = await ctx.getFile();
		const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

		try {
			const res = await fetch(fileUrl);
			const arrayBuf = await res.arrayBuffer();
			const base64 = Buffer.from(arrayBuf).toString("base64");

			const promptText = ctx.message.caption || "Analyze this image and describe what you see or fix the issue.";
			const imageContent = {
				type: "image",
				data: base64,
				mimeType: "image/jpeg",
			};

			await runPromptAndStream(ctx, sessionId, promptText, [imageContent]);
		} catch (err: any) {
			await ctx.reply(`❌ Failed to process photo: ${err.message}`);
		}
	});

	bot.on("message:document", async (ctx) => {
		const userId = ctx.from.id;
		const sessionId = await getOrCreateSession(userId);

		const doc = ctx.message.document;
		if (!doc) return;

		const file = await ctx.getFile();
		const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

		try {
			const res = await fetch(fileUrl);
			const text = await res.text();
			const caption = ctx.message.caption || "Please inspect and handle this attached file.";
			const fullPrompt = `${caption}\n\n--- Attached File: ${doc.file_name || "document"} ---\n${text}\n--- End of Attached File ---`;

			await runPromptAndStream(ctx, sessionId, fullPrompt);
		} catch (err: any) {
			await ctx.reply(`❌ Failed to process document: ${err.message}`);
		}
	});

	bot.on("message:voice", async (ctx) => {
		const userId = ctx.from.id;
		const sessionId = await getOrCreateSession(userId);

		const file = await ctx.getFile();
		const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

		const statusMsg = await ctx.reply("🎙️ <i>Transcribing voice message...</i>", { parse_mode: "HTML" });

		try {
			const res = await fetch(fileUrl);
			const buffer = Buffer.from(await res.arrayBuffer());
			const transcribedText = await transcribeVoice(buffer);

			await ctx.api.editMessageText(
				ctx.chat.id,
				statusMsg.message_id,
				`🎙️ <i>Prompt:</i> "<b>${escapeHtml(transcribedText)}</b>"`,
				{ parse_mode: "HTML" },
			);

			await runPromptAndStream(ctx, sessionId, transcribedText);
		} catch (err: any) {
			await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Voice transcription error: ${err.message}`);
		}
	});

	bot.on("message:text", async (ctx) => {
		const promptText = ctx.message.text.trim();
		const userId = ctx.from.id;

		let sessionId: string;
		try {
			sessionId = await getOrCreateSession(userId);
		} catch (err: any) {
			await ctx.reply(`❌ Failed to access session: ${err.message}`);
			return;
		}

		await runPromptAndStream(ctx, sessionId, promptText);
	});

	
		
	
	const activeTrackers = new Map<number, { sessionId: string; cleanup: () => void }>();

	function stopTrackingSession(chatId: number): void {
		const existing = activeTrackers.get(chatId);
		if (existing) {
			existing.cleanup();
			activeTrackers.delete(chatId);
		}
	}

	async function startTrackingSession(chatId: number, sessionId: string): Promise<boolean> {
		stopTrackingSession(chatId);

		const sessions = await apiClient.getSessions().catch(() => []);
		const sess = sessions.find((s) => s.id === sessionId || s.activeSessionId === sessionId);
		const isWorking = Boolean(sess && (sess.isStreaming || sess.isRunningTools || sess.isBashRunning || sess.activity === "working"));
		if (!isWorking) return false;

		const sendTyping = () => {
			bot.api.sendChatAction(chatId, "typing").catch(() => undefined);
		};
		sendTyping();
		const typingTimer = setInterval(sendTyping, 4000);

		let currentOutputText = "";

		const { unsubscribe } = apiClient.subscribeEvents(sessionId, async (event) => {
			const raw = event.type === "session_event" ? event.event : event;
			if (raw.type === "message_update") {
				const ae = raw.assistantMessageEvent ?? raw;
				if (ae.type === "text_delta" || ae.type === "text_start") {
					currentOutputText += ae.delta ?? "";
				}
			}

			if (raw.type === "agent_end") {
				stopTrackingSession(chatId);
				let deliverText = currentOutputText.trim();

				if (!deliverText) {
					const messages = Array.isArray(raw.messages) ? raw.messages : [];
					for (let i = messages.length - 1; i >= 0; i--) {
						const m = messages[i];
						if (!m || (m.role !== "assistant" && m.message?.role !== "assistant")) continue;
						const c = m.content ?? m.message?.content;
						if (typeof c === "string" && c.trim().length > 0) {
							deliverText = c;
							break;
						} else if (Array.isArray(c)) {
							const textParts = c.filter((p: any) => p && p.type === "text").map((p: any) => p.text ?? "");
							if (textParts.length > 0 && textParts.join("").trim().length > 0) {
								deliverText = textParts.join("\n");
								break;
							}
						}
					}
				}

				// Fallback: fetch state if stream didn't capture the final text
				if (!deliverText) {
					const state = await apiClient.getState(sessionId).catch(() => null);
					for (const m of (state?.messages || []).slice().reverse()) {
						if (m.role === "assistant" || m.message?.role === "assistant") {
							const c = m.content ?? m.message?.content;
							if (typeof c === "string" && c.trim()) { deliverText = c; break; }
							if (Array.isArray(c)) {
								const t = c.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n");
								if (t.trim()) { deliverText = t; break; }
							}
						}
					}
				}

				if (!deliverText) {
					const state = await apiClient.getState(sessionId).catch(() => null);
					const tools = (state?.messages || []).flatMap((m: any) => Array.isArray(m?.content) ? m.content.filter((b: any) => b.type === "toolCall") : []);
					if (tools.length > 0) {
						const lastT = tools[tools.length - 1];
						deliverText = `⚙️ <i>Aksi tool <code>${escapeHtml(lastT.name || "tool")}</code> selesai diproses.</i>`;
					}
				}

				if (deliverText) {
					const chunks = splitMessage(deliverText, 3800);
					for (const chunk of chunks) {
						await sendTelegramMessageSafe(async () => {
							try {
								return await bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), {
									parse_mode: "HTML",
									reply_markup: getMainReplyKeyboard(),
								});
							} catch {
								return await bot.api.sendMessage(chatId, chunk, {
									reply_markup: getMainReplyKeyboard(),
								});
							}
						});
					}
				}
			}
		});

		activeTrackers.set(chatId, {
			sessionId,
			cleanup: () => {
				clearInterval(typingTimer);
				unsubscribe();
			},
		});

		return true;
	}

	async function runStartupRecovery(): Promise<void> {
		const turn = readInflightTurn();
		if (!turn) return;
		console.log(`[STARTUP RECOVERY] Found uncompleted turn for session ${turn.sessionId}, checking status...`);

		const sendTyping = () => {
			bot.api.sendChatAction(turn.chatId, "typing").catch(() => undefined);
		};
		sendTyping();
		const typingTimer = setInterval(sendTyping, 4000);

		const deliver = async (replyText: string) => {
			clearInterval(typingTimer);
			clearInflightTurn();
			const chunks = splitMessage(replyText, 3800);
			for (const chunk of chunks) {
				try {
					await sendTelegramMessageSafe(async () => {
						try {
							return await bot.api.sendMessage(turn.chatId, markdownToTelegramHtml(chunk), {
								parse_mode: "HTML",
								reply_markup: getMainReplyKeyboard(),
							});
						} catch {
							return await bot.api.sendMessage(turn.chatId, chunk, {
								reply_markup: getMainReplyKeyboard(),
							});
						}
					});
				} catch {
					await bot.api.sendMessage(turn.chatId, chunk, {
						reply_markup: getMainReplyKeyboard(),
					});
				}
			}
		};

		const sessions = await apiClient.getSessions().catch(() => []);
		const sess = sessions.find((s) => s.id === turn.sessionId || s.activeSessionId === turn.sessionId);
		const isBusy = sess?.isSessionActive || sess?.activity === "working";

		if (isBusy) {
			console.log(`[STARTUP RECOVERY] Session ${turn.sessionId} is still working, subscribing to live stream...`);
			const { unsubscribe } = apiClient.subscribeEvents(turn.sessionId, async (event) => {
				const raw = event.type === "session_event" ? event.event : event;
				if (raw.type === "agent_end") {
					unsubscribe();
					const messages = Array.isArray(raw.messages) ? raw.messages : [];
					for (let i = messages.length - 1; i >= 0; i--) {
						const m = messages[i];
						if (!m || (m.role !== "assistant" && m.message?.role !== "assistant")) continue;
						const c = m.content ?? m.message?.content;
						let text = "";
						if (typeof c === "string") text = c;
						else if (Array.isArray(c)) text = c.filter((p: any) => p && p.type === "text").map((p: any) => p.text ?? "").join("\n");
						if (text.trim().length > 0) {
							await deliver(text);
							return;
						}
					}
					// Keep waiting for real turn text
				}
			});
		} else {
			console.log(`[STARTUP RECOVERY] Session ${turn.sessionId} already finished, fetching latest response...`);
			const state = await apiClient.getState(turn.sessionId).catch(() => null);
			const messages = state?.messages || [];
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (!m || (m.role !== "assistant" && m.message?.role !== "assistant")) continue;
				const timestamp = m.timestamp ?? m.message?.timestamp ?? 0;
				if (timestamp >= turn.timestamp - 5000) {
					const c = m.content ?? m.message?.content;
					let text = "";
					if (typeof c === "string") text = c;
					else if (Array.isArray(c)) text = c.filter((p: any) => p && p.type === "text").map((p: any) => p.text ?? "").join("\n");
					if (text.trim().length > 0) {
						await deliver(text);
						return;
					}
				}
				break;
			}
			clearInterval(typingTimer);
			clearInflightTurn();
		}
	}

	void runStartupRecovery();

	return bot;
}
