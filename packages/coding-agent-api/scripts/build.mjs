import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");
const caPkgDir = join(pkgDir, "..", "coding-agent");

const require = createRequire(join(caPkgDir, "package.json"));
const { build } = require("esbuild");

const outdir = join(pkgDir, "dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
	entryPoints: {
		index: join(pkgDir, "src", "index.ts"),
		server: join(pkgDir, "src", "server.ts"),
		main: join(pkgDir, "src", "main.ts"),
	},
	outdir,
	bundle: true,
	platform: "node",
	format: "esm",
	banner: {
		js: "import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);",
	},
	tsconfig: join(pkgDir, "tsconfig.json"),
	external: [
		"@opentelemetry/api",
		"koffi",
		"undici",
		"@silvia-odwyer/photon-node",
		"@mariozechner/clipboard",
	],
	logLevel: "warning",
});

console.log("Built prime-agent-api bundle successfully.");
