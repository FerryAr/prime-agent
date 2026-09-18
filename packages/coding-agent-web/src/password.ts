import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_COOKIE = "prime_agent_session";
export const DEFAULT_WEB_PASSWORD = "primeagent";
const LOGIN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const LOGIN_MAX_FAILURES = 5;
const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BASE_LOCK_MS = 30 * 1000;
const LOGIN_MAX_LOCK_MS = 15 * 60 * 1000;

interface StoredPassword {
	salt: string;
	hash: string;
}

/** Single-user password gate: one password, one persistent browser cookie. */
export class PasswordGate {
	readonly #dataDir: string;
	readonly #envPassword: string | undefined;
	#logins = new Map<string, number>();
	#failures = new Map<string, { count: number; firstAt: number }>();
	#lockouts = new Map<string, number>();

	/** Set when the gate generated the password itself (first boot, no env). */
	generatedPassword?: string;

	constructor(dataDir: string, envPassword?: string) {
		this.#dataDir = dataDir;
		this.#envPassword = envPassword;
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.#loadLogins();
		if (this.#envPassword || !existsSync(this.#passwordPath)) {
			const password = this.#envPassword ?? DEFAULT_WEB_PASSWORD;
			this.#store(password);
			if (!this.#envPassword) this.generatedPassword = password;
		}
	}

	get #passwordPath(): string {
		return join(this.#dataDir, "password.json");
	}

	get #loginsPath(): string {
		return join(this.#dataDir, "sessions.json");
	}

	#store(password: string): void {
		const salt = randomBytes(16).toString("hex");
		const hash = scryptSync(password, salt, 64).toString("hex");
		writeJsonAtomic(this.#passwordPath, { salt, hash });
	}

	verify(password: string): boolean {
		let stored: StoredPassword | undefined;
		try {
			stored = JSON.parse(readFileSync(this.#passwordPath, "utf8")) as StoredPassword;
		} catch {
			return false;
		}
		if (!stored?.salt || !stored?.hash) return false;
		const candidate = scryptSync(password, stored.salt, 64);
		const expected = Buffer.from(stored.hash, "hex");
		return expected.length === candidate.length && timingSafeEqual(expected, candidate);
	}

	changePassword(currentPassword: string, newPassword: string): boolean {
		if (!this.verify(currentPassword)) return false;
		if (!newPassword || newPassword.length < 4) {
			throw new Error("New password must be at least 4 characters");
		}
		this.#store(newPassword);
		return true;
	}

	createLogin(): string {
		const token = randomBytes(32).toString("base64url");
		this.#logins.set(token, Date.now() + LOGIN_TTL_MS);
		this.#persistLogins();
		return token;
	}

	resolveLogin(token: string | undefined): boolean {
		if (!token) return false;
		const expiresAt = this.#logins.get(token);
		if (!expiresAt) return false;
		if (expiresAt < Date.now()) {
			this.#logins.delete(token);
			this.#persistLogins();
			return false;
		}
		return true;
	}

	/** Remaining lockout for a client after repeated failed logins (brute-force guard). */
	lockedForMs(ip: string): number {
		const until = this.#lockouts.get(ip) ?? 0;
		return Math.max(0, until - Date.now());
	}

	recordFailure(ip: string): void {
		const now = Date.now();
		const entry = this.#failures.get(ip);
		if (!entry || now - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
			this.#failures.set(ip, { count: 1, firstAt: now });
		} else {
			entry.count += 1;
		}
		if (this.#failures.size > 1000) this.#pruneFailures();
		if (entry && entry.count >= LOGIN_MAX_FAILURES) {
			const exponent = Math.min(entry.count - LOGIN_MAX_FAILURES, 5);
			const duration = Math.min(LOGIN_BASE_LOCK_MS * 2 ** exponent, LOGIN_MAX_LOCK_MS);
			this.#lockouts.set(ip, now + duration);
		}
	}

	recordSuccess(ip: string): void {
		this.#failures.delete(ip);
		this.#lockouts.delete(ip);
	}

	#pruneFailures(): void {
		const now = Date.now();
		for (const [ip, entry] of this.#failures) {
			if (now - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) this.#failures.delete(ip);
		}
	}

	logout(token: string | undefined): void {
		if (token && this.#logins.delete(token)) this.#persistLogins();
	}

	#loadLogins(): void {
		try {
			const parsed = JSON.parse(readFileSync(this.#loginsPath, "utf8")) as Array<{
				token: string;
				expiresAt: number;
			}>;
			if (Array.isArray(parsed)) {
				for (const login of parsed) this.#logins.set(login.token, login.expiresAt);
			}
		} catch {
			// no persisted logins
		}
	}

	#persistLogins(): void {
		const now = Date.now();
		for (const [token, expiresAt] of this.#logins) {
			if (expiresAt < now) this.#logins.delete(token);
		}
		writeJsonAtomic(
			this.#loginsPath,
			[...this.#logins.entries()].map(([token, expiresAt]) => ({ token, expiresAt })),
		);
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
	renameSync(tmp, path);
}
