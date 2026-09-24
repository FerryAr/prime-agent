import { describe, it, expect } from "vitest";
import { escapeHtml, splitMessage, formatToolInvocation } from "../src/formatters.js";
import { ProgressiveThrottle } from "../src/stream-throttle.js";
import { PrimeApiClient } from "../src/api-client.js";

describe("formatters", () => {
	it("escapes html special characters", () => {
		expect(escapeHtml("<hello & 'world'>")).toBe("&lt;hello &amp; 'world'&gt;");
	});

	it("splits long messages along newlines", () => {
		const longText = "line 1\nline 2\nline 3\nline 4";
		const chunks = splitMessage(longText, 14);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("\n")).toBe(longText);
	});

	it("formats tool invocations nicely", () => {
		const formatted = formatToolInvocation("bash", { command: "git status" });
		expect(formatted).toContain("git status");
		expect(formatted).toContain("bash");
	});
});

describe("stream throttle", () => {
	it("schedules and flushes updates", async () => {
		const throttler = new ProgressiveThrottle();
		let called = false;
		throttler.schedule(async () => {
			called = true;
		});
		expect(called).toBe(true); // first call runs immediately when interval elapsed
	});
});

describe("api client", () => {
	it("configures base url and authorization headers", () => {
		const client = new PrimeApiClient("http://localhost:4677/", "test-token");
		expect(client.baseUrl).toBe("http://localhost:4677");
		expect(client.token).toBe("test-token");
	});
});
