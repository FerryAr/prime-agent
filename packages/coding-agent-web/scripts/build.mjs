
import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";
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
	entryPoints: [join(pkgDir, "src", "main.ts")],
	outfile: join(outdir, "main.js"),
	bundle: true,
	platform: "node",
	format: "esm",
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

mkdirSync(join(outdir, "static"), { recursive: true });
cpSync(join(pkgDir, "src", "static"), join(outdir, "static"), { recursive: true });
console.log("Built standalone bundle successfully.");
