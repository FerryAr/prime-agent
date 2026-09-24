function autoLoadEnv(): void {
	const candidates = [
		join(getAgentDir(), "prime-agent-telegram", ".env"),
		join(getAgentDir(), ".env"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			try {
				if (typeof (process as any).loadEnvFile === "function") {
					(process as any).loadEnvFile(candidate);
				} else {
					const content = readFileSync(candidate, "utf8");
					for (const line of content.split("\n")) {
						const trimmed = line.trim();
						if (!trimmed || trimmed.startsWith("#")) continue;
						const eq = trimmed.indexOf("=");
						if (eq === -1) continue;
						const key = trimmed.slice(0, eq).trim();
						let val = trimmed.slice(eq + 1).trim();
						if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
							val = val.slice(1, -1);
						}
						if (!process.env[key]) {
							process.env[key] = val;
						}
					}
				}
			} catch {}
		}
	}
}
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BotConfig {
	botToken: string;
	allowedUserIds: number[];
	apiUrl: string;
	apiToken?: string;
	whisperApiKey?: string;
	whisperBaseUrl?: string;
}

export function tryReadGatewayToken(): string | undefined {
	// 1. Try reading the permanent dedicated API token first
	const apiTokenFile = join(getAgentDir(), "prime-agent-api", "api-token.txt");
	if (existsSync(apiTokenFile)) {
		try {
			const tok = readFileSync(apiTokenFile, "utf8").trim();
			if (tok.length > 0) return tok;
		} catch {}
	}
	// 2. Fall back to web/gateway token files
	for (const dir of ["prime-agent-web", "prime-agent-api"]) {
		const tokenFile = join(getAgentDir(), dir, "token.txt");
		if (existsSync(tokenFile)) {
			try {
				const tok = readFileSync(tokenFile, "utf8").trim();
				if (tok.length > 0) return tok;
			} catch {}
		}
	}
	// Fall back to reading gateway.json
	for (const dir of ["prime-agent-api", "prime-agent-web"]) {
		const gwPath = join(getAgentDir(), dir, "gateway.json");
		if (existsSync(gwPath)) {
			try {
				const info = JSON.parse(readFileSync(gwPath, "utf8"));
				if (info?.token) return info.token;
			} catch {}
		}
	}
	return undefined;
}

export function loadBotConfig(): BotConfig {
	autoLoadEnv();
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) {
		throw new Error("TELEGRAM_BOT_TOKEN environment variable is required.");
	}

	const allowedUsersRaw = process.env.TELEGRAM_ALLOWED_USER_ID ?? process.env.TELEGRAM_ALLOWED_USERS ?? "";
	const allowedUserIds = allowedUsersRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0);

	if (allowedUserIds.length === 0) {
		console.warn(
			"⚠️ WARNING: TELEGRAM_ALLOWED_USER_ID is not set. For security, set your numeric Telegram User ID.",
		);
	}

	const apiUrl = process.env.PRIME_AGENT_API_URL ?? "http://127.0.0.1:4677";
	const apiToken = process.env.PRIME_AGENT_API_TOKEN ?? tryReadGatewayToken();

	const whisperApiKey = process.env.WHISPER_API_KEY ?? process.env.OPENAI_API_KEY;
	const whisperBaseUrl = process.env.WHISPER_API_BASE_URL ?? process.env.OPENAI_BASE_URL;

	return {
		botToken,
		allowedUserIds,
		apiUrl,
		apiToken,
		whisperApiKey,
		whisperBaseUrl,
	};

}
