import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentConnection,
	type AgentConnectionExtensionUiResponse,
	getAgentDir,
	SessionManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { isAllowedOrigin, isLoopbackOrigin, requestToken, tokensMatch } from "./auth.js";
import {
	attachSession,
	connectDaemon,
	createDaemonSession,
	deleteSavedSessionFile,
	killDaemonSession,
	listDaemonSessions,
	resumeDaemonSession,
	resumeSessionQueue,
	tryReadSessionCwd,
} from "./daemon.js";
import { errorStatus, HttpError } from "./errors.js";
import { gitInfo, listDirectory, readWorkspaceFile, writeWorkspaceFile } from "./fs.js";
import { PasswordGate, SESSION_COOKIE } from "./password.js";
import { RosterHub } from "./roster.js";

function flagValue(name: string): string | undefined {
	const argv = process.argv.slice(2);
	const index = argv.indexOf(`--${name}`);
	if (index !== -1) return argv[index + 1];
	const inline = argv.find((a) => a.startsWith(`--${name}=`));
	return inline ? inline.slice(name.length + 3) : undefined;
}

const HOST = flagValue("host") ?? process.env.PRIME_AGENT_WEB_HOST ?? "0.0.0.0";
const PORT = Number(flagValue("port") ?? process.env.PRIME_AGENT_WEB_PORT ?? 4677);
const AUTH_MODE = process.env.PRIME_AGENT_WEB_AUTH === "token" ? "token" : "password";
const TOKEN = process.env.PRIME_AGENT_WEB_TOKEN ?? randomBytes(24).toString("base64url");
const DATA_DIR = process.env.PRIME_AGENT_WEB_DATA_DIR ?? join(getAgentDir(), "prime-agent-web");
mkdirSync(DATA_DIR, { recursive: true });
const STATIC_DIR = (() => {
	const localStatic = join(dirname(fileURLToPath(import.meta.url)), "static");
	if (existsSync(localStatic)) return localStatic;
	const srcStatic = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "static");
	if (existsSync(srcStatic)) return srcStatic;
	return localStatic;
})();

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DELIVERY_MODES = new Set(["steer", "follow_up"]);
const HEARTBEAT_ACTIONS = new Set(["pause", "resume", "stop"]);
const FORK_POSITIONS = new Set(["before", "at"]);

interface SessionSubscriber {
	res: ServerResponse;
	ready: boolean;
	closed: boolean;
	pending: string[];
	pendingBytes: number;
}

interface WebSession {
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

const sessions = new Map<string, WebSession>();
const requestSessions = new AsyncLocalStorage<Set<WebSession>>();
const SESSION_IDLE_TTL_MS = 15_000;
const MAX_SESSION_SUBSCRIBERS = 4;
const MAX_SESSION_PENDING_PAYLOADS = 256;
const MAX_SESSION_PENDING_BYTES = 2 * 1024 * 1024;
const rosterHub = new RosterHub();
const gate = AUTH_MODE === "password" ? new PasswordGate(DATA_DIR, process.env.PRIME_AGENT_WEB_PASSWORD) : undefined;

if (gate?.generatedPassword) {
	const credentialsPath = join(DATA_DIR, "prime-agent-web-password.txt");
	writeFileSync(credentialsPath, `${gate.generatedPassword}\n`, { mode: 0o600 });
	console.log(`Prime Agent web: generated password: ${gate.generatedPassword}`);
	console.log(`Prime Agent web: (also saved to ${credentialsPath})`);
}

const STATIC_ROUTES: Record<string, { file: string; type: string }> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
	"/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
	"/sounds/agent-done.mp3": { file: "sounds/agent-done.mp3", type: "audio/mpeg" },
	"/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

function cookieValue(req: IncomingMessage, name: string): string | undefined {
	const header = req.headers.cookie;
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

function streamEvent(event: unknown, sequence?: number): string {
	return `${sequence === undefined ? "" : `id: ${sequence}\n`}data: ${JSON.stringify(event)}\n\n`;
}

function createSessionSubscriber(res: ServerResponse): SessionSubscriber {
	return { res, ready: false, closed: false, pending: [], pendingBytes: 0 };
}

function writeSessionSubscriber(subscriber: SessionSubscriber, payload: string): void {
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

function broadcast(session: WebSession, event: unknown): void {
	const payload = streamEvent(event, ++session.streamSequence);
	for (const subscriber of session.subscribers) writeSessionSubscriber(subscriber, payload);
}

function closeSessionSubscribers(session: WebSession): void {
	for (const subscriber of session.subscribers) {
		subscriber.closed = true;
		subscriber.pending = [];
		subscriber.res.destroy();
	}
	session.subscribers.clear();
}

function closeWebSession(session: WebSession): void {
	if (session.closed) return;
	session.closed = true;
	cancelSessionIdleEviction(session);
	session.unsubscribe();
	closeSessionSubscribers(session);
	if (sessions.get(session.activeSessionId) === session) sessions.delete(session.activeSessionId);
	disposeConnection(session.connection);
}

function scheduleSessionIdleEviction(session: WebSession): void {
	if (session.closed || session.subscribers.size > 0 || session.pendingSnapshots > 0 || session.pendingRequests > 0 || session.idleTimer) return;
	session.idleTimer = setTimeout(() => {
		session.idleTimer = undefined;
		if (session.closed || session.subscribers.size > 0 || session.pendingSnapshots > 0 || session.pendingRequests > 0) return;
		if (sessions.get(session.activeSessionId) !== session) return;
		closeWebSession(session);
	}, SESSION_IDLE_TTL_MS);
	session.idleTimer.unref?.();
}

function cancelSessionIdleEviction(session: WebSession): void {
	if (!session.idleTimer) return;
	clearTimeout(session.idleTimer);
	session.idleTimer = undefined;
}

function disposeConnection(connection: AgentConnection): void {
	const disposable = connection as AgentConnection & { dispose?: () => Promise<void> };
	if (disposable.dispose) void disposable.dispose().catch(() => undefined);
}

async function getSessionSnapshot(
	session: WebSession,
): Promise<Awaited<ReturnType<AgentConnection["getInitialSnapshot"]>> & { children?: unknown[] }> {
	cancelSessionIdleEviction(session);
	session.pendingSnapshots++;
	try {
		const snapshot = await session.connection.getInitialSnapshot();
		const children = typeof session.connection.getRlmChildSnapshots === "function" ? await session.connection.getRlmChildSnapshots().catch(() => []) : [];
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
		return { ...snapshot, children };
	} finally {
		session.pendingSnapshots--;
		scheduleSessionIdleEviction(session);
	}
}

const openingSessions = new Map<string, Promise<WebSession>>();

function openSession(activeSessionId: string): Promise<WebSession> {
	const existing = sessions.get(activeSessionId);
	if (existing) return Promise.resolve(existing);
	const opening = openingSessions.get(activeSessionId);
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
		const session: WebSession = {
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
			broadcast(session, event);
			if (event.type === "closed") closeWebSession(session);
		});
		sessions.set(activeSessionId, session);
		return session;
	})();
	openingSessions.set(activeSessionId, promise);
	void promise.finally(() => {
		if (openingSessions.get(activeSessionId) === promise) openingSessions.delete(activeSessionId);
	}).catch(() => undefined);
	return promise;
}

function requireSession(sessionId: string | undefined): WebSession {
	const session = sessionId ? sessions.get(sessionId) : undefined;
	if (!session) throw new HttpError(404, "Unknown session; POST /api/session first");
	const retained = requestSessions.getStore();
	if (retained && !retained.has(session)) {
		retained.add(session);
		session.pendingRequests++;
		cancelSessionIdleEviction(session);
	}
	return session;
}

function findSessionFileInDir(dir: string): string | undefined {
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

async function openFromBody(body: Record<string, unknown>): Promise<WebSession> {
	const activeSessionId = asString(body.activeSessionId);
	const sessionPath = asString(body.sessionPath);

	if (activeSessionId) {
		try {
			return await openSession(activeSessionId);
		} catch {
			// Attaching to activeSessionId failed (e.g. worker terminated or stale ID).
			// Proceed to fallback by sessionPath or catalog lookup.
		}
	}

	if (sessionPath) {
		// If a worker already runs this transcript, attach to it instead of
		// spawning a duplicate worker for the same file.
		const all = await listDaemonSessions();
		const live = all.find((s) => {
			if (!s.workerPid) return false;
			return s.sessionFile === sessionPath || (s.sessionFile && resolve(s.sessionFile) === resolve(sessionPath));
		});
		if (live) {
			try {
				return await openSession((live.activeSessionId ?? live.id) as string);
			} catch {}
		}
		const resumed = await resumeDaemonSession(sessionPath, asString(body.cwd));
		return openSession(resumed.activeSessionId);
	}

	if (activeSessionId) {
		const all = await listDaemonSessions();
		const match = all.find(
			(s) => s.activeSessionId === activeSessionId || s.id === activeSessionId || s.sessionId === activeSessionId,
		);
		if (match?.sessionFile) {
			const resumed = await resumeDaemonSession(match.sessionFile, asString(body.cwd));
			return openSession(resumed.activeSessionId);
		}
	}

	// CRITICAL GUARD: If the client requested an existing session by ID or path,
	// do NOT silently create a brand new session in process.cwd().
	// Fail cleanly with 404 so the client can retry until the worker/catalog is ready,
	// preventing accidental session jumping to prime-agent.
	if (activeSessionId || sessionPath) {
		throw new HttpError(404, `Session ${activeSessionId ?? sessionPath} could not be found or resumed`);
	}

	const defaultCwd = homedir() || process.cwd();
	const created = await createDaemonSession(asString(body.cwd) ?? defaultCwd);
	return openSession(created.activeSessionId);
}

async function resolveSession(sessionId: string | undefined): Promise<WebSession> {
	let session = sessionId ? sessions.get(sessionId) : undefined;
	if (!session && sessionId) {
		try {
			session = await openSession(sessionId);
		} catch {
			try {
				session = await openFromBody({ activeSessionId: sessionId });
			} catch {}
		}
	}
	if (!session) throw new HttpError(404, "Unknown session; POST /api/session first");
	const retained = requestSessions.getStore();
	if (retained && !retained.has(session)) {
		retained.add(session);
		session.pendingRequests++;
		cancelSessionIdleEviction(session);
	}
	return session;
}

function dialogResponse(body: Record<string, unknown>): AgentConnectionExtensionUiResponse | undefined {
	if (body.cancelled === true) return { cancelled: true };
	if (typeof body.value === "string") return { value: body.value };
	if (typeof body.confirmed === "boolean") return { confirmed: body.confirmed };
	return undefined;
}

async function serveEvents(res: ServerResponse, url: URL): Promise<void> {
	const sessionId = url.searchParams.get("sessionId") ?? undefined;
	let session = sessions.get(sessionId ?? "");
	if (!session && sessionId) {
		try {
			session = await openSession(sessionId);
		} catch {
			try {
				session = await openFromBody({ activeSessionId: sessionId });
			} catch {}
		}
	}
	if (!session) throw new HttpError(404, "Unknown session; POST /api/session first");
	if (session.subscribers.size >= MAX_SESSION_SUBSCRIBERS) {
		throw new HttpError(429, "Too many browser connections for this session");
	}
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	cancelSessionIdleEviction(session);
	const subscriber = createSessionSubscriber(res);
	session.subscribers.add(subscriber);
	const unsubscribe = () => {
		subscriber.closed = true;
		subscriber.pending = [];
		if (session.subscribers.delete(subscriber)) scheduleSessionIdleEviction(session);
	};
	res.on("close", unsubscribe);
	const connectedPayload = streamEvent({ type: "connected", sessionId: session.activeSessionId });
	try {
		const snapshot = await getSessionSnapshot(session);
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
		throw error;
	}
	if (subscriber.closed || res.destroyed) return;
	const heartbeat = setInterval(() => {
		if (subscriber.ready) {
			writeSessionSubscriber(subscriber, ": ping\n\n");
			writeSessionSubscriber(subscriber, streamEvent({ type: "heartbeat", timestamp: Date.now() }));
		}
	}, 15_000);
	res.on("close", () => clearInterval(heartbeat));
}

async function sessionRoot(session: WebSession): Promise<string> {
	const state = await session.connection.getState();
	if (state.sessionFile) {
		const recordedCwd = tryReadSessionCwd(state.sessionFile);
		if (recordedCwd) return recordedCwd;
	}
	return state.cwd || process.cwd();
}

async function serveRosterEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	const unsubscribe = await rosterHub.subscribe(res);
	if (res.destroyed || res.writableEnded) {
		unsubscribe();
		return;
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
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const method = req.method ?? "GET";
	const pathname = url.pathname;

	if (method === "GET" && pathname === "/api/meta") {
		json(res, 200, { cwd: process.cwd(), home: homedir(), authMode: AUTH_MODE, version: VERSION });
		return;
	}
	if (method === "POST" && pathname === "/api/logout") {
		gate?.logout(cookieValue(req, SESSION_COOKIE));
		res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
		json(res, 200, { ok: true });
		return;
	}
	if (method === "POST" && pathname === "/api/change-password") {
		if (!gate) throw new HttpError(400, "Password auth is disabled");
		const body = await readJson(req);
		const currentPassword = asString(body.currentPassword);
		const newPassword = asString(body.newPassword);
		if (!currentPassword || !newPassword) {
			throw new HttpError(400, "Current password and new password are required");
		}
		if (newPassword.length < 4) {
			throw new HttpError(400, "New password must be at least 4 characters");
		}
		const ok = gate.changePassword(currentPassword, newPassword);
		if (!ok) {
			throw new HttpError(401, "Current password is incorrect");
		}
		const credentialsPath = join(DATA_DIR, "prime-agent-web-password.txt");
		try {
			writeFileSync(credentialsPath, `${newPassword}\n`, { mode: 0o600 });
		} catch {}
		json(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && pathname === "/api/sessions") {
		json(res, 200, { sessions: await listDaemonSessions() });
		return;
	}
	if (method === "POST" && pathname === "/api/session") {
		const session = await openFromBody(await readJson(req));
		const snapshot = await getSessionSnapshot(session);
		json(res, 200, { activeSessionId: session.activeSessionId, streamSequence: session.streamSequence, ...snapshot });
		return;
	}
	if (method === "GET" && pathname === "/api/state") {
		const session = await resolveSession(url.searchParams.get("sessionId") ?? undefined);
		const snapshot = await getSessionSnapshot(session);
		json(res, 200, { activeSessionId: session.activeSessionId, streamSequence: session.streamSequence, ...snapshot });
		return;
	}
	if (method === "GET" && pathname === "/events") {
		await serveEvents(res, url);
		return;
	}
	if (method === "GET" && pathname === "/events/roster") {
		await serveRosterEvents(req, res);
		return;
	}
	if (method === "DELETE" && pathname === "/api/session") {
		const sessionId = url.searchParams.get("sessionId");
		if (!sessionId) throw new HttpError(400, "sessionId is required");
		const live = sessions.get(sessionId);
		let sessionFile: string | undefined;
		if (live) {
			sessionFile = (await live.connection.getState().catch(() => undefined))?.sessionFile;
			closeWebSession(live);
		}
		try {
			await killDaemonSession(sessionId);
		} catch {
			// already stopped — the transcript may still exist
		}
		if (!sessionFile) {
			const all = await listDaemonSessions();
			sessionFile = all.find((s) => s.sessionId === sessionId || s.id === sessionId)?.sessionFile;
		}
		if (sessionFile) {
			await deleteSavedSessionFile(sessionFile).catch((error) => {
				process.stderr.write(
					`prime-agent-web: could not delete transcript: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			});
		}
		json(res, 200, { ok: true });
		return;
	}

	if (method === "POST" && pathname === "/api/prompt") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const message = asString(body.message);
		if (!message) throw new HttpError(400, "message is required");
		const streamingBehavior = asString(body.streamingBehavior);
		const promptOptions: Parameters<AgentConnection["prompt"]>[1] = {
			...(streamingBehavior === "steer" || streamingBehavior === "followUp" ? { streamingBehavior } : {}),
			queueIfBusy: true,
		};
		try {
			await session.connection.prompt(message, promptOptions);
		} catch (error) {
			// A cancel from the TUI suspends the session's input pump; web prompts
			// are rejected until it resumes. Clear it and retry once.
			const messageText = error instanceof Error ? error.message : String(error);
			if (!/not accepted by the session|input is suspended/i.test(messageText)) throw error;
			await resumeSessionQueue(session.activeSessionId);
			await session.connection.prompt(message, promptOptions);
		}
		json(res, 200, { ok: true });
		return;
	}
	if (method === "POST" && pathname === "/api/steer") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const message = asString(body.message);
		if (!message) throw new HttpError(400, "message is required");
		await session.connection.steer(message);
		json(res, 200, { ok: true });
		return;
	}
	if (method === "POST" && pathname === "/api/abort") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		await session.connection.abort();
		json(res, 200, { ok: true });
		return;
	}
	if (method === "POST" && pathname === "/api/dialog") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const id = asString(body.id);
		const response = dialogResponse(body);
		if (!id || !response) throw new HttpError(400, "id plus value/confirmed/cancelled is required");
		await session.connection.respondToExtensionUiRequest(id, response);
		json(res, 200, { ok: true });
		return;
	}
	if (method === "GET" && pathname === "/api/models") {
		const session = requireSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { models: await session.connection.getAvailableModels() });
		return;
	}
	if (method === "POST" && pathname === "/api/model") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const provider = asString(body.provider);
		const modelId = asString(body.modelId);
		if (!provider || !modelId) throw new HttpError(400, "provider and modelId are required");
		await session.connection.setModel(provider, modelId);
		const state = await session.connection.getState();
		json(res, 200, { ok: true, state });
		return;
	}
	if (method === "POST" && pathname === "/api/thinking") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const level = asString(body.level);
		if (!level || !THINKING_LEVELS.has(level)) throw new HttpError(400, "invalid thinking level");
		await session.connection.setThinkingLevel(level as Parameters<AgentConnection["setThinkingLevel"]>[0]);
		const state = await session.connection.getState();
		json(res, 200, { ok: true, state });
		return;
	}

	if (method === "GET" && pathname === "/api/commands") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { commands: await session.connection.getCommands() });
		return;
	}
	if (method === "POST" && pathname === "/api/reload") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		await session.connection.reload?.();
		const state = await session.connection.getState();
		json(res, 200, { ok: true, state, commands: await session.connection.getCommands() });
		return;
	}

	if (method === "POST" && pathname === "/api/export") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const path = await session.connection.exportToHtml(asString(body.outputPath));
		json(res, 200, { path });
		return;
	}
	if (method === "POST" && pathname === "/api/session-name") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const name = asString(body.name) ?? "";
		await session.connection.setSessionName(name);
		json(res, 200, { ok: true, name });
		return;
	}
	if (method === "POST" && pathname === "/api/new") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const result = await session.connection.newSession();
		const [state, messages] = await Promise.all([session.connection.getState(), session.connection.getMessages()]);
		json(res, 200, { ...result, state, messages });
		return;
	}

	if (method === "POST" && pathname === "/api/compact") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const result = await session.connection.compact(asString(body.instructions));
		json(res, 200, result);
		return;
	}
	if (method === "POST" && pathname === "/api/refine") {
		const body = await readJson(req);
		const session = requireSession(asString(body.sessionId));
		const result = await session.connection.refine({
			instructions: asString(body.instructions),
			rollbackId: asString(body.rollbackId),
			global: asBoolean(body.global),
		});
		json(res, 200, result);
		return;
	}
	if (method === "POST" && pathname === "/api/auto-compact") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		await session.connection.setAutoCompactionEnabled(asBoolean(body.enabled) ?? true);
		json(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && pathname === "/api/subagent-messages") {
		const sessionId = url.searchParams.get("sessionId");
		const childId = url.searchParams.get("childId");
		if (!sessionId) throw new HttpError(400, "sessionId is required");
		if (!childId) throw new HttpError(400, "childId is required");
		const session = await resolveSession(sessionId);

		const children = typeof session.connection.getRlmChildSnapshots === "function"
			? await session.connection.getRlmChildSnapshots().catch(() => [])
			: [];
		const child = children.find(
			(c) => c.id === childId || c.sessionName === childId || c.activeSessionId === childId || (c.sessionDir && c.sessionDir.includes(childId))
		);

		let messages: unknown[] = [];

		// 1. Try watching live session if child is active and has an activeSessionId
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

		// 2. Fall back to reading the subagent's session transcript from disk
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
						const sm = SessionManager.open(sessionFile);
						const context = sm.buildSessionContext();
						messages = context.messages;
					} catch (err) {
						process.stderr.write(`Could not load subagent session: ${err}\n`);
					}
				}
			}
		}

		json(res, 200, { messages, child: child ?? null });
		return;
	}

	if (method === "GET" && pathname === "/api/fork-messages") {
		const session = await resolveSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { messages: await session.connection.getUserMessagesForForking() });
		return;
	}
	if (method === "POST" && pathname === "/api/fork") {
		const body = await readJson(req);
		const session = await resolveSession(asString(body.sessionId));
		const entryId = asString(body.entryId);
		const position = asString(body.position) ?? "before";
		if (!entryId) throw new HttpError(400, "entryId is required");
		if (!FORK_POSITIONS.has(position)) throw new HttpError(400, "invalid position");
		const result = await session.connection.fork(entryId, { position: position as "before" | "at" });
		const [state, messages] = await Promise.all([session.connection.getState(), session.connection.getMessages()]);
		json(res, 200, { ...result, state, messages, activeSessionId: session.activeSessionId });
		return;
	}
	if (method === "POST" && pathname === "/api/clone") {
		const body = await readJson(req);
		const session = await resolveSession(asString(body.sessionId));
		const { leafId } = await session.connection.getSessionTree();
		if (!leafId) throw new HttpError(400, "Nothing to clone yet");
		const result = await session.connection.fork(leafId, { position: "at" });
		const [state, messages] = await Promise.all([session.connection.getState(), session.connection.getMessages()]);
		json(res, 200, { ...result, state, messages, activeSessionId: session.activeSessionId });
		return;
	}

	if (method === "GET" && pathname === "/api/cron") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		const includeInactive = url.searchParams.get("includeInactive") === "1";
		json(res, 200, { jobs: await session.connection.listCronJobs({ includeInactive }) });
		return;
	}
	if (method === "POST" && pathname === "/api/cron") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const schedule = asString(body.schedule);
		const prompt = asString(body.prompt);
		if (!schedule || !prompt) throw new HttpError(400, "schedule and prompt are required");
		const job = await session.connection.addCronJob(schedule, prompt);
		json(res, 200, { job });
		return;
	}
	if (method === "DELETE" && pathname === "/api/cron") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		const jobId = url.searchParams.get("jobId");
		if (!jobId) throw new HttpError(400, "jobId is required");
		await session.connection.cancelCronJob(jobId);
		json(res, 200, { ok: true });
		return;
	}
	if (method === "GET" && pathname === "/api/heartbeats") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		json(res, 200, { heartbeats: await session.connection.listHeartbeats() });
		return;
	}
	if (method === "POST" && pathname === "/api/heartbeat") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
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
		return;
	}
	if (method === "POST" && pathname === "/api/heartbeat-action") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const jobId = asString(body.jobId);
		const action = asString(body.action);
		if (!jobId || !action || !HEARTBEAT_ACTIONS.has(action)) {
			throw new HttpError(400, "jobId and a valid action (pause/resume/stop) are required");
		}
		const job = await session.connection.manageHeartbeat(
			session.activeSessionId,
			jobId,
			action as "pause" | "resume" | "stop",
		);
		json(res, 200, { job });
		return;
	}
	if (method === "POST" && pathname === "/api/side-question") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const question = asString(body.question);
		if (!question) throw new HttpError(400, "question is required");
		const id = randomUUID();
		await session.connection.startSideQuestion(id, question);
		json(res, 200, { id });
		return;
	}
	if (method === "POST" && pathname === "/api/side-question-abort") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const id = asString(body.id);
		if (!id) throw new HttpError(400, "id is required");
		await session.connection.abortSideQuestion(id);
		json(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && pathname === "/api/fs/browse") {
		const rawPath = url.searchParams.get("path");
		const targetPath = rawPath && rawPath.trim().length > 0 ? rawPath.trim() : homedir();
		const target = realpathSync(targetPath);
		if (!statSync(target).isDirectory()) throw new HttpError(400, "Not a directory");
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
		return;
	}

	if (method === "GET" && pathname === "/api/fs/list") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		const root = await sessionRoot(session);
		json(res, 200, await listDirectory(root, url.searchParams.get("path") ?? ""));
		return;
	}
	if (method === "GET" && pathname === "/api/fs/file") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		const root = await sessionRoot(session);
		json(res, 200, await readWorkspaceFile(root, url.searchParams.get("path") ?? ""));
		return;
	}
	if (method === "PUT" && pathname === "/api/fs/file") {
		const body = await readJson(req);
		const session = await requireSession(asString(body.sessionId));
		const path = asString(body.path);
		const content = typeof body.content === "string" ? body.content : undefined;
		if (!path || content === undefined) throw new HttpError(400, "path and content are required");
		const root = await sessionRoot(session);
		json(res, 200, await writeWorkspaceFile(root, path, content));
		return;
	}
	if (method === "GET" && pathname === "/api/git/diff") {
		const session = await requireSession(url.searchParams.get("sessionId") ?? undefined);
		const root = await sessionRoot(session);
		json(res, 200, await gitInfo(root));
		return;
	}

	throw new HttpError(404, `No route: ${method} ${pathname}`);
}

function authenticate(req: IncomingMessage, url: URL): void {
	if (AUTH_MODE === "token") {
		const headerToken = req.headers["x-prime-agent-token"];
		const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
		if (!tokensMatch(TOKEN, requestToken(url, provided) ?? "")) {
			throw new HttpError(401, "Missing or invalid token");
		}
		return;
	}
	if (!gate?.resolveLogin(cookieValue(req, SESSION_COOKIE))) {
		throw new HttpError(401, "Not signed in");
	}
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!gate) throw new HttpError(400, "Password auth is disabled");
	const ip = req.socket.remoteAddress ?? "unknown";
	const lockedFor = gate.lockedForMs(ip);
	if (lockedFor > 0) {
		res.setHeader("retry-after", Math.ceil(lockedFor / 1000).toString());
		throw new HttpError(429, `Too many failed attempts — try again in ${Math.ceil(lockedFor / 1000)}s`);
	}
	const body = await readJson(req);
	const password = asString(body.password);
	if (!password) throw new HttpError(400, "password is required");
	if (!gate.verify(password)) {
		gate.recordFailure(ip);
		const remainingLock = gate.lockedForMs(ip);
		if (remainingLock > 0) {
			res.setHeader("retry-after", Math.ceil(remainingLock / 1000).toString());
			throw new HttpError(429, `Too many failed attempts — try again in ${Math.ceil(remainingLock / 1000)}s`);
		}
		throw new HttpError(401, "Invalid password");
	}
	gate.recordSuccess(ip);
	const token = gate.createLogin();
	res.setHeader(
		"set-cookie",
		`${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${365 * 24 * 3600}`,
	);
	json(res, 200, { ok: true });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
	try {
		const staticRoute = req.method === "GET" ? STATIC_ROUTES[url.pathname] : undefined;
		if (staticRoute) {
			res.writeHead(200, { "content-type": staticRoute.type, "cache-control": "no-store" });
			res.end(await readFile(join(STATIC_DIR, staticRoute.file)));
			return;
		}
		if (url.pathname.startsWith("/api/") && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
			json(res, 403, { message: "Cross-origin requests are not allowed" });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/login") {
			await handleLogin(req, res);
			return;
		}
		authenticate(req, url);
		await requestSessions.run(new Set<WebSession>(), async () => {
			try {
				await route(req, res, url);
			} finally {
				for (const session of requestSessions.getStore() ?? []) {
					session.pendingRequests--;
					scheduleSessionIdleEviction(session);
				}
			}
		});
	} catch (error) {
		const status = errorStatus(error);
		const message = error instanceof Error ? error.message : String(error);
		if (res.headersSent) res.destroy();
		else json(res, status, { message, ...(status === 401 ? { auth: AUTH_MODE } : {}) });
	}
}

const server = createServer((req, res) => {
	void handle(req, res).catch(() => undefined);
});

server.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EADDRINUSE") {
		console.log(`Prime Agent web: port ${PORT} already in use; reusing existing gateway.`);
		process.exit(0);
	}
	throw error;
});

const gatewayInfoPath = join(DATA_DIR, "gateway.json");

const cleanupGatewayInfo = () => {
	try {
		rmSync(gatewayInfoPath, { force: true });
	} catch {}
	try {
		server.closeAllConnections?.();
		server.close();
	} catch {}
	process.exit(0);
};

process.on("SIGTERM", cleanupGatewayInfo);
process.on("SIGINT", cleanupGatewayInfo);

const EXPOSED = HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1";

function lanAddresses(): string[] {
	const result: string[] = [];
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) result.push(address.address);
		}
	}
	return result;
}

server.listen(PORT, HOST, () => {
	const lanList = lanAddresses();
	const shown = lanList.length > 0 ? ["127.0.0.1", ...lanList] : [HOST === "0.0.0.0" ? "127.0.0.1" : HOST];
	const scheme = AUTH_MODE === "token" ? `?token=${TOKEN}` : "";
	const primaryHost = HOST === "0.0.0.0" ? (lanList[0] || "127.0.0.1") : HOST;
	const url = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}${scheme}`;
	try {
		writeFileSync(
			gatewayInfoPath,
			JSON.stringify(
				{
					pid: process.pid,
					host: HOST,
					port: PORT,
					url,
					authMode: AUTH_MODE,
					startedAt: new Date().toISOString(),
				},
				null,
				2,
			),
		);
	} catch {}
	for (const address of shown) {
		console.log(`Prime Agent web: http://${address}:${PORT}/${scheme}`);
	}
	if (EXPOSED && AUTH_MODE !== "token") {
		console.log("Prime Agent web: exposed beyond loopback — password auth required");
	}
});
