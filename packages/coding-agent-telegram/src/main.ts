process.on("unhandledRejection", (reason) => {
	console.error("[TELEGRAM UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (error) => {
	console.error("[TELEGRAM UNCAUGHT EXCEPTION]", error);
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PrimeApiClient } from "./api-client.js";
import { createTelegramBot } from "./bot.js";
import { loadBotConfig } from "./config.js";

async function main(): Promise<void> {
	const config = loadBotConfig();
	const apiClient = new PrimeApiClient(config.apiUrl, config.apiToken);

	console.log(`Connecting to Prime Agent API at ${config.apiUrl}...`);
	try {
		const meta = await apiClient.getMeta();
		console.log(`Connected to Prime Agent v${meta.version} (CWD: ${meta.cwd})`);
	} catch (err: any) {
		console.warn(`⚠️ Warning: could not connect to API at ${config.apiUrl}: ${err.message}`);
		console.warn("Make sure Prime Agent API or Web is running (e.g. `prime-agent api` or `prime-agent web`).");
	}

	const bot = createTelegramBot(config, apiClient);

	const dataDir = process.env.PRIME_AGENT_TELEGRAM_DATA_DIR ?? join(getAgentDir(), "prime-agent-telegram");
	mkdirSync(dataDir, { recursive: true });
	const gatewayInfoPath = join(dataDir, "gateway.json");

	const cleanup = () => {
		try {
			rmSync(gatewayInfoPath, { force: true });
		} catch {}
	};

	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		bot.stop();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		bot.stop();
		process.exit(0);
	});

		const info: Record<string, any> = {
		pid: process.pid,
		apiUrl: config.apiUrl,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(gatewayInfoPath, JSON.stringify(info, null, 2), { mode: 0o600 });

	console.log("Initializing Telegram Bot...");
	await bot.init();
	info.botUsername = bot.botInfo.username;
	info.botId = bot.botInfo.id;
	writeFileSync(gatewayInfoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
	console.log(`✨ Prime Agent Telegram bot is live as @${bot.botInfo.username}!`);

	await bot.start();
}

main().catch((err) => {
	console.error("Fatal bot error:", err);
	process.exit(1);
});
