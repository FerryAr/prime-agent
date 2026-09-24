import { execFile, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { APP_NAME, getAgentDir, SELF_UPDATE_INTERACTIVE_CHILD_ENV } from "../config.js";
import { AuthStorage } from "../core/auth-storage.js";
import { runMcpManagementCommand } from "../core/mcp/mcp-command.js";
import { SettingsManager } from "../core/settings-manager.js";
import { defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { handlePackageCommand, isSelfUpdateSource } from "../package-manager-cli.js";
import { INTERNAL_RUNTIME_COMMAND_MARKER, parseArgs } from "./args.js";
import {
	findCommandSuggestion,
	formatCommandHelp,
	formatTopLevelHelp,
	getChildCommandSpecs,
	getCommandSpec,
	isHelpCommandRequest,
	PUBLIC_COMMAND_NAMES,
	REMOVED_COMMAND_NAMES,
} from "./command-registry.js";
import { handleDaemonCommand } from "./daemon-command.js";
import { ensureInteractiveDaemonRunning } from "./daemon-launch.js";
import { runPs, runReap, runShutdownAll } from "./daemon-ps.js";
import { DAEMON_UPDATE_RESTART_COORDINATOR_FLAG } from "./daemon-update-restart.js";
import { extractHelpCommandPath, rotateGlobalFlagsBeforeCommand } from "./global-flags.js";
import {
	type IncidentCommandOptions,
	type IncidentWindow,
	parseIncidentOptions,
	resolveIncidentWindow,
	runIncident,
} from "./incident.js";

export interface PublicCommandResult {
	handled: boolean;
	args: string[];
	explicitAgentsView: boolean;
	attachAgent?: string;
}

const HANDLED: PublicCommandResult = { handled: true, args: [], explicitAgentsView: false };

export async function handlePublicCommand(args: string[]): Promise<PublicCommandResult> {
	try {
		return await runPublicCommand(args);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

async function runPublicCommand(args: string[]): Promise<PublicCommandResult> {
	args = rotateGlobalFlagsBeforeCommand(args);
	// Global run flags are excluded from the help request, not forwarded as help
	// arguments: `prime-agent --offline help` must print help, not chat the
	// rotated argv to the model.
	const helpPath = args[0] === "help" ? extractHelpCommandPath(args, 1) : undefined;
	if (helpPath !== undefined && isHelpCommandRequest(helpPath)) {
		return printRequestedHelp(helpPath);
	}

	const command = args[0];
	if (!command) {
		return continueWith(args);
	}

	if (REMOVED_COMMAND_NAMES.has(command)) {
		return rejectRemovedCommand(args);
	}

	if (!PUBLIC_COMMAND_NAMES.has(command)) {
		return continueWith(args);
	}
	if (command === "update" && process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] === "1") {
		await handlePackageCommand(args);
		return HANDLED;
	}
	if (command === "update" && args.includes(DAEMON_UPDATE_RESTART_COORDINATOR_FLAG)) {
		await handlePackageCommand(args);
		return HANDLED;
	}

	const separatorIndex = args.indexOf("--");
	const helpIndex = args.findIndex(
		(arg, index) =>
			index > 0 && (separatorIndex === -1 || index < separatorIndex) && (arg === "--help" || arg === "-h"),
	);
	if (helpIndex !== -1) {
		return printRequestedHelp(getCommandPath(args.slice(0, helpIndex)));
	}

	switch (command) {
		case "agents":
			return { handled: false, args: args.slice(1), explicitAgentsView: true };
		case "list":
			return runInternalAgentCommand("list", args.slice(1));
		case "sessions":
			return runInternalAgentCommand("sessions", args.slice(1));
		case "attach": {
			const rest = args.slice(1);
			const agent = rest[0];
			const options = rest.slice(1);
			if (!agent || agent.startsWith("-") || hasPositionalArguments(options)) {
				return fail(`Usage: ${APP_NAME} ${getCommandSpec(["attach"])!.usage}`);
			}
			if (hasConflictingAttachOption(options)) {
				return fail("attach cannot be combined with --resume, --continue, or --fork.");
			}
			return {
				handled: false,
				args: ["--resume", agent, ...options],
				explicitAgentsView: false,
				attachAgent: agent,
			};
		}
		case "stop":
			if (!requireOperandCount(args.slice(1), 1, 1, "stop")) return HANDLED;
			return runInternalAgentCommand("kill", args.slice(1));
		case "rename":
			if (!requireOperandCount(args.slice(1), 2, undefined, "rename")) return HANDLED;
			return runInternalAgentCommand("rename", args.slice(1));
		case "send":
			return runInternalAgentCommand("send", args.slice(1));
		case "schedule":
			return runNestedAgentCommand("schedule", "cron", args.slice(1));
		case "status":
			return runStatus(args.slice(1));
		case "doctor":
			return runDoctor(args.slice(1));
		case "incident":
			return runIncidentCommand(args.slice(1));
		case "shutdown":
			return runShutdown(args.slice(1));
		case "package":
			return runPackage(args.slice(1));
		case "mcp":
			return runMcp(args.slice(1));
		case "update": {
			const rest = args.slice(1);
			const hasLegacySelfTarget = rest.some((arg) => arg === "--self" || isSelfUpdateSource(arg));
			const hasLegacyPackageTarget = rest.some(
				(arg) =>
					arg === "--extensions" || arg === "--extension" || (!arg.startsWith("-") && !isSelfUpdateSource(arg)),
			);
			if (hasLegacySelfTarget && hasLegacyPackageTarget) {
				return fail(
					"Prime Agent and package updates are now separate.",
					`Run "${APP_NAME} update [--force]" and "${APP_NAME} package update [source]" separately.`,
				);
			}
			if (hasLegacySelfTarget) {
				return fail("An update target is no longer needed.", `Use "${APP_NAME} update [--force]".`);
			}
			if (hasLegacyPackageTarget) {
				return fail("Package updates moved to the package command.", `Use "${APP_NAME} package update [source]".`);
			}
			const options = parseBooleanOptions(
				rest,
				new Set(["--force", "--rollback", "--nightly", "--stable"]),
				"update",
			);
			if (!options) return HANDLED;
			await handlePackageCommand(["update", "--self", ...options]);
			return HANDLED;
		}
		case "model":
			return rewriteNestedCommand("model", "list", "--list-models", args.slice(1));
		case "session":
			return rewriteNestedCommand("session", "export", "--export", args.slice(1));
		case "config":
			if (!requireArgumentCount(args.slice(1), 0, "config")) return HANDLED;
			return continueWith(args);
		case "web":
			return runWeb(args.slice(1));
		case "api":
			return runApi(args.slice(1));
		case "telegram":
			return runTelegram(args.slice(1));
		default:
			return continueWith(args);
	}
}

function continueWith(args: string[]): PublicCommandResult {
	return { handled: false, args, explicitAgentsView: false };
}

function printRequestedHelp(path: string[]): PublicCommandResult {
	if (path.length === 0) {
		console.log(formatTopLevelHelp());
		return HANDLED;
	}
	if (REMOVED_COMMAND_NAMES.has(path[0]!)) {
		return rejectRemovedCommand(path);
	}
	const help = formatCommandHelp(path);
	if (help) {
		console.log(help);
		return HANDLED;
	}
	const parent = path.slice(0, -1);
	const candidates = getChildCommandSpecs(parent).map((spec) => spec.path.at(-1)!);
	const suggestion = findCommandSuggestion(path.at(-1)!, candidates);
	return fail(
		`Unknown command: ${path.join(" ")}`,
		suggestion ? `Did you mean "${APP_NAME} help ${[...parent, suggestion].join(" ")}"?` : undefined,
	);
}

function getCommandPath(args: string[]): string[] {
	const path: string[] = [];
	for (const arg of args) {
		if (!getCommandSpec([...path, arg])) {
			break;
		}
		path.push(arg);
	}
	return path;
}

function rejectRemovedCommand(args: string[]): PublicCommandResult {
	const [command, subcommand] = args;
	let replacement: string | undefined;
	if (command === "daemon") {
		replacement = 'Run "prime-agent help" to see the agent commands.';
	} else if (command === "app" && subcommand === "update") {
		replacement = 'Use "prime-agent update".';
	} else if (command === "install") {
		replacement = 'Use "prime-agent package install".';
	} else if (command === "remove" || command === "uninstall") {
		replacement = 'Use "prime-agent package remove".';
	} else if (command === "manage") {
		replacement = 'Use "prime-agent agents".';
	}
	return fail(`Unknown command: ${args.slice(0, 2).join(" ")}`, replacement);
}

async function runInternalAgentCommand(command: string, args: string[]): Promise<PublicCommandResult> {
	await handleDaemonCommand(["daemon", command, ...args]);
	return HANDLED;
}

async function runNestedAgentCommand(
	parent: string,
	internalCommand: string,
	args: string[],
): Promise<PublicCommandResult> {
	const subcommand = args[0];
	const children = getChildCommandSpecs([parent]).map((spec) => spec.path.at(-1)!);
	if (!subcommand || !children.includes(subcommand)) {
		const suggestion = subcommand ? findCommandSuggestion(subcommand, children) : undefined;
		return fail(
			subcommand ? `Unknown ${parent} command: ${subcommand}` : `Missing ${parent} command.`,
			suggestion
				? `Did you mean "${APP_NAME} ${parent} ${suggestion}"?`
				: `Run "${APP_NAME} help ${parent}" for usage.`,
		);
	}
	if (parent === "schedule" && !validateScheduleArgs(args)) {
		return HANDLED;
	}
	await handleDaemonCommand(["daemon", internalCommand, ...args]);
	return HANDLED;
}

async function runStatus(args: string[]): Promise<PublicCommandResult> {
	const options = parseBooleanOptions(args, new Set(["--json"]), "status");
	if (!options) return HANDLED;
	await runPs(options.has("--json"));
	return HANDLED;
}

async function runDoctor(args: string[]): Promise<PublicCommandResult> {
	const options = parseBooleanOptions(args, new Set(["--fix", "--json"]), "doctor");
	if (!options) return HANDLED;
	if (options.has("--fix")) {
		await runReap(options.has("--json"), false);
	} else {
		await runPs(options.has("--json"));
	}
	return HANDLED;
}

async function runIncidentCommand(args: string[]): Promise<PublicCommandResult> {
	let options: IncidentCommandOptions;
	let window: IncidentWindow;
	try {
		options = parseIncidentOptions(args);
		// Resolve once: re-resolving later can cross UTC midnight and render a
		// different window than the one that was validated.
		window = resolveIncidentWindow(options, new Date());
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), `Run "${APP_NAME} help incident" for usage.`);
	}
	await runIncident(options, window);
	return HANDLED;
}

async function runShutdown(args: string[]): Promise<PublicCommandResult> {
	const options = parseBooleanOptions(args, new Set(["--force", "--json"]), "shutdown");
	if (!options) return HANDLED;
	await runShutdownAll(options.has("--json"), options.has("--force"));
	return HANDLED;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowserUrl(url: string): void {
	const [command, ...args] =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? [
						join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
						"url.dll,FileProtocolHandler",
						url,
					]
				: ["xdg-open", url];
	execFile(command, args, () => {});
}

function findTelegramLaunchSpec(): { command: string; args: string[]; cwd: string } | undefined {
	let current = dirname(fileURLToPath(import.meta.url));
	let tgPkgDir: string | undefined;
	for (let i = 0; i < 6; i++) {
		const candidate = join(current, "packages", "coding-agent-telegram");
		if (existsSync(join(candidate, "package.json"))) {
			tgPkgDir = candidate;
			break;
		}
		const sibling = join(current, "coding-agent-telegram");
		if (existsSync(join(sibling, "package.json"))) {
			tgPkgDir = sibling;
			break;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (!tgPkgDir) return undefined;

	const distMain = join(tgPkgDir, "dist", "main.js");
	if (existsSync(distMain)) {
		return { command: process.execPath, args: [distMain], cwd: tgPkgDir };
	}
	const srcMain = join(tgPkgDir, "src", "main.ts");
	const tsxCli = join(dirname(tgPkgDir), "..", "node_modules", "tsx", "dist", "cli.mjs");
	if (existsSync(srcMain) && existsSync(tsxCli)) {
		return { command: process.execPath, args: [tsxCli, srcMain], cwd: tgPkgDir };
	}
	return undefined;
}

function getTelegramRunning(gatewayInfoPath: string): { pid: number; botUsername?: string } | null {
	if (existsSync(gatewayInfoPath)) {
		try {
			const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
			if (typeof info?.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					return {
						pid: info.pid,
						botUsername: typeof info.botUsername === "string" ? info.botUsername : undefined,
					};
				} catch {}
			}
		} catch {}
	}
	return null;
}

async function stopTelegram(gatewayInfoPath: string): Promise<{ stopped: boolean; pids: number[] }> {
	const killedPids: Set<number> = new Set();

	if (existsSync(gatewayInfoPath)) {
		try {
			const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
			if (typeof info?.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					process.kill(info.pid, "SIGTERM");
					killedPids.add(info.pid);
				} catch {}
			}
		} catch {}
	}

	if (killedPids.size > 0) {
		for (let i = 0; i < 20; i++) {
			let anyAlive = false;
			for (const pid of killedPids) {
				try {
					process.kill(pid, 0);
					anyAlive = true;
				} catch {}
			}
			if (!anyAlive) break;
			await delay(100);
		}

		for (const pid of killedPids) {
			try {
				process.kill(pid, 0);
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}

	try {
		rmSync(gatewayInfoPath, { force: true });
	} catch {}

	return { stopped: killedPids.size > 0, pids: [...killedPids] };
}

function autoLoadTelegramEnv(): void {
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

async function runTelegram(args: string[]): Promise<PublicCommandResult> {
	autoLoadTelegramEnv();
	const isStop =
		args.includes("stop") ||
		args.includes("--stop") ||
		args.includes("shutdown") ||
		args.includes("--shutdown");
	const isRestart = args.includes("restart") || args.includes("--restart");
	const isStatus = args.includes("status") || args.includes("--status");

	const tokenIndex = args.indexOf("--token");
	const botToken =
		tokenIndex !== -1 && args[tokenIndex + 1]
			? args[tokenIndex + 1]
			: process.env.TELEGRAM_BOT_TOKEN;

	const userIndex = args.indexOf("--user-id");
	const userId =
		userIndex !== -1 && args[userIndex + 1]
			? args[userIndex + 1]
			: process.env.TELEGRAM_ALLOWED_USER_ID;

	const apiUrlIndex = args.indexOf("--api-url");
	const apiUrl =
		apiUrlIndex !== -1 && args[apiUrlIndex + 1]
			? args[apiUrlIndex + 1]
			: process.env.PRIME_AGENT_API_URL;

	const gatewayInfoPath = join(getAgentDir(), "prime-agent-telegram", "gateway.json");

	if (isStop) {
		const res = await stopTelegram(gatewayInfoPath);
		if (res.stopped) {
			console.log(chalk.green(`Prime Agent Telegram bot stopped (PID: ${res.pids.join(", ")}).`));
		} else {
			console.log(chalk.yellow(`Prime Agent Telegram bot is not running.`));
		}
		return HANDLED;
	}

	if (isStatus) {
		const running = getTelegramRunning(gatewayInfoPath);
		if (running) {
			console.log(
				chalk.green(
					`Prime Agent Telegram bot is running (PID: ${running.pid}${running.botUsername ? `, @${running.botUsername}` : ""}).`,
				),
			);
		} else {
			console.log(chalk.yellow(`Prime Agent Telegram bot is not running.`));
		}
		return HANDLED;
	}

	if (isRestart) {
		console.log(chalk.cyan(`Restarting Prime Agent Telegram bot...`));
		await stopTelegram(gatewayInfoPath);
		for (let i = 0; i < 20; i++) {
			if (!getTelegramRunning(gatewayInfoPath)) break;
			await delay(100);
		}
	}

	if (!botToken) {
		console.error(
			chalk.red(
				"Telegram bot token is required. Set TELEGRAM_BOT_TOKEN environment variable or pass --token <token>.",
			),
		);
		return HANDLED;
	}

	let running = isRestart ? null : getTelegramRunning(gatewayInfoPath);
	if (!running) {
		const spec = findTelegramLaunchSpec();
		if (!spec) {
			console.error(chalk.red("Could not find prime-agent-telegram package entrypoint."));
			return HANDLED;
		}

		const env: NodeJS.ProcessEnv = {
			...process.env,
			TELEGRAM_BOT_TOKEN: botToken,
			...(userId ? { TELEGRAM_ALLOWED_USER_ID: userId } : {}),
			...(apiUrl ? { PRIME_AGENT_API_URL: apiUrl } : {}),
		};

		const logDir = dirname(gatewayInfoPath);
		mkdirSync(logDir, { recursive: true });
		const logFile = openSync(join(logDir, "bot.log"), "a");

		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			detached: true,
			stdio: ["ignore", logFile, logFile],
			env,
		});
		child.unref();
	}

	let botUsername: string | undefined;
	for (let i = 0; i < 40; i++) {
		if (existsSync(gatewayInfoPath)) {
			try {
				const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
				if (info?.botUsername) {
					botUsername = info.botUsername;
					break;
				}
			} catch {}
		}
		await delay(100);
	}

	console.log(
		chalk.green(
			`Prime Agent Telegram bot started successfully${botUsername ? ` as @${botUsername}` : ""}!`,
		),
	);
	return HANDLED;
}

function findApiGatewayLaunchSpec(): { command: string; args: string[]; cwd: string } | undefined {
	let current = dirname(fileURLToPath(import.meta.url));
	let apiPkgDir: string | undefined;
	for (let i = 0; i < 6; i++) {
		const candidate = join(current, "packages", "coding-agent-api");
		if (existsSync(join(candidate, "package.json"))) {
			apiPkgDir = candidate;
			break;
		}
		const sibling = join(current, "coding-agent-api");
		if (existsSync(join(sibling, "package.json"))) {
			apiPkgDir = sibling;
			break;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (!apiPkgDir) return undefined;

	const srcMain = join(apiPkgDir, "src", "main.ts");
	const tsxCli = join(dirname(apiPkgDir), "..", "node_modules", "tsx", "dist", "cli.mjs");
	if (existsSync(srcMain) && existsSync(tsxCli)) {
		return { command: process.execPath, args: [tsxCli, srcMain], cwd: apiPkgDir };
	}
	const distMain = join(apiPkgDir, "dist", "main.js");
	if (existsSync(distMain)) {
		return { command: process.execPath, args: [distMain], cwd: apiPkgDir };
	}
	return undefined;
}

function getApiGatewayRunning(
	port: number,
	gatewayInfoPath: string,
): { pid: number; url: string; token?: string } | null {
	if (existsSync(gatewayInfoPath)) {
		try {
			const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
			if (typeof info?.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					return {
						pid: info.pid,
						url: info.url || `http://127.0.0.1:${port}`,
						token: typeof info.token === "string" ? info.token : undefined,
					};
				} catch {}
			}
		} catch {}
	}
	try {
		const output = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
			encoding: "utf8",
		}).trim();
		const pid = Number.parseInt(output.split("\n")[0] || "", 10);
		if (Number.isInteger(pid) && pid > 0) {
			return { pid, url: `http://127.0.0.1:${port}` };
		}
	} catch {}
	return null;
}

async function stopApiGateway(
	port: number,
	gatewayInfoPath: string,
): Promise<{ stopped: boolean; pids: number[] }> {
	const killedPids: Set<number> = new Set();

	if (existsSync(gatewayInfoPath)) {
		try {
			const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
			if (typeof info?.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					process.kill(info.pid, "SIGTERM");
					killedPids.add(info.pid);
				} catch {}
			}
		} catch {}
	}

	try {
		const output = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
			encoding: "utf8",
		}).trim();
		for (const line of output.split("\n")) {
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
				try {
					process.kill(pid, "SIGTERM");
					killedPids.add(pid);
				} catch {}
			}
		}
	} catch {}

	if (killedPids.size > 0) {
		for (let i = 0; i < 20; i++) {
			let anyAlive = false;
			for (const pid of killedPids) {
				try {
					process.kill(pid, 0);
					anyAlive = true;
				} catch {}
			}
			if (!anyAlive) break;
			await delay(100);
		}

		for (const pid of killedPids) {
			try {
				process.kill(pid, 0);
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}

	try {
		rmSync(gatewayInfoPath, { force: true });
	} catch {}

	return { stopped: killedPids.size > 0, pids: [...killedPids] };
}

async function runApi(args: string[]): Promise<PublicCommandResult> {
	const isStop =
		args.includes("stop") ||
		args.includes("--stop") ||
		args.includes("shutdown") ||
		args.includes("--shutdown");
	const isRestart = args.includes("restart") || args.includes("--restart");
	const isStatus = args.includes("status") || args.includes("--status");

	const portIndex = args.indexOf("--port");
	const port = Number(
		portIndex !== -1 && args[portIndex + 1]
			? args[portIndex + 1]
			: process.env.PRIME_AGENT_API_PORT || 4677,
	);
	const hostIndex = args.indexOf("--host");
	const host =
		hostIndex !== -1 && args[hostIndex + 1]
			? args[hostIndex + 1]
			: process.env.PRIME_AGENT_API_HOST || "0.0.0.0";
	const tokenIndex = args.indexOf("--token");
	const token =
		tokenIndex !== -1 && args[tokenIndex + 1]
			? args[tokenIndex + 1]
			: process.env.PRIME_AGENT_API_TOKEN;

	const gatewayInfoPath = join(getAgentDir(), "prime-agent-api", "gateway.json");

	if (isStop) {
		const res = await stopApiGateway(port, gatewayInfoPath);
		if (res.stopped) {
			console.log(chalk.green(`Prime Agent API gateway stopped (PID: ${res.pids.join(", ")}).`));
		} else {
			console.log(chalk.yellow(`Prime Agent API gateway is not running.`));
		}
		return HANDLED;
	}

	if (isStatus) {
		const running = getApiGatewayRunning(port, gatewayInfoPath);
		if (running) {
			console.log(
				chalk.green(`Prime Agent API gateway is running at ${running.url} (PID: ${running.pid}).`),
			);
			if (running.token) {
				console.log(chalk.gray(`Auth token: ${running.token}`));
			}
		} else {
			console.log(chalk.yellow(`Prime Agent API gateway is not running.`));
		}
		return HANDLED;
	}

	if (isRestart) {
		console.log(chalk.cyan(`Restarting Prime Agent API gateway...`));
		await stopApiGateway(port, gatewayInfoPath);
		for (let i = 0; i < 20; i++) {
			if (!getApiGatewayRunning(port, gatewayInfoPath)) break;
			await delay(100);
		}
	}

	const socketArgIndex = args.indexOf("--daemon-socket");
	const socketArg = socketArgIndex !== -1 ? args[socketArgIndex + 1] : undefined;
	const socketPath = normalizeSocketPath(socketArg ?? defaultDaemonSocketPath());
	try {
		await ensureInteractiveDaemonRunning(socketPath);
	} catch (error) {
		if (error instanceof Error && error.name === "StaleDaemonError") {
			// Daemon is already running
		} else {
			throw error;
		}
	}

	let running = isRestart ? null : getApiGatewayRunning(port, gatewayInfoPath);
	if (!running) {
		const spec = findApiGatewayLaunchSpec();
		if (!spec) {
			console.error(chalk.red("Could not find prime-agent-api package entrypoint."));
			return HANDLED;
		}
		const launchArgs = [...spec.args];
		if (portIndex !== -1) launchArgs.push("--port", String(port));
		if (hostIndex !== -1) launchArgs.push("--host", host);
		if (token) launchArgs.push("--token", token);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PRIME_AGENT_API_DAEMON_SOCKET: socketPath,
		};
		const child = spawn(spec.command, launchArgs, {
			cwd: spec.cwd,
			detached: true,
			stdio: "ignore",
			env,
		});
		child.unref();
	}

	let url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
	let resolvedToken: string | undefined = token;
	for (let i = 0; i < 40; i++) {
		if (existsSync(gatewayInfoPath)) {
			try {
				const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
				if (info?.url) {
					url = info.url;
					resolvedToken = info.token;
					break;
				}
			} catch {}
		}
		await delay(100);
	}

	console.log(chalk.green(`Prime Agent API gateway: ${url}`));
	if (resolvedToken) {
		console.log(chalk.gray(`Auth token: ${resolvedToken}`));
	}
	return HANDLED;
}

function findWebGatewayLaunchSpec(): { command: string; args: string[]; cwd: string } | undefined {
	let current = dirname(fileURLToPath(import.meta.url));
	let webPkgDir: string | undefined;
	for (let i = 0; i < 6; i++) {
		const candidate = join(current, "packages", "coding-agent-web");
		if (existsSync(join(candidate, "package.json"))) {
			webPkgDir = candidate;
			break;
		}
		const sibling = join(current, "coding-agent-web");
		if (existsSync(join(sibling, "package.json"))) {
			webPkgDir = sibling;
			break;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (!webPkgDir) return undefined;

	const srcMain = join(webPkgDir, "src", "main.ts");
	const tsxCli = join(dirname(webPkgDir), "..", "node_modules", "tsx", "dist", "cli.mjs");
	if (existsSync(srcMain) && existsSync(tsxCli)) {
		return { command: process.execPath, args: [tsxCli, srcMain], cwd: webPkgDir };
	}
	const distMain = join(webPkgDir, "dist", "main.js");
	if (existsSync(distMain)) {
		return { command: process.execPath, args: [distMain], cwd: webPkgDir };
	}
	return undefined;
}

function getWebGatewayRunning(
	port: number,
	gatewayInfoPath: string,
): { pid: number; url: string } | null {
	if (existsSync(gatewayInfoPath)) {
		try {
			const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
			if (typeof info?.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					return { pid: info.pid, url: info.url || `http://127.0.0.1:${port}` };
				} catch {}
			}
		} catch {}
	}
	try {
		const output = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
			encoding: "utf8",
		}).trim();
		const pid = Number.parseInt(output.split("\n")[0] || "", 10);
		if (Number.isInteger(pid) && pid > 0) {
			return { pid, url: `http://127.0.0.1:${port}` };
		}
	} catch {}
	return null;
}

async function stopWebGateway(
	port: number,
	gatewayInfoPath: string,
): Promise<{ stopped: boolean; pids: number[] }> {
	const killedPids: Set<number> = new Set();

	// 1. Check gateway.json PID
	if (existsSync(gatewayInfoPath)) {
		try {
			const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
			if (typeof info?.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					process.kill(info.pid, "SIGTERM");
					killedPids.add(info.pid);
				} catch {}
			}
		} catch {}
	}

	// 2. Check any process listening on the web port
	try {
		const output = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
			encoding: "utf8",
		}).trim();
		for (const line of output.split("\n")) {
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
				try {
					process.kill(pid, "SIGTERM");
					killedPids.add(pid);
				} catch {}
			}
		}
	} catch {}

	// 3. Poll until processes exit
	if (killedPids.size > 0) {
		for (let i = 0; i < 20; i++) {
			let anyAlive = false;
			for (const pid of killedPids) {
				try {
					process.kill(pid, 0);
					anyAlive = true;
				} catch {}
			}
			if (!anyAlive) break;
			await delay(100);
		}

		// Force-kill any lingering processes
		for (const pid of killedPids) {
			try {
				process.kill(pid, 0);
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}

	// 4. Remove gateway.json
	try {
		rmSync(gatewayInfoPath, { force: true });
	} catch {}

	return { stopped: killedPids.size > 0, pids: [...killedPids] };
}

async function runWeb(args: string[]): Promise<PublicCommandResult> {
	const isStop =
		args.includes("stop") ||
		args.includes("--stop") ||
		args.includes("shutdown") ||
		args.includes("--shutdown");
	const isRestart = args.includes("restart") || args.includes("--restart");
	const isStatus = args.includes("status") || args.includes("--status");
	const noOpen = args.includes("--no-open");

	const port = Number(process.env.PRIME_AGENT_WEB_PORT || 4677);
	const host = process.env.PRIME_AGENT_WEB_HOST || "0.0.0.0";
	const gatewayInfoPath = join(getAgentDir(), "prime-agent-web", "gateway.json");

	// Handle stop / shutdown
	if (isStop) {
		const res = await stopWebGateway(port, gatewayInfoPath);
		if (res.stopped) {
			console.log(chalk.green(`Prime Agent Web UI stopped (PID: ${res.pids.join(", ")}).`));
		} else {
			console.log(chalk.yellow(`Prime Agent Web UI is not running.`));
		}
		return HANDLED;
	}

	// Handle status
	if (isStatus) {
		const running = getWebGatewayRunning(port, gatewayInfoPath);
		if (running) {
			console.log(chalk.green(`Prime Agent Web UI is running at ${running.url} (PID: ${running.pid}).`));
		} else {
			console.log(chalk.yellow(`Prime Agent Web UI is not running.`));
		}
		return HANDLED;
	}

	// Handle restart
	if (isRestart) {
		console.log(chalk.cyan(`Restarting Prime Agent Web UI...`));
		await stopWebGateway(port, gatewayInfoPath);
		for (let i = 0; i < 20; i++) {
			if (!getWebGatewayRunning(port, gatewayInfoPath)) break;
			await delay(100);
		}
	}

	const socketArgIndex = args.indexOf("--daemon-socket");
	const socketArg = socketArgIndex !== -1 ? args[socketArgIndex + 1] : undefined;
	const socketPath = normalizeSocketPath(socketArg ?? defaultDaemonSocketPath());
	try {
		await ensureInteractiveDaemonRunning(socketPath);
	} catch (error) {
		if (error instanceof Error && error.name === "StaleDaemonError") {
			// A daemon is already running with active sessions. Web UI can attach
			// to it over protocol 7 without interrupting active work.
		} else {
			throw error;
		}
	}

	let running = isRestart ? null : getWebGatewayRunning(port, gatewayInfoPath);
	if (!running) {
		const spec = findWebGatewayLaunchSpec();
		if (spec) {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PRIME_AGENT_WEB_DAEMON_SOCKET: socketPath,
			};
			const child = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				detached: true,
				stdio: "ignore",
				env,
			});
			child.unref();
		}
	}

	let url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
	for (let i = 0; i < 40; i++) {
		if (existsSync(gatewayInfoPath)) {
			try {
				const info = JSON.parse(readFileSync(gatewayInfoPath, "utf8"));
				if (info?.url) {
					url = info.url;
					break;
				}
			} catch {}
		}
		await delay(100);
	}

	console.log(chalk.green(`Prime Agent Web UI: ${url}`));
	if (!noOpen) {
		openBrowserUrl(url);
	}
	return HANDLED;
}

async function runMcp(args: string[]): Promise<PublicCommandResult> {
	const settingsManager = SettingsManager.create(process.cwd());
	const result = await runMcpManagementCommand(args, settingsManager, AuthStorage.create());
	console.log(result.message);
	return HANDLED;
}

async function runPackage(args: string[]): Promise<PublicCommandResult> {
	const subcommand = args[0];
	if (subcommand === "uninstall") {
		return fail("Unknown package command: uninstall", `Use "${APP_NAME} package remove".`);
	}
	const children = getChildCommandSpecs(["package"]).map((spec) => spec.path.at(-1)!);
	if (!subcommand || !children.includes(subcommand)) {
		const suggestion = subcommand ? findCommandSuggestion(subcommand, children) : undefined;
		return fail(
			subcommand ? `Unknown package command: ${subcommand}` : "Missing package command.",
			suggestion ? `Did you mean "${APP_NAME} package ${suggestion}"?` : `Run "${APP_NAME} help package" for usage.`,
		);
	}
	const rest = args.slice(1);
	if (subcommand === "list" && rest.length > 0) {
		return fail(`Usage: ${APP_NAME} package list`);
	}
	if (subcommand === "update") {
		if (
			rest.some((arg) => arg === "--self" || arg === "--extensions" || arg === "--extension" || arg === "--force")
		) {
			return fail(
				'Package updates accept only an optional source. Use "prime-agent update --force" to update Prime Agent.',
			);
		}
		if (rest.length > 1) {
			return fail(`Usage: ${APP_NAME} package update [source]`);
		}
		if (rest[0] && isSelfUpdateSource(rest[0])) {
			return fail('Use "prime-agent update" to update Prime Agent.');
		}
		await handlePackageCommand(["update", ...(rest.length === 0 ? ["--extensions"] : rest)]);
		return HANDLED;
	}
	await handlePackageCommand([subcommand, ...rest]);
	return HANDLED;
}

function rewriteNestedCommand(parent: string, subcommand: string, flag: string, args: string[]): PublicCommandResult {
	if (args[0] !== subcommand) {
		const candidate = args[0];
		const suggestion = candidate ? findCommandSuggestion(candidate, [subcommand]) : undefined;
		return fail(
			candidate ? `Unknown ${parent} command: ${candidate}` : `Missing ${parent} command.`,
			suggestion
				? `Did you mean "${APP_NAME} ${parent} ${suggestion}"?`
				: `Run "${APP_NAME} help ${parent}" for usage.`,
		);
	}
	const splitArgs = splitOperandsAndOptions(args.slice(1));
	if (!splitArgs) {
		return fail(`Usage: ${APP_NAME} ${getCommandSpec([parent, subcommand])?.usage ?? `${parent} ${subcommand}`}`);
	}
	const { operands, options } = splitArgs;
	const validCount = parent === "model" ? operands.length <= 1 : operands.length >= 1 && operands.length <= 2;
	if (!validCount) {
		return fail(`Usage: ${APP_NAME} ${getCommandSpec([parent, subcommand])?.usage ?? `${parent} ${subcommand}`}`);
	}
	return continueWith([INTERNAL_RUNTIME_COMMAND_MARKER, flag, ...operands, ...options]);
}

function parseBooleanOptions(args: string[], allowed: ReadonlySet<string>, command: string): Set<string> | undefined {
	const options = new Set<string>();
	for (const arg of args) {
		if (!allowed.has(arg)) {
			fail(`Unknown option for ${command}: ${arg}`, `Run "${APP_NAME} help ${command}" for usage.`);
			return undefined;
		}
		options.add(arg);
	}
	return options;
}

function requireArgumentCount(args: string[], count: number, command: string): boolean {
	if (args.length === count) {
		return true;
	}
	fail(`Usage: ${APP_NAME} ${getCommandSpec([command])?.usage ?? command}`);
	return false;
}

function hasPositionalArguments(args: string[]): boolean {
	const parsed = parseArgs(args);
	return parsed.messages.length > 0 || parsed.fileArgs.length > 0;
}

function hasConflictingAttachOption(args: string[]): boolean {
	return args.some(
		(arg) =>
			arg === "--resume" ||
			arg === "-r" ||
			arg.startsWith("--resume=") ||
			arg === "--continue" ||
			arg === "-c" ||
			arg === "--fork",
	);
}

function splitOperandsAndOptions(args: string[]): { operands: string[]; options: string[] } | undefined {
	const optionsStart = args.findIndex((arg) => arg.startsWith("-"));
	if (optionsStart === -1) {
		return { operands: args, options: [] };
	}
	const options = args.slice(optionsStart);
	if (hasPositionalArguments(options)) {
		return undefined;
	}
	return { operands: args.slice(0, optionsStart), options };
}

function requireOperandCount(args: string[], minimum: number, maximum: number | undefined, command: string): boolean {
	const operands: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--json") {
			continue;
		}
		if (arg === "--socket" || arg === "--daemon-socket") {
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			fail(`Usage: ${APP_NAME} ${getCommandSpec([command])?.usage ?? command}`);
			return false;
		}
		operands.push(arg);
	}
	if (operands.length >= minimum && (maximum === undefined || operands.length <= maximum)) {
		return true;
	}
	fail(`Usage: ${APP_NAME} ${getCommandSpec([command])?.usage ?? command}`);
	return false;
}

function validateScheduleArgs(args: string[]): boolean {
	const subcommand = args[0];
	if (subcommand === "list") {
		let agentCount = 0;
		for (const arg of args.slice(1)) {
			if (arg === "--all" || arg === "-a" || arg === "--json") {
				continue;
			}
			if (arg.startsWith("-") || ++agentCount > 1) {
				fail(`Usage: ${APP_NAME} schedule list [--all] [agent] [--json]`);
				return false;
			}
		}
		return true;
	}
	if (subcommand === "cancel") {
		const operands = args.slice(1).filter((arg) => arg !== "--json");
		if (operands.length === 1 && !operands[0]!.startsWith("-")) {
			return true;
		}
		fail(`Usage: ${APP_NAME} ${getCommandSpec(["schedule", "cancel"])!.usage}`);
		return false;
	}
	return true;
}

function fail(message: string, hint?: string): PublicCommandResult {
	console.error(chalk.red(`Error: ${message}`));
	if (hint) {
		console.error(chalk.dim(hint));
	}
	process.exitCode = 1;
	return HANDLED;
}
