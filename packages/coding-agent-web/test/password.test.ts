import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PasswordGate } from "../src/password.js";

describe("PasswordGate", () => {
	test("generates a password on first boot and verifies it", () => {
		const dataDir = join(mkdtempSync(join(tmpdir(), "prime-agent-web-pw-")), "data");
		const gate = new PasswordGate(dataDir);
		expect(gate.generatedPassword).toBe("primeagent");
		expect(gate.verify("primeagent")).toBe(true);
		expect(gate.verify("wrong-password")).toBe(false);
	});

	test("allows changing password with valid current password", () => {
		const dataDir = join(mkdtempSync(join(tmpdir(), "prime-agent-web-pw-")), "data");
		const gate = new PasswordGate(dataDir);
		expect(gate.verify("primeagent")).toBe(true);

		// Wrong current password
		expect(gate.changePassword("wrong", "newSecret123")).toBe(false);
		expect(gate.verify("primeagent")).toBe(true);
		expect(gate.verify("newSecret123")).toBe(false);

		// Correct current password
		expect(gate.changePassword("primeagent", "newSecret123")).toBe(true);
		expect(gate.verify("newSecret123")).toBe(true);
		expect(gate.verify("primeagent")).toBe(false);

		// Persists across restarts
		const restarted = new PasswordGate(dataDir);
		expect(restarted.verify("newSecret123")).toBe(true);
		expect(restarted.verify("primeagent")).toBe(false);
	});

	test("keeps the stored password across restarts when no env is set", () => {
		const dataDir = join(mkdtempSync(join(tmpdir(), "prime-agent-web-pw-")), "data");
		const first = new PasswordGate(dataDir);
		const generated = first.generatedPassword ?? "";
		const second = new PasswordGate(dataDir);
		expect(second.generatedPassword).toBeUndefined();
		expect(second.verify(generated)).toBe(true);
	});

	test("an env password overrides and persists", () => {
		const dataDir = join(mkdtempSync(join(tmpdir(), "prime-agent-web-pw-")), "data");
		const gate = new PasswordGate(dataDir, "my-env-password");
		expect(gate.generatedPassword).toBeUndefined();
		expect(gate.verify("my-env-password")).toBe(true);
		expect(gate.verify(gate.generatedPassword ?? "")).toBe(false);
		// a restart without the env keeps the env-set password
		expect(new PasswordGate(dataDir).verify("my-env-password")).toBe(true);
	});

	test("login cookies survive a restart and logout invalidates them", () => {
		const dataDir = join(mkdtempSync(join(tmpdir(), "prime-agent-web-pw-")), "data");
		const gate = new PasswordGate(dataDir, "my-env-password");
		const token = gate.createLogin();
		expect(gate.resolveLogin(token)).toBe(true);
		expect(new PasswordGate(dataDir, "my-env-password").resolveLogin(token)).toBe(true);
		gate.logout(token);
		expect(gate.resolveLogin(token)).toBe(false);
	});
});
