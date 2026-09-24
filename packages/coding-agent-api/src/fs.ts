import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HttpError } from "./errors.js";

const MAX_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 2_000_000;

function relativeInside(canonicalRoot: string, candidate: string): string | undefined {
	const rel = relative(canonicalRoot, candidate);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel;
}

/**
 * Resolve a user-supplied path inside the workspace root, rejecting escapes
 * (absolute paths outside, `..`, and symlinks pointing out).
 */
export function resolveInsideRoot(
	root: string,
	requested: string,
	options: { allowRoot?: boolean } = {},
): { absolute: string; relative: string } {
	const trimmed = requested.trim();
	if (!trimmed && !options.allowRoot) throw new HttpError(400, "path is required");
	const realRoot = realpathSync(root);
	const candidate = trimmed ? resolve(realRoot, trimmed) : realRoot;
	const rel = relativeInside(realRoot, candidate);
	if (rel === undefined) throw new HttpError(403, "Path escapes the workspace");
	try {
		const real = realpathSync(candidate);
		if (relativeInside(realRoot, real) === undefined) {
			throw new HttpError(403, "Path escapes the workspace");
		}
	} catch (error) {
		if (error instanceof HttpError) throw error;
		// Missing target: the lexically resolved path is still contained.
	}
	return { absolute: candidate, relative: rel.split(sep).join("/") };
}

export async function listDirectory(
	root: string,
	relPath: string,
): Promise<{ path: string; entries: Array<{ name: string; type: "dir" | "file"; size?: number }> }> {
	const { absolute, relative } = resolveInsideRoot(root, relPath, { allowRoot: true });
	const info = await stat(absolute).catch(() => undefined);
	if (!info) throw new HttpError(404, `Not found: ${relative || "."}`);
	if (!info.isDirectory()) throw new HttpError(400, `Not a directory: ${relative || "."}`);
	const dirents = await readdir(absolute, { withFileTypes: true });
	const entries: Array<{ name: string; type: "dir" | "file"; size?: number }> = [];
	for (const dirent of dirents) {
		const childPath = join(absolute, dirent.name);
		let isDir = dirent.isDirectory();
		if (!isDir && dirent.isSymbolicLink()) {
			isDir = await stat(childPath)
				.then((info) => info.isDirectory())
				.catch(() => false);
		}
		if (isDir) {
			entries.push({ name: dirent.name, type: "dir" });
			continue;
		}
		if (!dirent.isFile()) continue;
		const size = await stat(childPath)
			.then((info) => info.size)
			.catch(() => undefined);
		entries.push({ name: dirent.name, type: "file", ...(size !== undefined ? { size } : {}) });
	}
	entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return { path: relative, entries };
}

export async function readWorkspaceFile(
	root: string,
	relPath: string,
): Promise<{ path: string; content: string; truncated: boolean } | { path: string; binary: true; size: number }> {
	const { absolute, relative } = resolveInsideRoot(root, relPath);
	const info = await stat(absolute).catch(() => undefined);
	if (!info) throw new HttpError(404, `Not found: ${relative}`);
	if (!info.isFile()) throw new HttpError(400, `Not a file: ${relative}`);
	const buffer = await readFile(absolute);
	const sample = buffer.subarray(0, 8000);
	if (sample.includes(0)) return { path: relative, binary: true, size: info.size };
	const truncated = info.size > MAX_READ_BYTES;
	return {
		path: relative,
		content: buffer.subarray(0, MAX_READ_BYTES).toString("utf8"),
		truncated,
	};
}

export async function writeWorkspaceFile(root: string, relPath: string, content: string): Promise<{ path: string }> {
	const { absolute, relative } = resolveInsideRoot(root, relPath);
	if (!relative) throw new HttpError(400, "path is required");
	const buffer = Buffer.from(content, "utf8");
	if (buffer.byteLength > MAX_WRITE_BYTES) throw new HttpError(413, "File exceeds the 2 MiB write limit");
	const realRoot = realpathSync(root);
	let ancestor = dirname(absolute);
	for (;;) {
		try {
			if (relativeInside(realRoot, realpathSync(ancestor)) === undefined) {
				throw new HttpError(403, "Path escapes the workspace");
			}
			break;
		} catch (error) {
			if (error instanceof HttpError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new HttpError(403, "Path escapes the workspace");
			ancestor = parent;
		}
	}
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, buffer);
	return { path: relative };
}

export interface GitInfo {
	available: boolean;
	status: string;
	diff: string;
	error?: string;
}

function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn("git", args, { cwd, timeout: 10_000 });
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			if (out.length > 5_000_000) child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.on("error", () => resolvePromise({ code: -1, out: "git is not available" }));
		child.on("close", (code) => resolvePromise({ code: code ?? -1, out }));
	});
}

export async function gitInfo(root: string): Promise<GitInfo> {
	const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || !inside.out.trim().startsWith("true")) {
		return { available: false, status: "", diff: "", error: "Not a git work tree" };
	}
	const status = await runGit(root, ["status", "--short"]);
	const diff = await runGit(root, ["--no-pager", "diff", "HEAD"]);
	return {
		available: true,
		status: status.out,
		diff: diff.out,
		...(status.code !== 0 || diff.code !== 0 ? { error: (status.out + diff.out).slice(0, 500) } : {}),
	};
}

export interface TerminalExecResult {
	command: string;
	output: string;
	exitCode: number;
	durationMs: number;
	cwd: string;
}

export function executeTerminalCommand(
	root: string,
	command: string,
	timeoutMs = 60000,
): Promise<TerminalExecResult> {
	const start = Date.now();
	return new Promise((resolvePromise) => {
		const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
		const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
		const child = spawn(shell, args, {
			cwd: root,
			env: { ...process.env, TERM: "xterm-256color" },
		});
		let output = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 500000) output = output.slice(-500000);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 500000) output = output.slice(-500000);
		});
		child.on("error", (err: Error) => {
			clearTimeout(timer);
			resolvePromise({
				command,
				output: output + (output ? "\n" : "") + `Error: ${err.message}`,
				exitCode: -1,
				durationMs: Date.now() - start,
				cwd: root,
			});
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			resolvePromise({
				command,
				output: killed ? output + "\n[Command timed out after " + Math.round(timeoutMs / 1000) + "s]" : output,
				exitCode: killed ? 124 : (code ?? 0),
				durationMs: Date.now() - start,
				cwd: root,
			});
		});
	});
}
