import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAllowedOrigin, isLoopbackOrigin, requestToken, tokensMatch } from "./auth.js";
import { errorStatus, HttpError } from "./errors.js";
import { RosterHub } from "./roster.js";
import { type ApiContext, handleApiRoute, json } from "./router.js";
import { ApiSessionPool } from "./session-pool.js";
import { setupTerminalWebSocket } from "./pty.js";

export interface ApiServerOptions {
	port?: number;
	host?: string;
	token?: string;
	version?: string;
}

export interface ApiServerInstance {
	server: Server;
	port: number;
	host: string;
	token: string;
	url: string;
	sessionPool: ApiSessionPool;
	rosterHub: RosterHub;
	close: () => Promise<void>;
}

export function createApiContext(version?: string): ApiContext {
	return {
		sessionPool: new ApiSessionPool(),
		rosterHub: new RosterHub(),
		version,
	};
}

export function checkApiAuth(
	req: IncomingMessage,
	url: URL,
	expectedToken: string | undefined,
): void {
	if (!expectedToken) return;
	const providedToken = requestToken(url, req.headers);
	if (!providedToken || !tokensMatch(expectedToken, providedToken)) {
		throw new HttpError(401, "Unauthorized: missing or invalid authentication token");
	}
}

export function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
	const origin = req.headers.origin;
	if (origin) {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("access-control-allow-credentials", "true");
	} else {
		res.setHeader("access-control-allow-origin", "*");
	}
	res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader(
		"access-control-allow-headers",
		"Authorization, Content-Type, X-Prime-Agent-Token, X-Prime-Web-Token, Accept",
	);

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return true;
	}
	return false;
}

/**
 * Programmatic request handler. Can be used inside existing HTTP servers (such as coding-agent-web)
 * to delegate /api/* and /events* handling.
 */
export async function handleApiRequest(
	req: IncomingMessage,
	res: ServerResponse,
	context: ApiContext,
	options: { token?: string } = {},
): Promise<boolean> {
	if (setCorsHeaders(req, res)) return true;

	const hostHeader = req.headers.host;
	const origin = req.headers.origin;
	if (!isLoopbackOrigin(origin) && !isAllowedOrigin(origin, hostHeader)) {
		throw new HttpError(403, "Cross-origin request rejected");
	}

	const url = new URL(req.url ?? "/", `http://${hostHeader || "127.0.0.1"}`);

	// Check if this is an API or event route
	if (!url.pathname.startsWith("/api/") && url.pathname !== "/events" && url.pathname !== "/events/roster") {
		return false;
	}

	checkApiAuth(req, url, options.token);

	return await context.sessionPool.requestSessions.run(new Set(), async () => {
		return await handleApiRoute(req, res, url, context);
	});
}

/**
 * Creates and starts a standalone headless API server.
 */
export function createApiServer(options: ApiServerOptions = {}): Promise<ApiServerInstance> {
	const host = options.host ?? process.env.PRIME_AGENT_API_HOST ?? "0.0.0.0";
	const port = options.port ?? Number(process.env.PRIME_AGENT_API_PORT ?? 4677);
	const token = options.token ?? getOrCreateDedicatedApiToken();
	const context = createApiContext(options.version);

	const server = createServer(async (req, res) => {
		try {
			const handled = await handleApiRequest(req, res, context, { token });
			if (!handled) {
				const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);
				if (url.pathname === "/" && req.method === "GET") {
					json(res, 200, {
						name: "prime-agent-api",
						status: "running",
						version: context.version,
					});
					return;
				}
				json(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
			}
		} catch (error) {
			const status = errorStatus(error);
			const message = error instanceof Error ? error.message : String(error);
			json(res, status, { error: message });
		}
	});

	setupTerminalWebSocket(server, context.sessionPool, token);

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			const boundAddress = server.address();
			const boundPort = typeof boundAddress === "object" && boundAddress ? boundAddress.port : port;
			const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
			const url = `http://${displayHost}:${boundPort}`;
			resolve({
				server,
				port: boundPort,
				host,
				token,
				url,
				sessionPool: context.sessionPool,
				rosterHub: context.rosterHub,
				close: () =>
					new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()));
					}),
			});
		});
	});
}
