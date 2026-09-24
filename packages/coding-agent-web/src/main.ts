import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import {
	asString,
	createApiContext,
	errorStatus,
	handleApiRoute,
	HttpError,
	isAllowedOrigin,
	json,
	readJson,
	requestToken,
	tokensMatch,
	getOrCreateDedicatedApiToken,
	setupTerminalWebSocket,
} from "@earendil-works/prime-agent-api";
import { PasswordGate, SESSION_COOKIE } from "./password.js";

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
const DATA_DIR = process.env.PRIME_AGENT_WEB_DATA_DIR ?? join(getAgentDir(), "prime-agent-web");
mkdirSync(DATA_DIR, { recursive: true });

function getOrCreateWebToken(): string {
	if (process.env.PRIME_AGENT_WEB_TOKEN) return process.env.PRIME_AGENT_WEB_TOKEN;
	const tokenPath = join(DATA_DIR, "token.txt");
	if (existsSync(tokenPath)) {
		try {
			const saved = readFileSync(tokenPath, "utf8").trim();
			if (saved.length > 0) return saved;
		} catch {}
	}
	const generated = randomBytes(24).toString("base64url");
	try {
		writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
	} catch {}
	return generated;
}

const DEDICATED_API_TOKEN = getOrCreateDedicatedApiToken();
const TOKEN = getOrCreateWebToken();
const STATIC_DIR = (() => {
	const localStatic = join(dirname(fileURLToPath(import.meta.url)), "static");
	if (existsSync(localStatic)) return localStatic;
	const srcStatic = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "static");
	if (existsSync(srcStatic)) return srcStatic;
	return localStatic;
})();

const gate = AUTH_MODE === "password" ? new PasswordGate(DATA_DIR, process.env.PRIME_AGENT_WEB_PASSWORD) : undefined;

if (gate?.generatedPassword) {
	const credentialsPath = join(DATA_DIR, "prime-agent-web-password.txt");
	writeFileSync(credentialsPath, `${gate.generatedPassword}\n`, { mode: 0o600 });
	console.log(`Prime Agent web: generated password: ${gate.generatedPassword}`);
	console.log(`Prime Agent web: (also saved to ${credentialsPath})`);
}

const apiContext = createApiContext(VERSION);

const STATIC_ROUTES: Record<string, { file: string; type: string }> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
	"/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
	"/sounds/agent-done.mp3": { file: "sounds/agent-done.mp3", type: "audio/mpeg" },
	"/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

function cookieValue(req: IncomingMessage, name: string): string | undefined {
	const header = req.headers.cookie;
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

function authenticate(req: IncomingMessage, url: URL): void {
	// Accept Bearer tokens from API clients alongside session cookies.
	const headerToken = req.headers.authorization?.startsWith("Bearer ")
		? req.headers.authorization.slice(7).trim()
		: (req.headers["x-prime-agent-token"] || req.headers["x-prime-web-token"]);
	const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
	const tokenToVerify = requestToken(url, provided);
	if (tokenToVerify) {
		if (tokensMatch(DEDICATED_API_TOKEN, tokenToVerify) || tokensMatch(TOKEN, tokenToVerify)) {
			return;
		}
	}

	if (AUTH_MODE === "token") {
		throw new HttpError(401, "Missing or invalid token");
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

async function routeWebAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
	const method = req.method ?? "GET";
	const pathname = url.pathname;

	if (method === "GET" && pathname === "/api/meta") {
		json(res, 200, { cwd: process.cwd(), home: homedir(), authMode: AUTH_MODE, version: VERSION });
		return true;
	}
	if (method === "POST" && pathname === "/api/logout") {
		gate?.logout(cookieValue(req, SESSION_COOKIE));
		res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
		json(res, 200, { ok: true });
		return true;
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
		return true;
	}

	return false;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
	try {
		const staticRoute = req.method === "GET" ? STATIC_ROUTES[url.pathname] : undefined;
		if (staticRoute) {
			const data = await readFile(join(STATIC_DIR, staticRoute.file));
			const acceptEncoding = String(req.headers["accept-encoding"] ?? "").toLowerCase();
			if (data.length > 1024 && acceptEncoding.includes("gzip") && (staticRoute.type.includes("text") || staticRoute.type.includes("json") || staticRoute.type.includes("javascript"))) {
				res.writeHead(200, { "content-type": staticRoute.type, "content-encoding": "gzip", "cache-control": "no-store", vary: "Accept-Encoding" });
				res.end(gzipSync(data));
			} else {
				res.writeHead(200, { "content-type": staticRoute.type, "cache-control": "no-store" });
				res.end(data);
			}
			return;
		}
		if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
			const safeSubpath = url.pathname.slice("/vendor/".length).replace(/\.\./g, "");
			const fullPath = join(STATIC_DIR, "vendor", safeSubpath);
			if (existsSync(fullPath)) {
				let contentType = "application/octet-stream";
				if (fullPath.endsWith(".js")) contentType = "text/javascript; charset=utf-8";
				else if (fullPath.endsWith(".css")) contentType = "text/css; charset=utf-8";
				else if (fullPath.endsWith(".woff2")) contentType = "font/woff2";
				else if (fullPath.endsWith(".woff")) contentType = "font/woff";
				else if (fullPath.endsWith(".ttf")) contentType = "font/ttf";
				const data = await readFile(fullPath);
				const acceptEncoding = String(req.headers["accept-encoding"] ?? "").toLowerCase();
				if (data.length > 1024 && acceptEncoding.includes("gzip") && !fullPath.endsWith(".woff2")) {
					res.writeHead(200, { "content-type": contentType, "content-encoding": "gzip", "cache-control": "public, max-age=31536000, immutable", vary: "Accept-Encoding" });
					res.end(gzipSync(data));
				} else {
					res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" });
					res.end(data);
				}
				return;
			}
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

		// Handle web-specific auth endpoints
		if (await routeWebAuth(req, res, url)) {
			return;
		}

		// Delegate all headless REST & SSE endpoints to prime-agent-api
		await apiContext.sessionPool.requestSessions.run(new Set(), async () => {
			const handled = await handleApiRoute(req, res, url, apiContext);
			if (!handled) {
				json(res, 404, { message: `Not found: ${req.method} ${url.pathname}` });
			}
		});
	} catch (error) {
		console.error("HTTP error handling request:", req.method, req.url, error);
		const status = errorStatus(error);
		const message = error instanceof Error ? error.message : String(error);
		if (res.headersSent) res.destroy();
		else json(res, status, { message, ...(status === 401 ? { auth: AUTH_MODE } : {}), ...(status === 500 ? { stack: error instanceof Error ? error.stack : undefined } : {}) });
	}
}

function lanAddresses(): string[] {
	const ips: string[] = [];
	for (const addrs of Object.values(networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal) ips.push(a.address);
		}
	}
	return ips;
}

const server = createServer(handle);
setupTerminalWebSocket(server, apiContext.sessionPool, [DEDICATED_API_TOKEN, TOKEN], (req, url) => {
	try {
		authenticate(req, url);
		return true;
	} catch {
		return false;
	}
});

server.listen(PORT, HOST, () => {
	const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
	const localUrl = `http://${displayHost}:${PORT}`;
	const gatewayUrl = AUTH_MODE === "token" ? `${localUrl}/?token=${TOKEN}` : localUrl;
	console.log(`Prime Agent web listening on ${localUrl}`);
	if (AUTH_MODE === "token") console.log(`Open with token: ${gatewayUrl}`);
	for (const ip of lanAddresses()) {
		console.log(`  LAN: http://${ip}:${PORT}${AUTH_MODE === "token" ? `/?token=${TOKEN}` : ""}`);
	}

	const gatewayInfo = {
		pid: process.pid,
		port: PORT,
		host: HOST,
		url: gatewayUrl,
		token: TOKEN,
		authMode: AUTH_MODE,
		startedAt: new Date().toISOString(),
	};
	const gatewayInfoPath = join(DATA_DIR, "gateway.json");
	writeFileSync(gatewayInfoPath, JSON.stringify(gatewayInfo, null, 2), { mode: 0o600 });

	const cleanup = () => {
		try {
			const current = JSON.parse(readFile(gatewayInfoPath, "utf8") as unknown as string);
			if (current?.pid === process.pid) writeFileSync(gatewayInfoPath, "");
		} catch {}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => { cleanup(); process.exit(0); });
	process.on("SIGTERM", () => { cleanup(); process.exit(0); });
});
