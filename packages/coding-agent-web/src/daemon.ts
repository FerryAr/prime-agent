import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentConnection,
	DAEMON_PROTOCOL_NAME,
	DaemonAgentConnection,
	DaemonClient,
	defaultDaemonSocketPath,
	getAgentDir,
	type SessionSummary,
} from "@earendil-works/pi-coding-agent";

const CONNECT_TIMEOUT_MS = 3_000;
const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 300;

const webSrcDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(webSrcDir, "..", "..");
const repoRoot = join(packagesDir, "..");

function cliEntrypoint(): string {
	return join(packagesDir, "coding-agent", "dist", "cli.js");
}

function sourceCliEntrypoint(): string {
	return join(packagesDir, "coding-agent", "src", "cli.ts");
}

function tsxCli(): string {
	return join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
}

let daemonSpawned = false;

function spawnDaemon(): void {
	if (daemonSpawned) return;
	daemonSpawned = true;
	const distCli = cliEntrypoint();
	const args = existsSync(distCli)
		? [distCli, "--mode", "daemon"]
		: [tsxCli(), sourceCliEntrypoint(), "--mode", "daemon"];
	const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
	child.unref();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryConnect(socketPath: string): Promise<DaemonClient | undefined> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(CONNECT_TIMEOUT_MS);
		const hello = await client.waitForHello(CONNECT_TIMEOUT_MS);
		if (hello.protocol.name !== DAEMON_PROTOCOL_NAME) {
			process.stderr.write(`prime-agent-web: unexpected daemon protocol ${hello.protocol.name}\n`);
			client.close();
			return undefined;
		}
		return client;
	} catch {
		client.close();
		return undefined;
	}
}

/** Connect to the shared daemon, spawning one from source/dist when absent. */
export async function connectDaemon(): Promise<DaemonClient> {
	const socketPath = process.env.PRIME_AGENT_WEB_DAEMON_SOCKET || defaultDaemonSocketPath();
	const existing = await tryConnect(socketPath);
	if (existing) return existing;
	spawnDaemon();
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await delay(POLL_INTERVAL_MS);
		const client = await tryConnect(socketPath);
		if (client) return client;
	}
	throw new Error(`Prime Agent daemon did not become ready on ${socketPath}`);
}

export async function attachSession(client: DaemonClient, activeSessionId: string): Promise<AgentConnection> {
	return DaemonAgentConnection.attach(client, activeSessionId, {
		closeClientOnDispose: true,
		supportsExtensionUi: true,
		sendClientEnv: false,
		recoverDaemon: async () => {
			const recoveredClient = await connectDaemon();
			recoveredClient.close();
		},
	});
}

export async function createDaemonSession(cwd: string): Promise<{ activeSessionId: string }> {
	const client = await connectDaemon();
	try {
		const response = await client.request({
			type: "create",
			config: { cwd, agentDir: getAgentDir(), telemetryDisabled: true },
			lifecycle: "resident",
		});
		if (!response.success) throw new Error(response.error);
		const data = response.data as { activeSessionId?: string; id?: string } | undefined;
		const activeSessionId = data?.activeSessionId ?? data?.id;
		if (!activeSessionId) throw new Error("The daemon returned no active session id");
		return { activeSessionId };
	} finally {
		client.close();
	}
}

export function tryReadSessionCwd(sessionPath: string): string | undefined {
	try {
		if (!existsSync(sessionPath)) return undefined;
		const fd = openSync(sessionPath, "r");
		try {
			const buffer = Buffer.alloc(4096);
			const bytesRead = readSync(fd, buffer, 0, 4096, 0);
			const text = buffer.subarray(0, bytesRead).toString("utf8");
			const firstLine = text.split("\n")[0];
			if (!firstLine) return undefined;
			const parsed = JSON.parse(firstLine);
			if (typeof parsed?.cwd === "string" && parsed.cwd.trim()) {
				return resolve(parsed.cwd.trim());
			}
		} finally {
			closeSync(fd);
		}
	} catch {}
	return undefined;
}

/** Resume a saved (cold) session from its transcript file — spins up a resident worker. */
export async function resumeDaemonSession(sessionPath: string, cwd?: string): Promise<{ activeSessionId: string }> {
	const resolvedCwd = cwd || tryReadSessionCwd(sessionPath);
	const client = await connectDaemon();
	try {
		const response = await client.request({
			type: "create",
			sessionPath,
			config: { ...(resolvedCwd ? { cwd: resolvedCwd } : {}), agentDir: getAgentDir(), telemetryDisabled: true },
			lifecycle: "resident",
		});
		if (!response.success) {
			const errInfo = response.errorInfo as { code?: string; activeSessionId?: string } | undefined;
			if (errInfo?.code === "session_already_active" && errInfo.activeSessionId) {
				return { activeSessionId: errInfo.activeSessionId };
			}
			const match = /already active in ([a-zA-Z0-9_-]+)/i.exec(response.error || "");
			if (match?.[1]) {
				return { activeSessionId: match[1] };
			}
			throw new Error(response.error);
		}
		const data = response.data as { activeSessionId?: string; id?: string } | undefined;
		const activeSessionId = data?.activeSessionId ?? data?.id;
		if (!activeSessionId) throw new Error("The daemon returned no active session id");
		return { activeSessionId };
	} finally {
		client.close();
	}
}

/**
 * Clear the input-pump suspension that a TUI-side cancel leaves behind
 * (requestAbort sets it; only the interactive owner resumes it normally).
 * Returns whether the daemon reported selectable queued work — the suspension
 * is cleared regardless.
 */
export async function resumeSessionQueue(activeSessionId: string): Promise<boolean> {
	const client = await connectDaemon();
	try {
		const response = await client.request({ type: "resume_queue", activeSessionId }, 30_000);
		return response.success;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

export async function listDaemonSessions(): Promise<SessionSummary[]> {
	const client = await connectDaemon();
	try {
		const response = await client.request({ type: "list", all: true });
		if (!response.success) throw new Error(response.error);
		const data = response.data as { sessions?: unknown } | undefined;
		if (!Array.isArray(data?.sessions)) throw new Error("The daemon returned an invalid session list");
		const sessions = data.sessions as SessionSummary[];
		for (const s of sessions) {
			if (s.sessionFile) {
				const recordedCwd = tryReadSessionCwd(s.sessionFile);
				if (recordedCwd) s.cwd = recordedCwd;
			}
		}
		return sessions;
	} finally {
		client.close();
	}
}

export async function killDaemonSession(activeSessionId: string): Promise<void> {
	const client = await connectDaemon();
	try {
		const response = await client.request({ type: "kill", activeSessionId });
		if (!response.success) throw new Error(response.error);
	} finally {
		client.close();
	}
}

/** Remove a session's saved transcript through the daemon catalog. */
export async function deleteSavedSessionFile(sessionPath: string): Promise<void> {
	const client = await connectDaemon();
	try {
		const response = await client.request({ type: "delete_saved_session", sessionPath });
		if (!response.success) throw new Error(response.error);
	} finally {
		client.close();
	}
}
