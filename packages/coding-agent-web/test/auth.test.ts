import { URL } from "node:url";
import { describe, expect, test } from "vitest";
import { isAllowedOrigin, isLoopbackOrigin, requestToken, tokensMatch } from "../src/auth.js";

describe("web auth helpers", () => {
	test("requestToken prefers the header over the query parameter", () => {
		const url = new URL("http://127.0.0.1:4677/events?sessionId=s1&token=query-token");
		expect(requestToken(url, "header-token")).toBe("header-token");
		expect(requestToken(url, undefined)).toBe("query-token");
		expect(requestToken(new URL("http://127.0.0.1:4677/events"), undefined)).toBeNull();
	});

	test("tokensMatch accepts equal tokens and rejects others", () => {
		expect(tokensMatch("secret", "secret")).toBe(true);
		expect(tokensMatch("secret", "different")).toBe(false);
		expect(tokensMatch("secret", "")).toBe(false);
	});

	test("isLoopbackOrigin allows missing and loopback origins", () => {
		expect(isLoopbackOrigin(undefined)).toBe(true);
		expect(isLoopbackOrigin("http://127.0.0.1:4677")).toBe(true);
		expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
	});

	test("isLoopbackOrigin rejects remote and malformed origins", () => {
		expect(isLoopbackOrigin("https://evil.example")).toBe(false);
		expect(isLoopbackOrigin("not a url")).toBe(false);
	});
	test("isAllowedOrigin allows matching Host and loopbacks", () => {
		expect(isAllowedOrigin(undefined, "192.168.1.50:4677")).toBe(true);
		expect(isAllowedOrigin("http://127.0.0.1:4677", "127.0.0.1:4677")).toBe(true);
		expect(isAllowedOrigin("http://192.168.1.50:4677", "192.168.1.50:4677")).toBe(true);
		expect(isAllowedOrigin("https://evil.example", "192.168.1.50:4677")).toBe(false);
	});

});
