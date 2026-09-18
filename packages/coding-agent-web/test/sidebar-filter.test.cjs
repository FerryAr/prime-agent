const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/static/app.js"), "utf8");
const names = ["rosterSessionKey", "isSubagentSession", "filterSidebarSessions", "mergeRosterIntoCatalog"];
const bodies = names.map((name) => {
	const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
	assert.ok(match, `Missing frontend function: ${name}`);
	return match[0];
}).join("\n");

function load() {
	const ctx = vm.createContext({
		catalogSessions: [],
		rosterEntries: new Map(),
	});
	vm.runInContext(bodies, ctx);
	return ctx;
}

test("sidebar excludes subagent sessions from catalog and live roster", () => {
	const ctx = load();
	ctx.catalogSessions = [
		{ sessionId: "root", runtimeKind: "top-level" },
		{ sessionId: "child-catalog", runtimeKind: "subagent", rlmChildId: "child-1" },
		{ sessionId: "child-id", rlmChildId: "child-2" },
	];
	ctx.rosterEntries = new Map([
		["root", { sessionId: "root", runtimeKind: "top-level", isStreaming: true }],
		["child-live", { sessionId: "child-live", runtimeKind: "subagent", rlmChildId: "child-3" }],
	]);

	const merged = ctx.mergeRosterIntoCatalog();
	assert.deepEqual(Array.from(merged, (session) => session.sessionId), ["root"]);
	assert.equal(ctx.isSubagentSession({ runtimeKind: "subagent" }), true);
	assert.equal(ctx.isSubagentSession({ rlmChildId: "child-4" }), true);
	assert.equal(ctx.isSubagentSession({ runtimeKind: "top-level" }), false);
});
