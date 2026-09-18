import { createHash, timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Extract the web token from the header (fetch) or query (EventSource). */
export function requestToken(url: URL, headerToken: string | undefined): string | null {
	return headerToken ?? url.searchParams.get("token");
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
