const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/static/app.js"), "utf8");

// Extract the needed functions
const names = [
	"textOf", "entryForDiff", "computeEntryDiff", "renderUnifiedDiff", "renderRefinementCard",
	"renderCompactionCard", "renderMessage", "renderMessages", "handleSessionEvent"
];

const bodies = names.map((name) => {
	const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
	assert.ok(match, `Missing frontend function: ${name}`);
	return match[0];
}).join("\n");

function harness() {
	const appendedNodes = [];
	const toolCards = new Map();
	const sideCards = new Map();
	const refinementCards = new Map();
	const toasts = [];

	const ctx = vm.createContext({
		console,
		refinementCards,
		toolCards,
		sideCards,
		run: null,
		transcript: {
			replaceChildren() { appendedNodes.length = 0; },
			querySelectorAll() { return []; },
			append(...nodes) { appendedNodes.push(...nodes); },
		},
		appendNode: (node) => { appendedNodes.push(node); },
		addTimestamp: (node, ts) => { node.dataset = node.dataset || {}; node.dataset.ts = ts; },
		scroll: () => {},
		showToast: (title, text, kind) => { toasts.push({ title, text, kind }); },
		renderMarkdownInto: (el, md) => { el.textContent = md; },
		el: (tag, cls, text) => {
			const children = [];
			const classes = new Set((cls || "").split(" ").filter(Boolean));
			return {
				tagName: tag.toUpperCase(),
				className: cls || "",
				textContent: text || "",
				children,
				dataset: {},
				get textContent() {
					return text + children.map(c => typeof c === "string" ? c : (c.textContent || "")).join(" ");
				},
				set textContent(v) { text = v; },
				append: (...items) => children.push(...items),
				remove: () => {},
				classList: {
					add(...names) { for (const n of names) classes.add(n); },
					remove(...names) { for (const n of names) classes.delete(n); },
					toggle(n, force) {
						const has = classes.has(n);
						const next = typeof force === "boolean" ? force : !has;
						if (next) classes.add(n); else classes.delete(n);
						return next;
					},
					contains(n) { return classes.has(n); },
				},
				querySelector: () => null,
			};
		},
		$: () => ({ classList: { add() {}, remove() {}, toggle() {} }, options: [] }),
	});

	vm.runInContext(bodies, ctx);
	return { ctx, appendedNodes, refinementCards, toasts };
}

test("renderRefinementCard renders global refinement with created, updated, and deleted edits", () => {
	const { ctx, appendedNodes, refinementCards } = harness();

	const sampleOutcome = {
		role: "custom",
		customType: "refinement_outcome",
		content: "Refinement complete: Refined continual harness state",
		details: {
			refinementId: "refine_test_123",
			summary: "Refined continual harness state",
			scope: "global",
			edits: [
				{
					action: "create",
					kind: "memory",
					id: "test_memory_note",
					title: "Test memory note",
					content: "Content of newly created memory",
					path: "general",
					applied: true,
				},
				{
					action: "update",
					kind: "prompt",
					id: "test_policy",
					title: "Test policy",
					applied: true,
					before: { content: "old policy rule" },
					after: { content: "new policy rule modified" },
				},
				{
					action: "delete",
					kind: "skill",
					id: "old_unused_skill",
					applied: true,
					before: { content: "deprecated skill code" },
				},
			],
		},
		timestamp: 1725900000000,
	};

	ctx.renderMessage(sampleOutcome);

	assert.equal(appendedNodes.length, 1);
	const card = appendedNodes[0];
	assert.equal(card.className.includes("refinement-card"), true);
	assert.equal(card.dataset.scope, "global");

	// Verify deduplication
	assert.equal(refinementCards.has("refine_test_123"), true);
	ctx.renderMessage(sampleOutcome);
	assert.equal(appendedNodes.length, 1, "Expected deduplicated card not to be appended twice");
});

test("renderRefinementCard handles zero edits with collapsed status", () => {
	const { ctx, appendedNodes } = harness();

	const emptyOutcome = {
		role: "custom",
		customType: "refinement_outcome",
		content: "Refinement complete: No changes",
		details: {
			refinementId: "refine_empty_456",
			summary: "No updates were necessary",
			scope: "local",
			edits: [],
		},
	};

	ctx.renderMessage(emptyOutcome);
	assert.equal(appendedNodes.length, 1);
	const card = appendedNodes[0];
	assert.equal(card.classList.contains("collapsed"), true);
});

test("handleSessionEvent handles refine_complete and refine_failed", () => {
	const { ctx, appendedNodes, toasts } = harness();

	// refine_complete
	ctx.handleSessionEvent({
		type: "refine_complete",
		result: {
			id: "refine_live_789",
			summary: "Auto-refine completed",
			scope: "local",
			appliedEdits: [
				{
					action: "create",
					kind: "memory",
					id: "auto_fact",
					applied: true,
					content: "learned fact",
				},
			],
		},
	});

	assert.equal(appendedNodes.length, 1);
	assert.equal(appendedNodes[0].className.includes("refinement-card"), true);

	// refine_failed
	ctx.handleSessionEvent({
		type: "refine_failed",
		error: "API rate limit exceeded during refinement",
	});

	assert.equal(toasts.length, 1);
	assert.equal(toasts[0].title, "Refinement failed");
	assert.equal(toasts[0].text, "API rate limit exceeded during refinement");
});

test("computeEntryDiff generates addition for create and deletion for delete", () => {
	const { ctx } = harness();

	const addDiff = ctx.computeEntryDiff(null, { title: "New Note", content: "Line 1" });
	assert.match(addDiff, /^\+/m);

	const delDiff = ctx.computeEntryDiff({ title: "Old Note" }, null);
	assert.match(delDiff, /^-/m);

	const updateDiff = ctx.computeEntryDiff("Line A\nLine B", "Line A\nLine B modified");
	assert.match(updateDiff, /^-Line B/m);
	assert.match(updateDiff, /^\+Line B modified/m);
});

test("filteredCommands includes /refine and /goal with autocomplete metadata", () => {
	const names = ["mergeBuiltins", "filteredCommands"];
	const extracted = names.map((name) => {
		const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
		assert.ok(match, `Missing frontend function: ${name}`);
		return match[0];
	}).join("\n");

	const builtinsMatch = source.match(/const BUILTIN_COMMANDS = \[([^]*?)\];/);
	assert.ok(builtinsMatch);

	const cmdCache = new Map();
	const active = { id: "test-sess" };
	const ctx = vm.createContext({
		cmdCache,
		active,
	});
	vm.runInContext(builtinsMatch[0] + "\n" + extracted, ctx);

	ctx.cmdCache.set("test-sess", ctx.mergeBuiltins([]));

	const matchRefine = ctx.filteredCommands("/ref");
	assert.equal(matchRefine.length, 1);
	assert.equal(matchRefine[0].name, "refine");
	assert.equal(matchRefine[0].description.includes("Refine continual harness"), true);
	assert.equal(matchRefine[0].argumentHint.includes("[instructions]"), true);

	const matchGoal = ctx.filteredCommands("/go");
	assert.equal(matchGoal.length, 1);
	assert.equal(matchGoal[0].name, "goal");
});

test("BUILTIN_HANDLERS.refine dispatches correctly with global and rollback flags", async () => {
	const sIdx = source.indexOf("const BUILTIN_HANDLERS = {");
	const eIdx = source.indexOf("\n};", sIdx);
	assert.ok(sIdx !== -1 && eIdx !== -1);
	const handlerCode = source.slice(sIdx, eIdx + 3);

	const apiCalls = [];
	const appended = [];
	const ctx = vm.createContext({
		active: { id: "sess-1" },
		api: async (path, opts) => {
			apiCalls.push({ path, body: JSON.parse(opts.body) });
			return { id: "refine_result_1", summary: "Refined", scope: "global", appliedEdits: [] };
		},
		renderRefinementCard: (res) => { appended.push(res); },
		setBusy: () => {},
		showTyping: () => {},
		hideTyping: () => {},
		showToast: () => {},
		appendNode: () => {},
		scroll: () => {},
		el: (tag, cls, text) => ({ tag, cls, text }),
	});

	const BUILTIN_HANDLERS = vm.runInContext("(() => {\n" + handlerCode + "\nreturn BUILTIN_HANDLERS;\n})()", ctx);

	// 1. Normal local refine
	await BUILTIN_HANDLERS.refine("remember architecture lesson");
	assert.equal(apiCalls.length, 1);
	assert.equal(apiCalls[0].path, "/api/refine");
	assert.equal(apiCalls[0].body.instructions, "remember architecture lesson");
	assert.equal(apiCalls[0].body.global, false);

	// 2. Global refine
	await BUILTIN_HANDLERS.refine("--global store cross-session fact");
	assert.equal(apiCalls.length, 2);
	assert.equal(apiCalls[1].body.instructions, "store cross-session fact");
	assert.equal(apiCalls[1].body.global, true);

	// 3. Rollback
	await BUILTIN_HANDLERS.refine("rollback refine_12345");
	assert.equal(apiCalls.length, 3);
	assert.equal(apiCalls[2].body.rollbackId, "refine_12345");
});

test("renderCompactionCard renders compaction card with token count, focus and markdown summary", () => {
	const { ctx, appendedNodes } = harness();

	const sampleCompaction = {
		role: "compactionSummary",
		summary: "## Summary of previous turns\n\nImplemented web client refinement card.",
		tokensBefore: 45200,
		customInstructions: "focus on UI tasks",
		timestamp: 1725900000000,
	};

	ctx.renderMessage(sampleCompaction);

	assert.equal(appendedNodes.length, 1);
	const card = appendedNodes[0];
	assert.equal(card.className.includes("compaction-card"), true);
	assert.equal(card.textContent.includes("45,200 TOKENS"), true);
	assert.equal(card.textContent.includes("focus: focus on UI tasks"), true);
});

test("handleSessionEvent handles compaction_start and compaction_end", () => {
	const { ctx, appendedNodes, toasts } = harness();

	ctx.handleSessionEvent({ type: "compaction_start" });
	assert.equal(toasts.length, 1);
	assert.equal(toasts[0].title, "Compacting context");

	ctx.handleSessionEvent({
		type: "compaction_end",
		result: {
			summary: "Automatic compaction summary at turn boundary",
			tokensBefore: 32000,
		},
		customInstructions: "clean context",
	});

	assert.equal(appendedNodes.length, 1);
	assert.equal(appendedNodes[0].className.includes("compaction-card"), true);
});
