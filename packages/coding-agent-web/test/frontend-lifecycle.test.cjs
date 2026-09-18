const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/static/app.js"), "utf8");
const names = [
	"textOf", "closeRosterStream", "connectRosterStream", "closeSessionEventStream", "openSessionEventStream",
	"ensureRun", "thinkingBlock", "queueThinkingPaint", "closeThinking", "assistantBubble", "appendAssistantDelta",
	"flushAssistantMarkdown", "handleSessionEvent",
	"hydrateStreamingMessage", "applySessionSnapshot", "attach", "refreshModelPicker", "resync", "renderMessages",
	"loadEarlierMessages", "updateLoadEarlierBar", "isConversationalTurn", "getTurnBoundaryIndices",
	"updateConnectionStatus", "sessionIdentity", "sessionIsWorking", "isCurrentActiveSession", "checkBackgroundSessionCompletions",
	"renderGoalBanner",
];
// Exercise the shipped functions without booting the unrelated DOM controls.
const bodies = names.map((name) => {
	const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
	assert.ok(match, `Missing frontend function: ${name}`);
	return match[0];
}).join("\n");

function harness() {
	const timers = new Map();
	let timerId = 0;
	const sources = [];
	const calls = [];
	const models = new Map();
	const snapshots = new Map();
	const elements = new Map();
	const ctx = vm.createContext({
		console, encodeURIComponent,
		TRANSCRIPT_TURN_PAGE_SIZE: 25,
		fullSessionMessages: [],
		renderedTurnCount: 0,
		totalSessionTurns: 0,
		activeMountTarget: null,
		document: {
			visibilityState: "visible",
			createTextNode: (text) => ({ data: text || "" }),
			createDocumentFragment: () => ({
				append(...nodes) {},
			}),
		},
		$: (id) => {
			if (!elements.has(id)) {
				const classes = new Set();
				elements.set(id, {
					id,
					style: {},
					textContent: "",
					className: "",
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
					replaceChildren() {},
					append() {},
				});
			}
			return elements.get(id);
		},
		token: "", active: null, rosterEs: null, rosterReconnectTimer: undefined,
		previousSessionWorkingState: new Map(),
		sessionReconnectTimer: undefined, lastSessionEventAt: Date.now(), thinkingPaintQueued: false,
		rosterLastEventId: "", modelCache: [], toolCards: new Map(), sideCards: new Map(), run: null, busy: false,
		activeRetry: null, lastStopAt: 0, notifications: [], typingEl: null,
		notifyDone: (text, title) => { ctx.notifications.push(text); calls.push({ notifyTitle: title, text }); },
		showToast: (title, body, kind) => { calls.push({ toast: { title, body, kind } }); },
		addTimestamp: () => {},
		appendNode: () => {},
		renderMarkdownInto: () => {},
		el: (tag, cls, text) => {
			const children = [];
			return {
				tagName: tag.toUpperCase(),
				className: cls || "",
				textContent: text || "",
				children,
				append: (...items) => children.push(...items),
				remove: () => {},
				classList: { add() {}, remove() {}, toggle() {} },
				querySelector: () => null,
			};
		},
		transcript: {
			replaceChildren() {},
			querySelectorAll() { return []; },
			append() {},
			insertBefore() {},
		}, renderMessage() {}, scroll() {},
		requestAnimationFrame: (fn) => fn(),
		setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
		clearTimeout: (id) => timers.delete(id),
		EventSource: class {
			constructor(url) { this.url = url; this.closed = false; sources.push(this); }
			close() { this.closed = true; }
		},
		setConn: (ok) => calls.push(ok), handleEvent: (event) => calls.push(event),
		hideTyping() {}, setWelcome() {}, setBusy(v) { ctx.busy = v; }, refreshHeader() {}, refreshThinkingPicker() {},
		closeModelMenu() {}, highlightSession() {}, loadCommands() {}, showTyping() {},
		promoteSidebarSession() {}, refreshSessions: async () => {},
		freshRun() {
			return {
				assistant: null, thinking: null,
				assistantRaw: "", renderedAt: 0, streamingRendered: false,
				thinkingRaw: "", thinkingRenderedAt: 0, thinkingText: null, thinkingPending: "",
			};
		},
		api: (url) => new Promise((resolve) => {
			(url.startsWith("/api/models") ? models : snapshots).set(url, resolve);
		}),
	});
	vm.runInContext(bodies, ctx);
	return { ctx, timers, sources, calls, models, snapshots };
}

test("stale roster callbacks cannot close or mutate the replacement stream", () => {
	const { ctx, sources, timers, calls } = harness();
	ctx.connectRosterStream();
	const first = sources.at(-1);
	const oldError = first.onerror, oldMessage = first.onmessage, oldOpen = first.onopen;
	ctx.connectRosterStream();
	const second = sources.at(-1);
	oldError();
	oldMessage({ data: "{}", lastEventId: "stale" });
	oldOpen();
	assert.equal(first.closed, true);
	assert.equal(first.onerror, null);
	assert.equal(second.closed, false);
	assert.equal(ctx.rosterEs, second);
	assert.equal(timers.size, 0);
	assert.equal(calls.length, 0);
	assert.equal(ctx.rosterLastEventId, "");
});

test("hiding the roster cancels reconnect and does not open a hidden stream", () => {
	const { ctx, sources, timers } = harness();
	ctx.connectRosterStream();
	sources.at(-1).onerror();
	assert.equal(timers.size, 1);
	ctx.document.visibilityState = "hidden";
	ctx.closeRosterStream();
	assert.equal(timers.size, 0);
	assert.equal(ctx.rosterReconnectTimer, undefined);
	ctx.connectRosterStream();
	assert.equal(ctx.rosterEs, null);
	assert.equal(sources.length, 1);
});

test("overlapping attaches retain only the current model catalog and session stream", async () => {
	const { ctx, sources, calls, models } = harness();
	const a = ctx.attach({ activeSessionId: "a", state: {}, messages: [] });
	const b = ctx.attach({ activeSessionId: "b", state: {}, messages: [] });
	models.get("/api/models?sessionId=b")({ models: ["b"] });
	await b;
	const bStream = ctx.active.es;
	models.get("/api/models?sessionId=a")({ models: ["a"] });
	await a;
	assert.equal(ctx.active.id, "b");
	assert.equal(ctx.active.es, bStream);
	assert.deepEqual(ctx.modelCache, ["b"]);
	assert.equal(sources.filter((stream) => !stream.closed).length, 1);

	const staleError = bStream.onerror, staleMessage = bStream.onmessage, staleOpen = bStream.onopen;
	const c = ctx.attach({ activeSessionId: "c", state: {}, messages: [] });
	const count = calls.length;
	staleError();
	staleMessage({ data: "{}" });
	staleOpen();
	assert.equal(calls.length, count);
	assert.equal(bStream.closed, true);
	assert.equal(bStream.onmessage, null);

	// Returning home clears active while the model request is still pending.
	ctx.active = null;
	models.get("/api/models?sessionId=c")({ models: ["c"] });
	await c;
	assert.equal(sources.filter((stream) => !stream.closed).length, 0);
});

test("stale resync cannot repaint a replacement session", async () => {
	const { ctx, snapshots } = harness();
	ctx.active = { id: "old" };
	const sync = ctx.resync();
	ctx.active = { id: "new" };
	let headerCalls = 0;
	ctx.refreshHeader = () => headerCalls++;
	snapshots.get("/api/state?sessionId=old")({ state: {}, messages: [] });
	await sync;
	assert.equal(headerCalls, 0);
});

test("replacing the transcript releases side-question card references", () => {
	const { ctx } = harness();
	ctx.sideCards.set("old", {});
	ctx.renderMessages([]);
	assert.equal(ctx.sideCards.size, 0);
});

test("attaching to in-flight session hydrates streamingMessage and sets busy and run", async () => {
	const { ctx, models } = harness();
	let toolCardsCreated = 0;
	let typingShown = false;
	ctx.toolCard = () => { toolCardsCreated++; return {}; };
	ctx.thinkingBlock = () => ({ append() {} });
	ctx.assistantBubble = () => {
		const b = { classList: { add() {} } };
		return b;
	};
	ctx.renderMarkdownInto = () => {};
	ctx.showTyping = () => { typingShown = true; };
	ctx.scroll = () => {};

	const snap = {
		activeSessionId: "stream-sess",
		state: { isStreaming: true },
		messages: [{ role: "user", content: "hello" }],
		streamingMessage: {
			role: "assistant",
			timestamp: Date.now(),
			content: [
				{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
				{ type: "thinking", thinking: "pondering..." },
				{ type: "text", text: "partial response" },
			],
		},
		streamSequence: 4,
	};
	const attachPromise = ctx.attach(snap);
	models.get("/api/models?sessionId=stream-sess")({ models: [] });
	await attachPromise;

	assert.equal(ctx.busy, true);
	assert.equal(typingShown, true);
	assert.ok(ctx.run);
	assert.equal(ctx.run.assistantRaw, "partial response");
	assert.equal(ctx.run.streamingRendered, true);
	assert.equal(toolCardsCreated, 1);
});

test("session stream error triggers reconnect through /api/session", async () => {
	const { ctx, sources, timers, snapshots, models } = harness();
	const snap = { activeSessionId: "s1", state: {}, messages: [] };
	const attachPromise = ctx.attach(snap);
	models.get("/api/models?sessionId=s1")({ models: [] });
	await attachPromise;

	const es1 = ctx.active.es;
	assert.equal(es1.closed, false);

	// Error triggers disconnect and schedules reconnect timer
	es1.onerror();
	assert.equal(ctx.active.es, null);
	assert.equal(timers.size, 1);

	// Trigger reconnect timer
	const [timerId, timerFn] = [...timers.entries()][0];
	timers.delete(timerId);
	const reconnecting = timerFn();

	// /api/session resolves with refreshed snapshot
	const resolveSession = snapshots.get("/api/session");
	assert.ok(resolveSession, "Expected reconnect to call /api/session");
	resolveSession({ activeSessionId: "s1", streamSequence: 5, state: {}, messages: [] });
	await reconnecting;

	assert.ok(ctx.active.es, "Expected new EventSource to be opened");
	assert.notEqual(ctx.active.es, es1);
	assert.equal(sources.at(-1), ctx.active.es);
});

test("thinking transition resets run.assistant and creates a separate bubble for regular response", () => {
	const { ctx } = harness();
	const appended = [];
	ctx.el = (tag, cls, text) => {
		const children = [];
		const elObj = {
			tagName: tag.toUpperCase(),
			className: cls || "",
			textContent: text || "",
			children,
			append: (...items) => children.push(...items),
			classList: {
				add(c) { this[c] = true; },
				remove(c) { delete this[c]; },
				toggle(c) { this[c] = !this[c]; },
			},
			querySelector() {
				return null;
			},
		};
		return elObj;
	};
	ctx.addTimestamp = () => {};
	ctx.appendNode = (node) => appended.push(node);
	ctx.scroll = () => {};
	ctx.renderMarkdownInto = (node, text) => { node.textContent = text; };

	// 1. Start agent turn
	ctx.handleSessionEvent({ type: "agent_start" });
	assert.ok(ctx.run);

	// 2. Initial text bubble before thinking
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Before thought. " },
	});
	const firstBubble = ctx.run.assistant;
	assert.ok(firstBubble);
	assert.equal(appended.includes(firstBubble), true);

	// 3. Thinking starts
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start" },
	});
	// Assistant must be flushed and reset
	assert.equal(ctx.run.assistant, null);

	// 4. Thinking deltas arrive
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "pondering problem" },
	});
	const thinkingBox = ctx.run.thinking;
	assert.ok(thinkingBox);
	assert.equal(appended.includes(thinkingBox), true);

	// 5. Regular response arrives after thinking
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "After thought answer." },
	});
	// Thinking must be closed and a completely NEW assistant bubble created
	assert.equal(ctx.run.thinking, null);
	const secondBubble = ctx.run.assistant;
	assert.ok(secondBubble);
	assert.notEqual(secondBubble, firstBubble, "Expected a new bubble after thinking, not reusing the pre-thinking bubble");
	assert.equal(secondBubble.className.includes("bubble assistant"), true);
});

test("tool_execution_start closes active thinking block", () => {
	const { ctx } = harness();
	ctx.el = (tag, cls, text) => ({
		className: cls || "",
		children: [],
		append() {},
		classList: { toggle() {} },
		querySelector() { return null; },
	});
	ctx.addTimestamp = () => {};
	ctx.appendNode = () => {};
	ctx.scroll = () => {};
	ctx.renderMarkdownInto = () => {};
	ctx.toolCard = () => ({});

	ctx.handleSessionEvent({ type: "agent_start" });
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start" },
	});
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "planning tool call" },
	});
	assert.ok(ctx.run.thinking);

	// Tool execution starts -> must close thinking block
	ctx.handleSessionEvent({
		type: "tool_execution_start",
		toolCallId: "tool-1",
		toolName: "bash",
		args: { command: "pwd" },
	});
	assert.equal(ctx.run.thinking, null);
	assert.equal(ctx.run.assistant, null);
});

test("agent_end with error stopReason or errorMessage does not trigger notifyDone", () => {
	const { ctx } = harness();
	ctx.handleSessionEvent({ type: "agent_start" });
	assert.equal(ctx.busy, true);
	assert.ok(ctx.run);

	// Assistant turn fails with error during thinking/execution
	ctx.handleSessionEvent({
		type: "agent_end",
		messages: [
			{ role: "user", content: "do something" },
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "Rate limited / connection error",
				content: [{ type: "thinking", thinking: "trying..." }],
			},
		],
	});

	assert.equal(ctx.busy, false);
	assert.equal(ctx.run, null);
	assert.equal(ctx.notifications.length, 0, "notifyDone must NOT be called on error turns");
});

test("auto_retry_start sets activeRetry and maintains busy state", () => {
	const { ctx } = harness();
	ctx.handleSessionEvent({ type: "agent_start" });
	
	// Error ends turn
	ctx.handleSessionEvent({
		type: "agent_end",
		messages: [
			{ role: "assistant", stopReason: "error", errorMessage: "502 Bad Gateway" },
		],
	});
	assert.equal(ctx.notifications.length, 0);

	// auto_retry_start arrives immediately after
	ctx.handleSessionEvent({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 2000,
		errorMessage: "502 Bad Gateway",
	});

	assert.equal(ctx.busy, true);
	assert.ok(ctx.activeRetry);
	assert.equal(ctx.activeRetry.attempt, 1);
	assert.equal(ctx.activeRetry.maxAttempts, 3);
	assert.equal(ctx.notifications.length, 0);
});

test("retry loop does not ring repeated chimes and only notifies on eventual success", () => {
	const { ctx } = harness();
	let typingCount = 0;
	ctx.showTyping = () => { typingCount++; };

	// 1. Initial attempt starts
	ctx.handleSessionEvent({ type: "agent_start" });
	ctx.handleSessionEvent({ type: "turn_start" });
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start" },
	});
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "attempt 1 thinking..." },
	});

	// 2. Attempt 1 fails during thinking
	ctx.handleSessionEvent({
		type: "agent_end",
		messages: [
			{ role: "user", content: "help" },
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "Connection dropped",
				content: [{ type: "thinking", thinking: "attempt 1 thinking..." }],
			},
		],
	});
	assert.equal(ctx.notifications.length, 0, "No chime on attempt 1 failure");

	// 3. Retry 1 begins
	ctx.handleSessionEvent({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 2,
		delayMs: 1000,
		errorMessage: "Connection dropped",
	});
	assert.equal(ctx.busy, true);
	assert.equal(ctx.notifications.length, 0, "No chime on retry start");

	// 4. Retry turn starts
	ctx.handleSessionEvent({ type: "turn_start" });
	assert.equal(ctx.busy, true);
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start" },
	});
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "attempt 2 thinking..." },
	});
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Success answer!" },
	});

	// 5. Retry ends successfully
	ctx.handleSessionEvent({
		type: "auto_retry_end",
		success: true,
		attempt: 1,
	});
	assert.equal(ctx.activeRetry, null);

	ctx.handleSessionEvent({
		type: "agent_end",
		messages: [
			{ role: "user", content: "help" },
			{
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "attempt 2 thinking..." },
					{ type: "text", text: "Success answer!" },
				],
			},
		],
	});

	assert.equal(ctx.notifications.length, 1, "Expected exactly ONE notification upon successful completion");
	assert.equal(ctx.notifications[0], "Success answer!");
});

test("auto_retry_end on final failure emits toast and never plays done chime", () => {
	const { ctx, calls } = harness();
	ctx.handleSessionEvent({ type: "agent_start" });
	ctx.handleSessionEvent({
		type: "auto_retry_start",
		attempt: 3,
		maxAttempts: 3,
		delayMs: 1000,
		errorMessage: "Permanent quota exhaustion",
	});

	ctx.handleSessionEvent({
		type: "auto_retry_end",
		success: false,
		attempt: 3,
		finalError: "Exceeded max retries (3/3)",
	});

	assert.equal(ctx.activeRetry, null);
	assert.equal(ctx.notifications.length, 0, "No finish chime on failed retries");
	const toastCall = calls.find((c) => c.toast && c.toast.title === "Retry failed");
	assert.ok(toastCall, "Expected error toast on retry failure");
	assert.equal(toastCall.toast.kind, "error");
});

test("session stream reconnect forces snapshot application when server resets streamSequence to 0", async () => {
	const { ctx, sources, timers, snapshots, models } = harness();
	let renderedMessagesCount = 0;
	ctx.renderMessages = (msgs) => { renderedMessagesCount = msgs.length; };

	// Initial session had streamSequence 20 and 1 message
	const snap = { activeSessionId: "s1", streamSequence: 20, state: {}, messages: [{ role: "user", content: "first" }] };
	const attachPromise = ctx.attach(snap);
	models.get("/api/models?sessionId=s1")({ models: [] });
	await attachPromise;

	assert.equal(ctx.active.snapshotSequence, 20);
	assert.equal(renderedMessagesCount, 1);

	const es1 = ctx.active.es;
	// Web server restarts in terminal -> stream errors
	es1.onerror();
	assert.equal(ctx.active.es, null);
	assert.equal(timers.size, 1);

	// Trigger reconnect timer
	const [timerId, timerFn] = [...timers.entries()][0];
	timers.delete(timerId);
	const reconnecting = timerFn();

	// Newly restarted server returns streamSequence 0 with 2 messages
	const resolveSession = snapshots.get("/api/session");
	assert.ok(resolveSession);
	resolveSession({
		activeSessionId: "s1",
		streamSequence: 0,
		state: {},
		messages: [{ role: "user", content: "first" }, { role: "assistant", content: "second" }],
	});
	await reconnecting;

	// Sequence must be adopted as 0 and all messages rendered!
	assert.equal(ctx.active.snapshotSequence, 0);
	assert.equal(renderedMessagesCount, 2, "Reconnected snapshot must be applied and render new messages");
	assert.ok(ctx.active.es, "New EventSource must be opened");
	assert.notEqual(ctx.active.es, es1);
});

test("if /api/session fails during reconnect, it retries /api/session instead of opening raw event stream", async () => {
	const { ctx, sources, timers, snapshots, models } = harness();
	let rejectSession;
	// Custom api mock that allows rejecting /api/session
	ctx.api = (url) => new Promise((resolve, reject) => {
		if (url.startsWith("/api/models")) models.set(url, resolve);
		else {
			rejectSession = reject;
			snapshots.set(url, resolve);
		}
	});

	const snap = { activeSessionId: "s1", state: {}, messages: [] };
	const attachPromise = ctx.attach(snap);
	models.get("/api/models?sessionId=s1")({ models: [] });
	await attachPromise;

	const es1 = ctx.active.es;
	es1.onerror();
	assert.equal(timers.size, 1);

	// Trigger first reconnect attempt while server is still booting
	const [timerId1, timerFn1] = [...timers.entries()][0];
	timers.delete(timerId1);
	const reconnecting1 = timerFn1();

	// /api/session fails with NetworkError / connection refused
	assert.ok(rejectSession);
	rejectSession(new Error("Failed to fetch"));
	await reconnecting1;

	// Must NOT open raw EventSource when /api/session failed!
	assert.equal(ctx.active.es, null, "Must not open EventSource if session setup failed");
	// Must have scheduled another retry timer!
	assert.equal(timers.size, 1, "Must schedule another reconnect retry");

	// Trigger second reconnect attempt when server is up
	const [timerId2, timerFn2] = [...timers.entries()][0];
	timers.delete(timerId2);
	const reconnecting2 = timerFn2();

	const resolveSession = snapshots.get("/api/session");
	assert.ok(resolveSession);
	resolveSession({ activeSessionId: "s1", streamSequence: 1, state: {}, messages: [] });
	await reconnecting2;

	assert.ok(ctx.active.es, "EventSource opened successfully after server recovered");
});

test("checkBackgroundSessionCompletions emits notification when background session finishes", () => {
	const { ctx, calls } = harness();
	ctx.active = { id: "session-foreground", sessionId: "fg-1" };

	// 1. Initial observation: session-bg is working
	ctx.checkBackgroundSessionCompletions([
		{ id: "session-foreground", sessionId: "fg-1", isStreaming: true, isSessionActive: true },
		{ id: "session-bg", sessionId: "bg-1", name: "Refactor Database", isStreaming: true, isSessionActive: true },
	]);
	assert.equal(ctx.notifications.length, 0, "No notification on first observation of working state");

	// 2. Second observation: session-bg has finished working (idle)
	ctx.checkBackgroundSessionCompletions([
		{ id: "session-foreground", sessionId: "fg-1", isStreaming: true, isSessionActive: true },
		{ id: "session-bg", sessionId: "bg-1", name: "Refactor Database", isStreaming: false, isSessionActive: false },
	]);

	assert.equal(ctx.notifications.length, 1, "Expected notification for background session finish");
	const notifyCall = calls.find((c) => c.notifyTitle && c.notifyTitle.includes("Refactor Database"));
	assert.ok(notifyCall, "Expected notification title to mention background session name");
	assert.equal(notifyCall.notifyTitle, "Agent finished: Refactor Database");

	// 3. Subsequent check while still idle does not notify again
	ctx.checkBackgroundSessionCompletions([
		{ id: "session-foreground", sessionId: "fg-1", isStreaming: true, isSessionActive: true },
		{ id: "session-bg", sessionId: "bg-1", name: "Refactor Database", isStreaming: false, isSessionActive: false },
	]);
	assert.equal(ctx.notifications.length, 1, "Notification must not repeat for already idle session");
});

test("checkBackgroundSessionCompletions ignores foreground active session transition", () => {
	const { ctx } = harness();
	ctx.active = { id: "active-1", sessionId: "sess-1" };

	// 1. Initial state: active session is working
	ctx.checkBackgroundSessionCompletions([
		{ id: "active-1", sessionId: "sess-1", isStreaming: true, isSessionActive: true },
	]);

	// 2. Active session becomes idle
	ctx.checkBackgroundSessionCompletions([
		{ id: "active-1", sessionId: "sess-1", isStreaming: false, isSessionActive: false },
	]);

	// Foreground session notification is handled via agent_end, not checkBackgroundSessionCompletions
	assert.equal(ctx.notifications.length, 0, "Active session should not trigger background notification");
});

test("agent_end with toolUse stopReason (intermediate tool calling turn) does NOT chime", () => {
	const { ctx } = harness();
	ctx.handleSessionEvent({ type: "agent_start" });
	ctx.handleSessionEvent({ type: "turn_start" });
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start" },
	});
	ctx.handleSessionEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "planning tool call..." },
	});

	// agent_end arrives for an intermediate tool-calling turn
	ctx.handleSessionEvent({
		type: "agent_end",
		messages: [
			{ role: "user", content: "do something" },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "thinking", thinking: "planning tool call..." },
					{ type: "toolCall", id: "t1", name: "ctx_shell", arguments: { command: "ls" } },
				],
			},
		],
	});

	assert.equal(ctx.notifications.length, 0, "No completion chime for intermediate tool calling turn");
});

test("renderGoalBanner hides banner when goal is idle or missing", () => {
	const { ctx } = harness();
	const banner = ctx.$("goalBanner");
	const chip = ctx.$("goalChip");

	ctx.renderGoalBanner(null);
	assert.equal(banner.classList.contains("hidden"), true);
	assert.equal(chip.classList.contains("hidden"), true);

	ctx.renderGoalBanner({ active: false, status: "idle" });
	assert.equal(banner.classList.contains("hidden"), true);
	assert.equal(chip.classList.contains("hidden"), true);
});

test("renderGoalBanner displays active goal objective, status badge, and token stats", () => {
	const { ctx } = harness();
	const banner = ctx.$("goalBanner");
	const chip = ctx.$("goalChip");
	const statusBadge = ctx.$("goalStatusBadge");
	const objectiveEl = ctx.$("goalObjective");
	const pauseBtn = ctx.$("goalPauseBtn");
	const pauseLabel = ctx.$("goalPauseLabel");
	const tokensVal = ctx.$("goalTokensValue");
	const progressRow = ctx.$("goalProgressRow");
	const progressBar = ctx.$("goalProgressBar");
	const timeVal = ctx.$("goalTimeValue");
	const turnsVal = ctx.$("goalTurnsValue");

	const goal = {
		active: true,
		status: "active",
		objective: "Implement attractive goal UI",
		tokenBudget: 50000,
		tokensUsed: 12500,
		timeUsedSeconds: 45,
		continuationsUsed: 3,
	};

	ctx.renderGoalBanner(goal);

	assert.equal(banner.classList.contains("hidden"), false);
	assert.equal(chip.classList.contains("hidden"), false);
	assert.equal(statusBadge.textContent, "ACTIVE");
	assert.equal(statusBadge.className.includes("status-active"), true);
	assert.equal(pauseLabel.textContent, "Pause");
	assert.equal(tokensVal.textContent.includes("12,500"), true);
	assert.equal(timeVal.textContent, "45s");
	assert.equal(turnsVal.textContent, "3");
	assert.equal(progressRow.classList.contains("hidden"), false);
	assert.equal(progressBar.style.width, "25%");
});

test("renderGoalBanner adapts for paused status and resume button", () => {
	const { ctx } = harness();
	const banner = ctx.$("goalBanner");
	const statusBadge = ctx.$("goalStatusBadge");
	const pauseLabel = ctx.$("goalPauseLabel");

	const goal = {
		active: false,
		status: "paused",
		objective: "Paused task objective",
		tokensUsed: 500,
	};

	ctx.renderGoalBanner(goal);

	assert.equal(banner.classList.contains("hidden"), false);
	assert.equal(banner.classList.contains("paused"), true);
	assert.equal(statusBadge.textContent, "PAUSED");
	assert.equal(statusBadge.className.includes("status-paused"), true);
	assert.equal(pauseLabel.textContent, "Resume");
});

test("renderGoalBanner adapts for error status with Restart button and error display", () => {
	const { ctx } = harness();
	const banner = ctx.$("goalBanner");
	const statusBadge = ctx.$("goalStatusBadge");
	const pauseLabel = ctx.$("goalPauseLabel");
	const pauseBtn = ctx.$("goalPauseBtn");
	const errorBox = ctx.$("goalErrorBox");
	const errorText = ctx.$("goalErrorText");

	const goal = {
		active: false,
		status: "error",
		objective: "Fix critical bug",
		tokensUsed: 1200,
		lastError: "Model execution failed: rate limit exceeded",
	};

	ctx.renderGoalBanner(goal);

	assert.equal(banner.classList.contains("hidden"), false);
	assert.equal(banner.classList.contains("error"), true);
	assert.equal(statusBadge.textContent, "ERROR");
	assert.equal(statusBadge.className.includes("status-error"), true);
	assert.equal(pauseLabel.textContent, "Restart");
	assert.equal(pauseBtn.disabled, false);
	assert.equal(pauseBtn.classList.contains("restart"), true);
	assert.equal(errorText.textContent, "Model execution failed: rate limit exceeded");
	assert.equal(errorBox.classList.contains("hidden"), false);
});

test("renderGoalBanner displays turn limit ratio when maxTurns is configured", () => {
	const { ctx } = harness();
	const turnsVal = ctx.$("goalTurnsValue");
	const budgetNotice = ctx.$("goalBudgetNotice");

	const goal = {
		active: true,
		status: "active",
		objective: "Bounded turn goal",
		continuationsUsed: 4,
		maxTurns: 10,
	};

	ctx.renderGoalBanner(goal);

	assert.equal(turnsVal.textContent, "4 / 10");
	assert.equal(budgetNotice.classList.contains("hidden"), false);
});
