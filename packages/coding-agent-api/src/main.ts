import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { createApiServer } from "./server.js";

function flagValue(name: string): string | undefined {
	const argv = process.argv.slice(2);
	const index = argv.indexOf(`--${name}`);
	if (index !== -1) return argv[index + 1];
	const inline = argv.find((a) => a.startsWith(`--${name}=`));
	return inline ? inline.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
	const portFlag = flagValue("port");
	const port = portFlag ? Number(portFlag) : undefined;
	const host = flagValue("host");
	const token = flagValue("token");

	const instance = await createApiServer({ port, host, token, version: VERSION });

	const dataDir = process.env.PRIME_AGENT_API_DATA_DIR ?? join(getAgentDir(), "prime-agent-api");
	mkdirSync(dataDir, { recursive: true });
	const gatewayInfoPath = join(dataDir, "gateway.json");

	const info = {
		pid: process.pid,
		port: instance.port,
		host: instance.host,
		url: instance.url,
		token: instance.token,
		version: VERSION,
		startedAt: new Date().toISOString(),
	};

	writeFileSync(gatewayInfoPath, JSON.stringify(info, null, 2), { mode: 0o600 });

	const cleanup = () => {
		try {
			rmSync(gatewayInfoPath, { force: true });
		} catch {}
	};

	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	console.log(`Prime Agent API gateway running at: ${instance.url}`);
	console.log(`Authentication token: ${instance.token}`);
	console.log(`Gateway info saved to: ${gatewayInfoPath}`);
}

main().catch((error) => {
	console.error("Failed to start Prime Agent API gateway:", error);
	process.exit(1);
});
