import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listDirectory, readWorkspaceFile, resolveInsideRoot, writeWorkspaceFile } from "../src/fs.js";

function makeWorkspace(): string {
	const root = join(mkdtempSync(join(tmpdir(), "prime-agent-web-fs-")), "ws");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "README.md"), "hello");
	writeFileSync(join(root, "src", "main.ts"), "export {};");
	return root;
}

describe("workspace fs helpers", () => {
	test("resolveInsideRoot rejects escapes", () => {
		const root = makeWorkspace();
		expect(resolveInsideRoot(root, "src/main.ts").relative).toBe("src/main.ts");
		expect(() => resolveInsideRoot(root, "../outside")).toThrow();
		expect(() => resolveInsideRoot(root, "/etc/passwd")).toThrow();
		expect(() => resolveInsideRoot(root, "")).toThrow();
		expect(resolveInsideRoot(root, "", { allowRoot: true }).relative).toBe("");
	});

	test("lists directories with dirs first", async () => {
		const root = makeWorkspace();
		const { entries } = await listDirectory(root, "");
		expect(entries[0]).toMatchObject({ name: "src", type: "dir" });
		expect(entries[1]).toMatchObject({ name: "README.md", type: "file", size: 5 });
	});

	test("reads and writes inside containment", async () => {
		const root = makeWorkspace();
		const written = await writeWorkspaceFile(root, "notes/new.md", "# hi");
		expect(written.path).toBe("notes/new.md");
		const read = await readWorkspaceFile(root, "notes/new.md");
		expect(read).toMatchObject({ path: "notes/new.md", content: "# hi", truncated: false });
		await expect(writeWorkspaceFile(root, "../escape.md", "nope")).rejects.toThrow();
	});
});
