import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getOrCreateDedicatedApiToken(): string {
	if (process.env.PRIME_AGENT_API_TOKEN) {
		return process.env.PRIME_AGENT_API_TOKEN;
	}
	const dir = join(getAgentDir(), "prime-agent-api");
	mkdirSync(dir, { recursive: true });
	const tokenFile = join(dir, "api-token.txt");
	if (existsSync(tokenFile)) {
		try {
			const saved = readFileSync(tokenFile, "utf8").trim();
			if (saved.length > 0) return saved;
		} catch {}
	}
	const generated = randomBytes(32).toString("base64url");
	try {
		writeFileSync(tokenFile, `${generated}\n`, { mode: 0o600 });
	} catch {}
	return generated;
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Extract the auth token from Bearer header, custom header, or query param. */
export function requestToken(url: URL, headersOrHeaderToken?: IncomingHttpHeaders | string | undefined): string | null {
	if (typeof headersOrHeaderToken === "string") {
		return headersOrHeaderToken;
	}
	if (headersOrHeaderToken && typeof headersOrHeaderToken === "object") {
		const auth = headersOrHeaderToken.authorization;
		if (auth && auth.toLowerCase().startsWith("bearer ")) {
			return auth.slice(7).trim();
		}
		const custom = headersOrHeaderToken["x-prime-agent-token"] || headersOrHeaderToken["x-prime-web-token"];
		if (typeof custom === "string") {
			return custom;
		}
	}
	return url.searchParams.get("token");
}

/** Constant-time comparison via fixed-length digests. */
export function tokensMatch(expected: string, provided: string): boolean {
	const expectedHash = createHash("sha256").update(expected).digest();
	const providedHash = createHash("sha256").update(provided).digest();
	return timingSafeEqual(expectedHash, providedHash);
}

/** Reject browser cross-origin calls from non-loopback pages. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
	if (!origin) return true;
	try {
		return LOOPBACK_HOSTS.has(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/** Validate browser origin: allows loopback pages or pages matching the gateway's Host header. */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
	if (!origin) return true;
	try {
		const originUrl = new URL(origin);
		if (LOOPBACK_HOSTS.has(originUrl.hostname)) return true;
		if (hostHeader) {
			const expectedHost = hostHeader.split(":")[0];
			if (originUrl.hostname === expectedHost) return true;
		}
		return false;
	} catch {
		return false;
	}
}
