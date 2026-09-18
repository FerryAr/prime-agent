const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/static/app.js"), "utf8");

const names = [
	"textOf", "toolGlyph", "formatSubagentStatusLabel", "renderSubagentActivity", "updateSubagentMetaDetails",
	"renderSubagentMessagesList", "openSubagentHistoryModal", "loadSubagentMessages",
	"updateExistingSubagentCard", "renderSubagentCard", "renderMessage", "renderMessages"
];

const bodies = names.map((name) => {
	const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
	assert.ok(match, `Missing frontend function: ${name}`);
	return match[0];
}).join("\n");

function harness(apiMock) {
	const appendedNodes = [];
	const toolCards = new Map();
	const sideCards = new Map();
	const refinementCards = new Map();
	const subagentCards = new Map();
	let modalOpened = null;

	const ctx = vm.createContext({
		console,
		refinementCards,
		subagentCards,
		toolCards,
		sideCards,
		run: null,
		activeMountTarget: null,
		active: { id: "test-sess-1", sessionId: "test-sess-1" },
		transcript: {
			replaceChildren() { appendedNodes.length = 0; },
			querySelectorAll() { return []; },
			append(...nodes) { appendedNodes.push(...nodes); },
			insertBefore(newChild, refChild) {
				const idx = appendedNodes.indexOf(refChild);
				if (idx !== -1) appendedNodes.splice(idx, 0, newChild);
				else appendedNodes.push(newChild);
			},
		},
		appendNode: (node) => { appendedNodes.push(node); },
		addTimestamp: (node, ts) => { node.dataset = node.dataset || {}; node.dataset.ts = ts; },
		scroll: () => {},
		api: apiMock || (async () => ({ messages: [] })),
		openModal: ({ title, message, build }) => {
			const bodyNodes = [];
			const actionNodes = [];
			build(
				{ append(...nodes) { bodyNodes.push(...nodes); }, replaceChildren() { bodyNodes.length = 0; } },
				{ append(...nodes) { actionNodes.push(...nodes); }, replaceChildren() { actionNodes.length = 0; } },
				() => {}
			);
			modalOpened = { title, message, bodyNodes, actionNodes };
		},
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
				style: {},
				get textContent() {
					return (text || "") + children.map(c => typeof c === "string" ? c : (c.textContent || "")).join(" ");
				},
				set textContent(v) { text = v; },
				append: (...items) => children.push(...items),
				replaceChildren: (...items) => { children.length = 0; if (items.length) children.push(...items); },
				insertBefore: (newItem, refItem) => {
					const idx = children.indexOf(refItem);
					if (idx !== -1) children.splice(idx, 0, newItem);
					else children.push(newItem);
				},
				remove: () => {},
				classList: {
					add(...names) { for (const n of names) classes.add(n); },
					remove(...names) { for (const n of names) classes.delete(n); },
					contains(n) { return classes.has(n); },
					toggle(n, force) {
						const has = classes.has(n);
						const next = typeof force === "boolean" ? force : !has;
						if (next) classes.add(n); else classes.delete(n);
						return next;
					}
				}
			};
		}
	});

	vm.runInContext(bodies, ctx);
	return { ctx, appendedNodes, subagentCards, toolCards, getModal: () => modalOpened };
}

test("renderSubagentCard renders card collapsed by default with history button", () => {
	const { ctx, appendedNodes, subagentCards } = harness();
	const card = ctx.renderSubagentCard({
		id: "sub-worker-1",
		sessionName: "api-auditor",
		label: "Audit API authentication endpoints",
		status: "running",
		model: "9router/ag/gemini-3.8-flash-high"
	});

	assert.ok(card, "Card should be created");
	assert.ok(card.classList.contains("collapsed"), "Subagent card MUST be collapsed by default");
	assert.ok(card.classList.contains("subagent-card"), "Must have subagent-card class");
	assert.equal(subagentCards.size, 1);

	const cardRef = subagentCards.get("sub-worker-1");
	assert.equal(cardRef.statusTag.textContent, "● RUNNING");
	assert.ok(cardRef.toggleHistoryBtn, "Must have toggleHistoryBtn");
	assert.ok(cardRef.historyContent, "Must have historyContent container");
	assert.ok(cardRef.historyContent.classList.contains("collapsed"), "History content must be collapsed by default");
});

test("toolResult with RLMSpawnHandle automatically creates subagent card right at that turn", () => {
	const { ctx, appendedNodes, subagentCards, toolCards } = harness();

	const mockToolCallId = "call-spawn-1";
	const toolCardNode = ctx.el("div", "card");
	toolCards.set(mockToolCallId, {
		root: toolCardNode,
		out: { textContent: "" },
		status: { textContent: "", className: "" }
	});
	appendedNodes.push(toolCardNode);

	ctx.renderMessage({
		role: "toolResult",
		toolCallId: mockToolCallId,
		timestamp: Date.now(),
		content: "RLMSpawnHandle(rlm_child_id='sub-spawned-chronological', name='fast-worker', session_dir=PosixPath('/tmp/sub'), model='gemini')\n"
	});

	assert.equal(subagentCards.size, 1);
	const subRef = subagentCards.get("sub-spawned-chronological");
	assert.ok(subRef, "Subagent card should be created right at the spawn tool result");
	assert.equal(subRef.name, "fast-worker");
	assert.equal(subRef.statusTag.textContent, "● RUNNING");
});
