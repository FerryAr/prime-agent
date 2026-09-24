import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { requestToken, tokensMatch, isAllowedOrigin, isLoopbackOrigin } from "../src/auth.js";
import { HttpError, errorStatus } from "../src/errors.js";
import { createApiServer, type ApiServerInstance } from "../src/server.js";

describe("auth", () => {
	it("extracts token from authorization Bearer header", () => {
		const url = new URL("http://127.0.0.1:4677/api/meta");
		const token = requestToken(url, { authorization: "Bearer secret-token-123" });
		expect(token).toBe("secret-token-123");
	});

	it("extracts token from custom header", () => {
		const url = new URL("http://127.0.0.1:4677/api/meta");
		const token = requestToken(url, { "x-prime-agent-token": "custom-token-456" });
		expect(token).toBe("custom-token-456");
	});

	it("extracts token from query string", () => {
		const url = new URL("http://127.0.0.1:4677/events?token=query-token-789");
		const token = requestToken(url, {});
		expect(token).toBe("query-token-789");
	});

	it("constant-time matches tokens", () => {
		expect(tokensMatch("abc", "abc")).toBe(true);
		expect(tokensMatch("abc", "def")).toBe(false);
	});

	it("checks loopback origin", () => {
		expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
		expect(isLoopbackOrigin("http://127.0.0.1:4677")).toBe(true);
		expect(isLoopbackOrigin("http://evil.com")).toBe(false);
	});
});

describe("errors", () => {
	it("returns correct HTTP status", () => {
		expect(errorStatus(new HttpError(404, "Not found"))).toBe(404);
		expect(errorStatus(new Error("Generic"))).toBe(500);
	});
});

describe("server lifecycle", () => {
	let instance: ApiServerInstance;

	beforeAll(async () => {
		instance = await createApiServer({ port: 0, token: "test-token" });
	});

	afterAll(async () => {
		await instance.close();
	});

	it("returns 401 when token is missing", async () => {
		const res = await fetch(`${instance.url}/api/meta`);
		expect(res.status).toBe(401);
	});

	it("returns 200 with metadata when Bearer token is provided", async () => {
		const res = await fetch(`${instance.url}/api/meta`, {
			headers: { authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toHaveProperty("cwd");
		expect(data).toHaveProperty("version");
	});

	it("handles CORS OPTIONS preflight", async () => {
		const res = await fetch(`${instance.url}/api/meta`, {
			method: "OPTIONS",
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
	});

	it("returns 200 on root GET /", async () => {
		const res = await fetch(`${instance.url}/`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("prime-agent-api");
		expect(data.status).toBe("running");
	});
});
