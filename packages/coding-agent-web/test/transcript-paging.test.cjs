const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/static/app.js"), "utf8");

const names = [
	"textOf", "toolGlyph", "toolCard", "isConversationalTurn", "getTurnBoundaryIndices", "renderMessage", "renderMessages", "loadEarlierMessages", "updateLoadEarlierBar"
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
	const subagentCards = new Map();

	const mockTranscript = {
		scrollHeight: 1000,
		scrollTop: 500,
		get firstChild() { return appendedNodes[0] || null; },
		replaceChildren() { appendedNodes.length = 0; },
		querySelector(sel) {
			if (sel === ".load-earlier-bar") {
				return appendedNodes.find(n => n.classList && n.classList.contains("load-earlier-bar")) || null;
			}
			return null;
		},
		querySelectorAll() { return []; },
		append(...nodes) { appendedNodes.push(...nodes); },
		insertBefore(newChild, refChild) {
			const toInsert = newChild.nodeType === 11 ? (newChild.children || []) : [newChild];
			const idx = appendedNodes.indexOf(refChild);
			if (idx !== -1) appendedNodes.splice(idx, 0, ...toInsert);
			else appendedNodes.push(...toInsert);
		}
	};

	const ctx = vm.createContext({
		console,
		document: {
			createDocumentFragment: () => {
				const fragNodes = [];
				return {
					nodeType: 11,
					append(...nodes) { fragNodes.push(...nodes); },
					get children() { return fragNodes; }
				};
			},
			createTextNode: (t) => ({ nodeType: 3, textContent: t })
		},
		TRANSCRIPT_TURN_PAGE_SIZE: 25,
		fullSessionMessages: [],
		renderedTurnCount: 0,
		totalSessionTurns: 0,
		activeMountTarget: null,
		refinementCards,
		subagentCards,
		toolCards,
		sideCards,
		run: null,
		active: { id: "test-sess-1", sessionId: "test-sess-1" },
		transcript: mockTranscript,
		appendNode: (node) => {
			if (ctx.activeMountTarget) {
				ctx.activeMountTarget.append(node);
				return;
			}
			mockTranscript.append(node);
		},
		addTimestamp: (node, ts) => { node.dataset = node.dataset || {}; node.dataset.ts = ts; },
		scroll: () => {},
		renderMarkdownInto: (el, md) => { el.textContent = md; },
		el: (tag, cls, text) => {
			const children = [];
			const classes = new Set((cls || "").split(" ").filter(Boolean));
			const node = {
				tagName: tag.toUpperCase(),
				className: cls || "",
				textContent: text || "",
				children,
				dataset: {},
				style: {},
				querySelector(s) {
					if (s === ".load-earlier-btn span") return { textContent: "" };
					if (s === ".load-earlier-info") return { textContent: "" };
					return null;
				},
				get nextSibling() {
					const idx = appendedNodes.indexOf(this);
					return idx !== -1 && idx + 1 < appendedNodes.length ? appendedNodes[idx + 1] : null;
				},
				get textContent() {
					return (text || "") + children.map(c => typeof c === "string" ? c : (c.textContent || "")).join(" ");
				},
				set textContent(v) { text = v; },
				append: (...items) => children.push(...items),
				replaceChildren: (...items) => { children.length = 0; if (items.length) children.push(...items); },
				remove() {
					const idx = appendedNodes.indexOf(node);
					if (idx !== -1) appendedNodes.splice(idx, 1);
				},
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
			return node;
		}
	});

	vm.runInContext(bodies, ctx);
	return { ctx, appendedNodes, mockTranscript };
}

test("isConversationalTurn correctly ignores tool results, tool calls, and thinking", () => {
	const { ctx } = harness();
	assert.equal(ctx.isConversationalTurn({ role: "user", content: "hello" }), true);
	assert.equal(ctx.isConversationalTurn({ role: "assistant", content: [{ type: "text", text: "hi!" }] }), true);
	assert.equal(ctx.isConversationalTurn({ role: "assistant", content: [{ type: "thinking", thinking: "deep thoughts..." }] }), false);
	assert.equal(ctx.isConversationalTurn({ role: "assistant", content: [{ type: "toolCall", id: "call1", name: "ipython" }] }), false);
	assert.equal(ctx.isConversationalTurn({ role: "toolResult", content: "ok" }), false);
});

test("renderMessages with 10 turns and 100 tool calls renders all without paging bar", () => {
	const { ctx, appendedNodes } = harness();
	const sampleMsgs = [];
	for (let i = 0; i < 10; i++) {
		sampleMsgs.push({ role: "user", content: `question ${i}` });
		for (let t = 0; t < 10; t++) {
			sampleMsgs.push({ role: "assistant", content: [{ type: "toolCall", id: `t_${i}_${t}`, name: "ipython" }] });
			sampleMsgs.push({ role: "toolResult", content: `res_${i}_${t}` });
		}
		sampleMsgs.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
	}

	ctx.renderMessages(sampleMsgs);
	// 10 user turns + 10 assistant answer turns = 20 conversational turns
	assert.equal(ctx.totalSessionTurns, 20);
	assert.equal(ctx.renderedTurnCount, 20);
	// Paging bar should NOT be shown because 20 <= 25 turns
	const hasBar = appendedNodes.some(n => n.classList?.contains("load-earlier-bar"));
	assert.equal(hasBar, false);
});

test("renderMessages with 60 turns correctly pages by conversational turns and preserves tool history", () => {
	const { ctx, appendedNodes } = harness();
	const sampleMsgs = [];
	for (let i = 0; i < 30; i++) {
		sampleMsgs.push({ role: "user", content: `prompt ${i}` });
		sampleMsgs.push({ role: "assistant", content: [{ type: "toolCall", id: `t_${i}`, name: "ipython" }] });
		sampleMsgs.push({ role: "toolResult", content: `res_${i}` });
		sampleMsgs.push({ role: "assistant", content: [{ type: "text", text: `reply ${i}` }] });
	}

	// 30 user + 30 assistant = 60 conversational turns
	ctx.renderMessages(sampleMsgs);
	assert.equal(ctx.totalSessionTurns, 60);
	assert.equal(ctx.renderedTurnCount, 25);
	assert.equal(appendedNodes.some(n => n.classList?.contains("load-earlier-bar")), true);

	// Load earlier turns
	ctx.loadEarlierMessages();
	assert.equal(ctx.renderedTurnCount, 50);

	// Load remaining earlier turns
	ctx.loadEarlierMessages();
	assert.equal(ctx.renderedTurnCount, 60);
	assert.equal(appendedNodes.some(n => n.classList?.contains("load-earlier-bar")), false);
});
