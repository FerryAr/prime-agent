import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PasswordGate } from "../src/password.js";

describe("PasswordGate login rate limiting", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(`${tmpdir()}/pw-rate-`);
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	function gate(): PasswordGate {
		return new PasswordGate(dataDir, "test-password");
	}

	it("allows the first attempts and locks after the failure threshold", () => {
		const gate = new PasswordGate(dataDir, "test-password");
		expect(gate.lockedForMs("ip1")).toBe(0);
		for (let i = 0; i < 4; i++) gate.recordFailure("ip1");
		expect(gate.lockedForMs("ip1")).toBe(0);
		gate.recordFailure("ip1");
		expect(gate.lockedForMs("ip1")).toBeGreaterThan(0);
	});

	it("escalates lock duration with more failures", () => {
		const gate = new PasswordGate(dataDir, "test-password");
		for (let i = 0; i < 5; i++) gate.recordFailure("ip2");
		const first = gate.lockedForMs("ip2");
		gate.recordFailure("ip2");
		const second = gate.lockedForMs("ip2");
		expect(second).toBeGreaterThanOrEqual(first);
	});

	it("clears the lock and failure count after a successful login", () => {
		const gate = new PasswordGate(dataDir, "test-password");
		for (let i = 0; i < 6; i++) gate.recordFailure("ip3");
		expect(gate.lockedForMs("ip3")).toBeGreaterThan(0);
		gate.recordSuccess("ip3");
		expect(gate.lockedForMs("ip3")).toBe(0);
		gate.recordFailure("ip3");
		expect(gate.lockedForMs("ip3")).toBe(0);
	});

	it("tracks clients independently", () => {
		const gate = new PasswordGate(dataDir, "test-password");
		for (let i = 0; i < 6; i++) gate.recordFailure("ip4");
		expect(gate.lockedForMs("ip4")).toBeGreaterThan(0);
		expect(gate.lockedForMs("ip5")).toBe(0);
	});
});
