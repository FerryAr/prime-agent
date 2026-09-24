import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type AgentConnection,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	attachSession,
	connectDaemon,
	createDaemonSession,
	listDaemonSessions,
	resumeDaemonSession,
	tryReadSessionCwd,
} from "./daemon.js";
import { HttpError } from "./errors.js";

export const SESSION_IDLE_TTL_MS = 15_000;
export const MAX_SESSION_SUBSCRIBERS = 8;
export const MAX_SESSION_PENDING_PAYLOADS = 256;
export const MAX_SESSION_PENDING_BYTES = 64 * 1024 * 1024;

export interface SessionSubscriber {
	res: ServerResponse;
	ready: boolean;
	closed: boolean;
	pending: string[];
	pendingBytes: number;
}

export interface ApiSession {
	activeSessionId: string;
	connection: AgentConnection;
	subscribers: Set<SessionSubscriber>;
	streamSequence: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	closed: boolean;
	pendingSnapshots: number;
	pendingRequests: number;
	unsubscribe: () => void;
}

export function streamEvent(event: unknown, sequence?: number): string {
	return `${sequence === undefined ? "" : `id: ${sequence}\n`}data: ${JSON.stringify(event)}\n\n`;
}

export function createSessionSubscriber(res: ServerResponse): SessionSubscriber {
	return { res, ready: false, closed: false, pending: [], pendingBytes: 0 };
}

export function writeSessionSubscriber(subscriber: SessionSubscriber, payload: string): void {
	if (subscriber.closed) return;
	if (!subscriber.ready) {
		const bytes = Buffer.byteLength(payload);
		if (
			subscriber.pending.length < MAX_SESSION_PENDING_PAYLOADS &&
			subscriber.pendingBytes + bytes <= MAX_SESSION_PENDING_BYTES
		) {
			subscriber.pending.push(payload);
			subscriber.pendingBytes += bytes;
		} else {
			subscriber.closed = true;
			subscriber.pending = [];
			subscriber.res.destroy();
		}
		return;
	}
	try {
		if (!subscriber.res.write(payload)) {
			subscriber.ready = false;
			subscriber.res.once("drain", () => {
				if (subscriber.closed) return;
				subscriber.ready = true;
				subscriber.pendingBytes = 0;
				for (const item of subscriber.pending.splice(0)) writeSessionSubscriber(subscriber, item);
			});
		}
	} catch {
		subscriber.closed = true;
		subscriber.res.destroy();
	}
}

export function disposeConnection(connection: AgentConnection): void {
	const disposable = connection as AgentConnection & { dispose?: () => Promise<void> };
	if (disposable.dispose) void disposable.dispose().catch(() => undefined);
}

export function pruneMessageForApi(msg: any): any {
	if (!msg || typeof msg !== "object") return msg;
	const m = msg.message ?? msg;
	const clean: Record<string, unknown> = {
		role: m.role,
		timestamp: msg.timestamp ?? m.timestamp,
	};
	if (m.toolCallId) clean.toolCallId = m.toolCallId;
	if (m.toolName) clean.toolName = m.toolName;
	if (m.isError !== undefined) clean.isError = m.isError;
	if (m.details && typeof m.details === "object") {
		const det = m.details;
		const cleanDet: Record<string, unknown> = {};
		if (det.diff) cleanDet.diff = det.diff;
		if (det.diffs) cleanDet.diffs = det.diffs;
		if (det.status) cleanDet.status = det.status;
		if (det.error) cleanDet.error = det.error;
		clean.details = cleanDet;
	}
	if (m.usage) clean.usage = m.usage;

	if (Array.isArray(m.content)) {
		clean.content = m.content.map((p: any) => {
			if (!p || typeof p !== "object") return p;
			if (p.type === "text") {
				let text = typeof p.text === "string" ? p.text : "";
				if (text.length > 12288 && !text.includes("diff --git") && !text.includes("--- a/")) {
					text = text.slice(0, 4096) + `\n\n... [truncated ${text.length - 8192} chars for network performance] ...\n\n` + text.slice(-4096);
				}
				return { type: "text", text };
			}
			if (p.type === "toolCall") {
				return { type: "toolCall", id: p.id, name: p.name, arguments: p.arguments };
			}
			if (p.type === "thinking") {
				return { type: "thinking", thinking: p.thinking };
			}
			return p;
		});
	} else if (typeof m.content === "string") {
		clean.content = m.content;
	}
	return clean;
}

export function findSessionFileInDir(dir: string): string | undefined {
	try {
		let newest: { path: string; mtime: number } | undefined;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const full = join(dir, name);
			try {
				const mtime = statSync(full).mtimeMs;
				if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
			} catch {}
		}
		return newest?.path;
	} catch {
		return undefined;
	}
}

export class ApiSessionPool {
	readonly sessions = new Map<string, ApiSession>();
	readonly requestSessions = new AsyncLocalStorage<Set<ApiSession>>();
	private readonly openingSessions = new Map<string, Promise<ApiSession>>();

	broadcast(session: ApiSession, event: unknown): void {
		const payload = streamEvent(event, ++session.streamSequence);
		for (const subscriber of session.subscribers) writeSessionSubscriber(subscriber, payload);
	}

	closeSessionSubscribers(session: ApiSession): void {
		for (const subscriber of session.subscribers) {
			subscriber.closed = true;
			subscriber.pending = [];
			subscriber.res.destroy();
		}
		session.subscribers.clear();
	}

	closeSession(session: ApiSession): void {
		if (session.closed) return;
		session.closed = true;
		this.cancelSessionIdleEviction(session);
		session.unsubscribe();
		this.closeSessionSubscribers(session);
		if (this.sessions.get(session.activeSessionId) === session) {
			this.sessions.delete(session.activeSessionId);
		}
		disposeConnection(session.connection);
	}

	scheduleSessionIdleEviction(session: ApiSession): void {
		if (
			session.closed ||
			session.subscribers.size > 0 ||
			session.pendingSnapshots > 0 ||
			session.pendingRequests > 0 ||
			session.idleTimer
		) {
			return;
		}
		session.idleTimer = setTimeout(() => {
			session.idleTimer = undefined;
			if (
				session.closed ||
				session.subscribers.size > 0 ||
				session.pendingSnapshots > 0 ||
				session.pendingRequests > 0
			) {
				return;
			}
			if (this.sessions.get(session.activeSessionId) !== session) return;
			this.closeSession(session);
		}, SESSION_IDLE_TTL_MS);
		session.idleTimer.unref?.();
	}

	cancelSessionIdleEviction(session: ApiSession): void {
		if (!session.idleTimer) return;
		clearTimeout(session.idleTimer);
		session.idleTimer = undefined;
	}

	async getSessionSnapshot(
		session: ApiSession,
	): Promise<Awaited<ReturnType<AgentConnection["getInitialSnapshot"]>> & { children?: unknown[] }> {
		this.cancelSessionIdleEviction(session);
		session.pendingSnapshots++;
		try {
			const snapshot = await session.connection.getInitialSnapshot();
			const children =
				typeof session.connection.getRlmChildSnapshots === "function"
					? await session.connection.getRlmChildSnapshots().catch(() => [])
					: [];
			if (snapshot.state?.sessionFile) {
				const recordedCwd = tryReadSessionCwd(snapshot.state.sessionFile);
				if (recordedCwd && snapshot.state.cwd !== recordedCwd) {
					snapshot.state.cwd = recordedCwd;
				}
			}
			if (snapshot.state && !snapshot.state.usage && Array.isArray(snapshot.messages)) {
				let inputTokens = 0;
				let outputTokens = 0;
				let cost = 0;
				for (const msg of snapshot.messages) {
					const u = (msg as any)?.usage;
					if (u) {
						inputTokens += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
						outputTokens += (u.output || 0);
						if (u.cost) {
							cost += typeof u.cost === "number" ? u.cost : (u.cost.total || 0);
						}
					}
				}
				if (inputTokens > 0 || outputTokens > 0 || cost > 0) {
					(snapshot.state as any).usage = { inputTokens, outputTokens, cost };
				}
			}
			// For stream performance and memory safety, cap initial snapshot history to the latest 50 messages
			const rawList = Array.isArray(snapshot.messages)
				? (snapshot.messages.length > 50 ? snapshot.messages.slice(-50) : snapshot.messages)
				: [];
			const prunedMessages = rawList.map(pruneMessageForApi);
			return { ...snapshot, messages: prunedMessages, children };
		} finally {
			session.pendingSnapshots--;
			this.scheduleSessionIdleEviction(session);
		}
	}

	openSession(activeSessionId: string): Promise<ApiSession> {
		const existing = this.sessions.get(activeSessionId);
		if (existing) return Promise.resolve(existing);
		const opening = this.openingSessions.get(activeSessionId);
		if (opening) return opening;

		const promise = (async () => {
			const client = await connectDaemon();
			let connection: AgentConnection;
			try {
				connection = await attachSession(client, activeSessionId);
			} catch (error) {
				client.close();
				throw error;
			}
			const session: ApiSession = {
				activeSessionId,
				connection,
				subscribers: new Set(),
				streamSequence: 0,
				closed: false,
				pendingSnapshots: 0,
				pendingRequests: 0,
				unsubscribe: () => {},
			};
			session.unsubscribe = connection.subscribe((event) => {
				this.broadcast(session, event);
				if (event.type === "closed") this.closeSession(session);
			});
			this.sessions.set(activeSessionId, session);
			return session;
		})();

		this.openingSessions.set(activeSessionId, promise);
		void promise.finally(() => {
			if (this.openingSessions.get(activeSessionId) === promise) {
				this.openingSessions.delete(activeSessionId);
			}
		}).catch(() => undefined);
		return promise;
	}

	requireSession(sessionId: string | undefined): ApiSession {
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		if (!session) throw new HttpError(404, "Unknown session; POST /api/session first");
		const retained = this.requestSessions.getStore();
		if (retained && !retained.has(session)) {
			retained.add(session);
			session.pendingRequests++;
			this.cancelSessionIdleEviction(session);
		}
		return session;
	}

	async openFromBody(body: Record<string, unknown>): Promise<ApiSession> {
		const activeSessionId = typeof body.activeSessionId === "string" && body.activeSessionId.length > 0 ? body.activeSessionId : undefined;
		const sessionPath = typeof body.sessionPath === "string" && body.sessionPath.length > 0 ? body.sessionPath : undefined;
		const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : undefined;

		if (activeSessionId) {
			try {
				return await this.openSession(activeSessionId);
			} catch {
				// Fallback to sessionPath or catalog lookup
			}
		}

		if (sessionPath) {
			const all = await listDaemonSessions();
			const live = all.find((s) => {
				if (!s.workerPid) return false;
				return s.sessionFile === sessionPath || (s.sessionFile && resolve(s.sessionFile) === resolve(sessionPath));
			});
			if (live) {
				try {
					return await this.openSession((live.activeSessionId ?? live.id) as string);
				} catch {}
			}
			const resumed = await resumeDaemonSession(sessionPath, cwd);
			return this.openSession(resumed.activeSessionId);
		}

		if (activeSessionId) {
			const all = await listDaemonSessions();
			const match = all.find(
				(s) => s.activeSessionId === activeSessionId || s.id === activeSessionId || s.sessionId === activeSessionId,
			);
			if (match?.sessionFile) {
				const resumed = await resumeDaemonSession(match.sessionFile, cwd);
				return this.openSession(resumed.activeSessionId);
			}
		}

		if (activeSessionId || sessionPath) {
			throw new HttpError(404, `Session ${activeSessionId ?? sessionPath} could not be found or resumed`);
		}

		const defaultCwd = homedir() || process.cwd();
		const created = await createDaemonSession(cwd ?? defaultCwd);
		return this.openSession(created.activeSessionId);
	}

	async resolveSession(sessionId: string | undefined): Promise<ApiSession> {
		let session = sessionId ? this.sessions.get(sessionId) : undefined;
		if (!session && sessionId) {
			try {
				session = await this.openSession(sessionId);
			} catch {
				try {
					session = await this.openFromBody({ activeSessionId: sessionId });
				} catch {}
			}
		}
		if (!session) throw new HttpError(404, "Unknown session; POST /api/session first");
		const retained = this.requestSessions.getStore();
		if (retained && !retained.has(session)) {
			retained.add(session);
			session.pendingRequests++;
			this.cancelSessionIdleEviction(session);
		}
		return session;
	}

	async sessionRoot(session: ApiSession): Promise<string> {
		const state = await session.connection.getState().catch(() => undefined);
		if (state?.sessionFile) {
			const recorded = tryReadSessionCwd(state.sessionFile);
			if (recorded) return recorded;
		}
		return state?.cwd || process.cwd();
	}

			async serveEvents(res: ServerResponse, url: URL): Promise<void> {
		const sessionId = url.searchParams.get("sessionId") ?? undefined;
		let session = this.sessions.get(sessionId ?? "");
		if (!session && sessionId) {
			try {
				session = await this.openSession(sessionId);
			} catch {
				try {
					session = await this.openFromBody({ activeSessionId: sessionId });
				} catch {}
			}
		}
		if (!session) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("Unknown session\n");
			return;
		}

		this.cancelSessionIdleEviction(session);

		// Clean up dead subscribers
		for (const sub of [...session.subscribers]) {
			if (sub.closed || sub.res.destroyed || sub.res.writableEnded) {
				sub.closed = true;
				session.subscribers.delete(sub);
			}
		}

		if (session.subscribers.size >= MAX_SESSION_SUBSCRIBERS) {
			// Evict oldest
			const oldest = session.subscribers.values().next().value;
			if (oldest) {
				oldest.closed = true;
				try { oldest.res.destroy(); } catch {}
				session.subscribers.delete(oldest);
			}
		}

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.flushHeaders?.();

		const subscriber = createSessionSubscriber(res);
		session.subscribers.add(subscriber);

		const unsubscribe = () => {
			subscriber.closed = true;
			subscriber.pending = [];
			if (session?.subscribers.delete(subscriber)) this.scheduleSessionIdleEviction(session);
		};
		res.on("close", unsubscribe);

		const connectedPayload = streamEvent({ type: "connected", sessionId: session.activeSessionId });
		try {
			const snapshot = await this.getSessionSnapshot(session);
			if (subscriber.closed) return;
			const snapshotPayload = streamEvent(
				{ type: "snapshot", sessionId: session.activeSessionId, snapshot },
				session.streamSequence,
			);
			subscriber.ready = true;
			subscriber.pendingBytes = 0;
			const initialBatch = [connectedPayload, snapshotPayload, ...subscriber.pending.splice(0)];
			for (const payload of initialBatch) writeSessionSubscriber(subscriber, payload);
		} catch (error) {
			unsubscribe();
			if (!res.writableEnded) res.end();
			return;
		}

		if (subscriber.closed || res.destroyed) return;
		const heartbeat = setInterval(() => {
			if (subscriber.ready && !res.destroyed && !res.writableEnded) {
				writeSessionSubscriber(subscriber, ": ping\n\n");
				writeSessionSubscriber(subscriber, streamEvent({ type: "heartbeat", timestamp: Date.now() }));
			} else {
				clearInterval(heartbeat);
			}
		}, 15_000);
		res.on("close", () => clearInterval(heartbeat));
	}
}
