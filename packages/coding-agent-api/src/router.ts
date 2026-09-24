import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
	type AgentConnection,
	type AgentConnectionExtensionUiResponse,
	getAgentDir,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	deleteSavedSessionFile,
	killDaemonSession,
	listDaemonSessions,
	resumeSessionQueue,
} from "./daemon.js";
import { HttpError } from "./errors.js";
import { executeTerminalCommand, gitInfo, listDirectory, readWorkspaceFile, writeWorkspaceFile } from "./fs.js";
import type { RosterHub } from "./roster.js";
import {
	type ApiSession,
	type ApiSessionPool,
	findSessionFileInDir,
	pruneMessageForApi,
} from "./session-pool.js";

export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const DELIVERY_MODES = new Set(["steer", "follow_up"]);
export const HEARTBEAT_ACTIONS = new Set(["pause", "resume", "stop"]);
export const FORK_POSITIONS = new Set(["before", "at"]);

export interface ApiContext {
	sessionPool: ApiSessionPool;
	rosterHub: RosterHub;
	version?: string;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = Buffer.from(JSON.stringify(body));
	const acceptEncoding = String((res as any).req?.headers?.["accept-encoding"] ?? "").toLowerCase();
	if (payload.length > 1024 && acceptEncoding.includes("gzip")) {
		const compressed = gzipSync(payload, { level: 9 });
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-encoding": "gzip",
			"cache-control": "no-store",
			vary: "Accept-Encoding",
		});
		res.end(compressed);
		return;
	}
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(payload);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through to empty body
	}
	return {};
}

export function dialogResponse(body: Record<string, unknown>): AgentConnectionExtensionUiResponse | undefined {
	if (body.cancelled === true) return { cancelled: true };
	if (typeof body.value === "string") return { value: body.value };
	if (typeof body.confirmed === "boolean") return { confirmed: body.confirmed };
	return undefined;
}

/**
 * Handles an API or event-stream HTTP request.
 * Returns true if the request was recognized and handled, or false if it is not an API route.
 */
export async function handleApiRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	context: ApiContext,
): Promise<boolean> {
	const method = req.method ?? "GET";
	const pathname = url.pathname;
	const { sessionPool, rosterHub } = context;

	// Only handle API and event routes
	if (!pathname.startsWith("/api/") && pathname !== "/events" && pathname !== "/events/roster") {
		return false;
	}

	if (method === "GET" && pathname === "/api/meta") {
		json(res, 200, {
			cwd: process.cwd(),
			home: homedir(),
			version: context.version ?? VERSION,
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/sessions") {
		json(res, 200, { sessions: await listDaemonSessions() });
		return true;
	}

	if (method === "POST" && pathname === "/api/session") {
		const session = await sessionPool.openFromBody(await readJson(req));
		const snapshot = await sessionPool.getSessionSnapshot(session);
		json(res, 200, { activeSessionId: session.activeSessionId, streamSequence: session.streamSequence, ...snapshot });
		return true;
	}

	if (method === "GET" && pathname === "/api/state") {
		const session = await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const snapshot = await sessionPool.getSessionSnapshot(session);
		json(res, 200, { activeSessionId: session.activeSessionId, streamSequence: session.streamSequence, ...snapshot });
		return true;
	}

	if (method === "GET" && pathname === "/events") {
		await sessionPool.serveEvents(res, url);
		return true;
	}

	if (method === "GET" && pathname === "/events/roster") {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		const unsubscribe = await rosterHub.subscribe(res);
		if (res.destroyed || res.writableEnded) {
			unsubscribe();
			return true;
		}
		const heartbeat = setInterval(() => {
			try {
				if (!res.writableNeedDrain) res.write(": ping\n\n");
			} catch {
				clearInterval(heartbeat);
				unsubscribe();
				res.destroy();
			}
		}, 15_000);
		res.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
		return true;
	}

	if (method === "DELETE" && pathname === "/api/session") {
		const sessionId = url.searchParams.get("sessionId");
		if (!sessionId) throw new HttpError(400, "sessionId is required");
		const live = sessionPool.sessions.get(sessionId);
		let sessionFile: string | undefined;
		if (live) {
			sessionFile = (await live.connection.getState().catch(() => undefined))?.sessionFile;
			sessionPool.closeSession(live);
		}
		try {
			await killDaemonSession(sessionId);
		} catch {
			// already stopped
		}
		if (!sessionFile) {
			const all = await listDaemonSessions();
			sessionFile = all.find((s) => s.sessionId === sessionId || s.id === sessionId)?.sessionFile;
		}
		if (sessionFile) {
			await deleteSavedSessionFile(sessionFile).catch((error) => {
				process.stderr.write(
					`prime-agent-api: could not delete transcript: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			});
		}
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "POST" && pathname === "/api/prompt") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const message = asString(body.message);
		if (!message) throw new HttpError(400, "message is required");
		const streamingBehavior = asString(body.streamingBehavior);
		const images = Array.isArray(body.images) ? (body.images as any[]) : undefined;
		const promptOptions: Parameters<AgentConnection["prompt"]>[1] = {
			...(streamingBehavior === "steer" || streamingBehavior === "followUp" ? { streamingBehavior } : {}),
			...(images && images.length > 0 ? { images } : {}),
			queueIfBusy: true,
		};
		try {
			await session.connection.prompt(message, promptOptions);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			if (!/not accepted by the session|input is suspended/i.test(messageText)) throw error;
			await resumeSessionQueue(session.activeSessionId);
			await session.connection.prompt(message, promptOptions);
		}
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "POST" && pathname === "/api/steer") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const message = asString(body.message);
		if (!message) throw new HttpError(400, "message is required");
		await session.connection.steer(message);
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "POST" && pathname === "/api/abort") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		await session.connection.abort();
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "POST" && pathname === "/api/dialog") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const id = asString(body.id);
		const response = dialogResponse(body);
		if (!id || !response) throw new HttpError(400, "id plus value/confirmed/cancelled is required");
		await session.connection.respondToExtensionUiRequest(id, response);
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "GET" && pathname === "/api/models") {
		const session = await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { models: await session.connection.getAvailableModels() });
		return true;
	}

	if (method === "POST" && pathname === "/api/model") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const provider = asString(body.provider);
		const modelId = asString(body.modelId);
		if (!provider || !modelId) throw new HttpError(400, "provider and modelId are required");
		await session.connection.setModel(provider, modelId);
		const state = await session.connection.getState();
		json(res, 200, { ok: true, state });
		return true;
	}

	if (method === "POST" && pathname === "/api/thinking") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const level = asString(body.level);
		if (!level || !THINKING_LEVELS.has(level)) throw new HttpError(400, "invalid thinking level");
		await session.connection.setThinkingLevel(level as Parameters<AgentConnection["setThinkingLevel"]>[0]);
		const state = await session.connection.getState();
		json(res, 200, { ok: true, state });
		return true;
	}

	if (method === "GET" && pathname === "/api/commands") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { commands: await session.connection.getCommands() });
		return true;
	}

	if (method === "POST" && pathname === "/api/reload") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		await session.connection.reload?.();
		const state = await session.connection.getState();
		json(res, 200, { ok: true, state, commands: await session.connection.getCommands() });
		return true;
	}

	if (method === "POST" && pathname === "/api/export") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const exported = await session.connection.export();
		json(res, 200, { ok: true, ...exported });
		return true;
	}

	if (method === "POST" && pathname === "/api/session-name") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const name = asString(body.name);
		if (!name) throw new HttpError(400, "name is required");
		await session.connection.setSessionName(name);
		json(res, 200, { ok: true, name });
		return true;
	}

	if (method === "POST" && pathname === "/api/new") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const result = await session.connection.newSession();
		const [state, messages] = await Promise.all([session.connection.getState(), session.connection.getMessages()]);
		json(res, 200, { ...result, state, messages });
		return true;
	}

	if (method === "POST" && pathname === "/api/compact") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const result = await session.connection.compact(asString(body.instructions));
		json(res, 200, result);
		return true;
	}

	if (method === "POST" && pathname === "/api/refine") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const result = await session.connection.refine({
			instructions: asString(body.instructions),
			rollbackId: asString(body.rollbackId),
			global: asBoolean(body.global),
		});
		json(res, 200, result);
		return true;
	}

	if (method === "POST" && pathname === "/api/auto-compact") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		await session.connection.setAutoCompactionEnabled(asBoolean(body.enabled) ?? true);
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "GET" && pathname === "/api/subagent-messages") {
		const sessionId = url.searchParams.get("sessionId");
		const childId = url.searchParams.get("childId");
		if (!sessionId) throw new HttpError(400, "sessionId is required");
		if (!childId) throw new HttpError(400, "childId is required");
		const session = await sessionPool.resolveSession(sessionId);

		const children = typeof session.connection.getRlmChildSnapshots === "function"
			? await session.connection.getRlmChildSnapshots().catch(() => [])
			: [];
		const child = children.find(
			(c) => c.id === childId || c.sessionName === childId || c.activeSessionId === childId || (c.sessionDir && c.sessionDir.includes(childId)),
		);

		let messages: unknown[] = [];

		if (child?.activeSessionId && typeof session.connection.watchSession === "function") {
			try {
				const watcher = await session.connection.watchSession(child.activeSessionId);
				if (watcher) {
					const liveMsgs = await watcher.getMessages();
					await watcher.close();
					if (Array.isArray(liveMsgs) && liveMsgs.length > 0) {
						messages = liveMsgs;
					}
				}
			} catch {}
		}

		if (messages.length === 0) {
			let sessionDir = child?.sessionDir;
			if (!sessionDir) {
				const rootState = await session.connection.getState().catch(() => undefined);
				const rootSessionId = rootState?.sessionId;
				if (rootSessionId) {
					const artifactsRoot = join(getAgentDir(), "session-artifacts", rootSessionId);
					if (existsSync(artifactsRoot)) {
						const candidate = join(artifactsRoot, childId);
						if (existsSync(candidate)) {
							sessionDir = candidate;
						} else {
							try {
								for (const sub of readdirSync(artifactsRoot)) {
									if (sub === childId || sub.includes(childId)) {
										sessionDir = join(artifactsRoot, sub);
										break;
									}
								}
							} catch {}
						}
					}
				}
			}

			if (sessionDir && existsSync(sessionDir)) {
				const sessionFile = findSessionFileInDir(sessionDir);
				if (sessionFile && existsSync(sessionFile)) {
					try {
						const raw = await readFile(sessionFile, "utf8");
						messages = raw
							.split("\n")
							.filter((line) => line.trim().length > 0)
							.map((line) => {
								try {
									return JSON.parse(line);
								} catch {
									return null;
								}
							})
							.filter(Boolean);
					} catch {}
				}
			}
		}

		const pruned = messages.map(pruneMessageForApi);
		json(res, 200, { childId, messages: pruned });
		return true;
	}

	if (method === "GET" && pathname === "/api/fork-messages") {
		const sessionId = url.searchParams.get("sessionId");
		if (!sessionId) throw new HttpError(400, "sessionId is required");
		const session = await sessionPool.resolveSession(sessionId);
		const rawMessages = await session.connection.getMessages();
		const userMessages = rawMessages
			.map((entry: any, index: number) => {
				const role = entry.role ?? entry.message?.role;
				if (role !== "user") return null;
				let text = "";
				const content = entry.content ?? entry.message?.content;
				if (typeof content === "string") {
					text = content;
				} else if (Array.isArray(content)) {
					text = content
						.filter((p: any) => p && p.type === "text")
						.map((p: any) => p.text ?? "")
						.join("\n");
				}
				return {
					id: entry.id ?? `msg-${index}`,
					text: text.slice(0, 300),
					timestamp: entry.timestamp ?? entry.message?.timestamp ?? Date.now(),
				};
			})
			.filter(Boolean);
		json(res, 200, { messages: userMessages });
		return true;
	}

	if (method === "POST" && pathname === "/api/fork") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const entryId = asString(body.entryId);
		const position = asString(body.position) ?? "before";
		if (!entryId) throw new HttpError(400, "entryId is required");
		if (!FORK_POSITIONS.has(position)) throw new HttpError(400, "invalid position");
		const result = await session.connection.fork(entryId, { position: position as "before" | "at" });
		const [state, messages] = await Promise.all([session.connection.getState(), session.connection.getMessages()]);
		json(res, 200, { ...result, state, messages, activeSessionId: session.activeSessionId });
		return true;
	}

	if (method === "POST" && pathname === "/api/clone") {
		const body = await readJson(req);
		const session = await sessionPool.resolveSession(asString(body.sessionId));
		const { leafId } = await session.connection.getSessionTree();
		if (!leafId) throw new HttpError(400, "Nothing to clone yet");
		const result = await session.connection.fork(leafId, { position: "at" });
		const [state, messages] = await Promise.all([session.connection.getState(), session.connection.getMessages()]);
		json(res, 200, { ...result, state, messages, activeSessionId: session.activeSessionId });
		return true;
	}

	if (method === "GET" && pathname === "/api/cron") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const includeInactive = url.searchParams.get("includeInactive") === "1";
		json(res, 200, { jobs: await session.connection.listCronJobs({ includeInactive }) });
		return true;
	}

	if (method === "POST" && pathname === "/api/cron") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const schedule = asString(body.schedule);
		const prompt = asString(body.prompt);
		if (!schedule || !prompt) throw new HttpError(400, "schedule and prompt are required");
		const job = await session.connection.addCronJob(schedule, prompt);
		json(res, 200, { job });
		return true;
	}

	if (method === "DELETE" && pathname === "/api/cron") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const jobId = url.searchParams.get("jobId");
		if (!jobId) throw new HttpError(400, "jobId is required");
		await session.connection.cancelCronJob(jobId);
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "GET" && pathname === "/api/heartbeats") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { heartbeats: await session.connection.listHeartbeats() });
		return true;
	}

	if (method === "POST" && pathname === "/api/heartbeat") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const schedule = asString(body.schedule);
		const instruction = asString(body.instruction);
		if (!schedule || !instruction) throw new HttpError(400, "schedule and instruction are required");
		const deliveryMode = asString(body.deliveryMode);
		const job = await session.connection.setHeartbeat(
			schedule,
			instruction,
			deliveryMode && DELIVERY_MODES.has(deliveryMode) ? (deliveryMode as "steer" | "follow_up") : undefined,
		);
		json(res, 200, { job });
		return true;
	}

	if (method === "POST" && pathname === "/api/heartbeat-action") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const jobId = asString(body.jobId);
		const action = asString(body.action);
		if (!jobId || !action || !HEARTBEAT_ACTIONS.has(action)) {
			throw new HttpError(400, "jobId and action (pause, resume, stop) are required");
		}
		const job = await session.connection.manageHeartbeat(
			jobId,
			action as Parameters<AgentConnection["manageHeartbeat"]>[1],
		);
		json(res, 200, { job });
		return true;
	}

	if (method === "POST" && pathname === "/api/side-question") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const question = asString(body.question);
		if (!question) throw new HttpError(400, "question is required");
		const id = randomUUID();
		await session.connection.startSideQuestion(id, question);
		json(res, 200, { id });
		return true;
	}

	if (method === "POST" && pathname === "/api/side-question-abort") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const id = asString(body.id);
		if (!id) throw new HttpError(400, "id is required");
		await session.connection.abortSideQuestion(id);
		json(res, 200, { ok: true });
		return true;
	}

	if (method === "GET" && pathname === "/api/fs/browse") {
		const rawPath = url.searchParams.get("path");
		const targetPath = rawPath && rawPath.trim().length > 0 ? rawPath.trim() : homedir();
		const target = statSync(targetPath).isDirectory() ? targetPath : homedir();
		const dirents = await readdir(target, { withFileTypes: true });
		const entries = [];
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) continue;
			if (dirent.isSymbolicLink()) {
				const isDir = await stat(join(target, dirent.name))
					.then((info) => info.isDirectory())
					.catch(() => false);
				if (!isDir) continue;
			}
			entries.push({ name: dirent.name, path: join(target, dirent.name) });
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		const parent = dirname(target);
		json(res, 200, {
			path: target,
			home: homedir(),
			parent: parent === target ? null : parent,
			entries,
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/fs/list") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const root = await sessionPool.sessionRoot(session);
		json(res, 200, await listDirectory(root, url.searchParams.get("path") ?? ""));
		return true;
	}

	if (method === "GET" && pathname === "/api/fs/file") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const root = await sessionPool.sessionRoot(session);
		json(res, 200, await readWorkspaceFile(root, url.searchParams.get("path") ?? ""));
		return true;
	}

	if (method === "PUT" && pathname === "/api/fs/file") {
		const body = await readJson(req);
		const session = await await sessionPool.resolveSession(asString(body.sessionId));
		const path = asString(body.path);
		const content = typeof body.content === "string" ? body.content : undefined;
		if (!path || content === undefined) throw new HttpError(400, "path and content are required");
		const root = await sessionPool.sessionRoot(session);
		json(res, 200, await writeWorkspaceFile(root, path, content));
		return true;
	}

	if (method === "POST" && pathname === "/api/terminal/exec") {
		const body = await readJson<{ sessionId?: string; command?: string; timeoutMs?: number }>(req);
		if (!body.command || typeof body.command !== "string") {
			throw new HttpError(400, "Missing required command parameter");
		}
		const session = await sessionPool.resolveSession(body.sessionId ?? undefined);
		const root = await sessionPool.sessionRoot(session);
		const result = await executeTerminalCommand(root, body.command, body.timeoutMs);
		json(res, 200, result);
		return true;
	}

	if (method === "GET" && pathname === "/api/git/diff") {
		const session = await await sessionPool.resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const root = await sessionPool.sessionRoot(session);
		json(res, 200, await gitInfo(root));
		return true;
	}

	return false;
}
