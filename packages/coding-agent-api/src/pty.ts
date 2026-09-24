import { existsSync, statSync } from "node:fs";
import { type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import * as pty from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedOrigin, isLoopbackOrigin, requestToken, tokensMatch } from "./auth.js";
import type { ApiSessionPool } from "./session-pool.js";

export function setupTerminalWebSocket(
	server: Server,
	sessionPool: ApiSessionPool,
	token?: string | string[],
	verifyAuth?: (req: IncomingMessage, url: URL) => boolean,
): WebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
		const hostHeader = req.headers.host;
		const origin = req.headers.origin;
		if (origin && !isLoopbackOrigin(origin) && !isAllowedOrigin(origin, hostHeader)) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}

		const url = new URL(req.url ?? "/", `http://${hostHeader || "127.0.0.1"}`);
		if (url.pathname !== "/api/terminal/ws") {
			return;
		}

		if (verifyAuth) {
			if (!verifyAuth(req, url)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
		} else if (token) {
			const providedToken = requestToken(url, req.headers);
			const allowedTokens = Array.isArray(token) ? token : [token];
			const isMatch = providedToken && allowedTokens.some((t) => tokensMatch(t, providedToken));
			if (!isMatch) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
		}

		const sessionId = url.searchParams.get("sessionId");
		const paramCwd = url.searchParams.get("cwd");
		let rootDir = "";

		// 1. Highest priority: explicit CWD requested by the client if valid
		if (paramCwd) {
			try {
				if (existsSync(paramCwd) && statSync(paramCwd).isDirectory()) {
					rootDir = paramCwd;
				}
			} catch {}
		}

		// 2. Resolve via active sessionPool if not explicitly set
		if (!rootDir && sessionId) {
			try {
				const session = await sessionPool.resolveSession(sessionId);
				rootDir = await sessionPool.sessionRoot(session);
			} catch {}
		}

		// 3. Fallback: try reading session catalog from daemon roster
		if (!rootDir && sessionId) {
			try {
				const summaries = await sessionPool.loadSessionSummaries();
				const match = summaries.find((s) => s.id === sessionId || s.activeSessionId === sessionId);
				if (match?.cwd && existsSync(match.cwd)) {
					rootDir = match.cwd;
				}
			} catch {}
		}

		if (!rootDir || !existsSync(rootDir)) {
			rootDir = process.cwd();
		}

		wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
			wss.emit("connection", ws, req, { rootDir });
		});
	});

	wss.on("connection", (ws: WebSocket, _req: IncomingMessage, extra: { rootDir: string }) => {
		const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
		let ptyProcess: pty.IPty | null = null;

		try {
			ptyProcess = pty.spawn(shell, [], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: extra.rootDir,
				env: {
					...process.env,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
				},
			});
		} catch (err: any) {
			ws.send(JSON.stringify({ type: "output", data: `Failed to spawn PTY: ${err.message}\r\n` }));
			ws.close();
			return;
		}

		ptyProcess.onData((data: string) => {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify({ type: "output", data }));
			}
		});

		ptyProcess.onExit(({ exitCode }) => {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify({ type: "exit", code: exitCode }));
				ws.close();
			}
		});

		ws.on("message", (message: Buffer | string) => {
			try {
				const payload = JSON.parse(message.toString());
				if (payload.type === "input" && typeof payload.data === "string") {
					ptyProcess?.write(payload.data);
				} else if (payload.type === "resize") {
					const cols = Math.max(10, Math.min(500, Number(payload.cols) || 80));
					const rows = Math.max(5, Math.min(200, Number(payload.rows) || 24));
					ptyProcess?.resize(cols, rows);
				}
			} catch {
				ptyProcess?.write(message.toString());
			}
		});

		ws.on("close", () => {
			try {
				ptyProcess?.kill();
			} catch {}
		});
	});

	return wss;
}
