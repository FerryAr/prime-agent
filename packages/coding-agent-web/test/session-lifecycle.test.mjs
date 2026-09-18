import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
// Execute actual lifecycle declarations, without starting HTTP or a daemon.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const constants = [
	"sessions",
	"requestSessions",
	"SESSION_IDLE_TTL_MS",
	"MAX_SESSION_SUBSCRIBERS",
	"MAX_SESSION_PENDING_PAYLOADS",
	"MAX_SESSION_PENDING_BYTES",
].map((name) => {
	const declaration = source.split("\n").find((line) => line.startsWith(`const ${name} =`));
	assert.ok(declaration, `Missing production constant ${name}`);
	return declaration;
});
const start = source.indexOf("function json(");
const end = source.indexOf("const server =");
assert.ok(start >= 0 && end > start, "Missing production lifecycle boundaries");
const executable = stripTypeScriptTypes(`${constants.join("\n")}\n${source.slice(start, end)}`);

class Response extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	headers = [];
	writes = [];
	failWrites = false;
	writeHead(status) {
		this.headers.push(status);
	}
	write(payload) {
		if (this.failWrites) throw new Error("write failed");
		this.writes.push(payload);
		return true;
	}
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
	}
	end() {
		this.writableEnded = true;
		this.destroy();
	}
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness(snapshot = Promise.resolve({ messages: [] })) {
	const timeouts = new Map();
	const intervals = new Map();
	let intervalCreations = 0;
	let disposals = 0;
	let unsubscribes = 0;
	let listener;
	const connection = {
		getInitialSnapshot: () => snapshot,
		subscribe: (callback) => {
			listener = callback;
			return () => unsubscribes++;
		},
		dispose: async () => {
			disposals++;
		},
	};
	const api = runInNewContext(
		`${executable}\n({ sessions, handle, requireSession, scheduleSessionIdleEviction, openSession, closeWebSession, getSessionSnapshot, serveEvents, writeSessionSubscriber, MAX_SESSION_SUBSCRIBERS, MAX_SESSION_PENDING_BYTES, SESSION_IDLE_TTL_MS })`,
		{
			Buffer,
			AsyncLocalStorage,
			URL,
			Error,
			STATIC_ROUTES: {},
			AUTH_MODE: "token",
			TOKEN: "test",
			isLoopbackOrigin: () => true,
			isAllowedOrigin: () => true,
			tokensMatch: () => true,
			requestToken: () => "test",
			errorStatus: (error) => error.status ?? 500,
			connectDaemon: async () => ({}),
			attachSession: async () => connection,
			HttpError: class extends Error {
				constructor(status, message) {
					super(message);
					this.status = status;
				}
			},
			setTimeout: (callback, delay) => {
				const handle = { unref() {} };
				timeouts.set(handle, { callback, delay });
				return handle;
			},
			clearTimeout: (handle) => timeouts.delete(handle),
			setInterval: (callback) => {
				const handle = {};
				intervalCreations++;
				intervals.set(handle, callback);
				return handle;
			},
			clearInterval: (handle) => intervals.delete(handle),
		},
	);
	return {
		...api,
		timeouts,
		intervals,
		get intervalCreations() {
			return intervalCreations;
		},
		get disposals() {
			return disposals;
		},
		get unsubscribes() {
			return unsubscribes;
		},
		emit: (event) => listener(event),
	};
}

const eventsUrl = new URL("http://localhost/events?sessionId=session");

test("closeWebSession is present and idempotently releases only the web attachment", async () => {
	const h = harness();
	const session = await h.openSession("session");
	const response = new Response();
	await h.serveEvents(response, eventsUrl);
	assert.equal(h.intervals.size, 1);
	h.closeWebSession(session);
	h.closeWebSession(session);
	assert.equal(session.closed, true);
	assert.equal(response.destroyed, true);
	assert.equal(session.subscribers.size, 0);
	assert.equal(h.sessions.size, 0);
	assert.equal(h.intervals.size, 0);
	assert.equal(h.timeouts.size, 0);
	assert.equal(h.disposals, 1);
	assert.equal(h.unsubscribes, 1);
});

for (const failure of ["overflow", "write failure"]) {
	test(`subscriber already marked closed by ${failure} is removed and evicted`, async () => {
		const snapshot = deferred();
		const h = harness(snapshot.promise);
		const session = await h.openSession("session");
		const response = new Response();
		const serving = h.serveEvents(response, eventsUrl);
		const [subscriber] = session.subscribers;
		if (failure === "overflow") {
			h.writeSessionSubscriber(subscriber, "x".repeat(h.MAX_SESSION_PENDING_BYTES + 1));
		} else {
			subscriber.ready = true;
			response.failWrites = true;
			h.writeSessionSubscriber(subscriber, "event");
		}
		assert.equal(subscriber.closed, true);
		assert.equal(response.destroyed, true);
		assert.equal(session.subscribers.size, 0);
		snapshot.resolve({ messages: [] });
		await serving;
		assert.equal(h.intervalCreations, 0);
		assert.equal(h.timeouts.size, 1);
		const [{ callback }] = h.timeouts.values();
		callback();
		assert.equal(h.sessions.size, 0);
		assert.equal(h.disposals, 1);
	});
}

test("subscriber cap rejects before SSE headers are sent", async () => {
	const h = harness();
	const session = await h.openSession("session");
	for (let index = 0; index < h.MAX_SESSION_SUBSCRIBERS; index++) {
		await h.serveEvents(new Response(), eventsUrl);
	}
	const rejected = new Response();
	await assert.rejects(h.serveEvents(rejected, eventsUrl), { status: 429 });
	assert.equal(rejected.headers.length, 0);
	assert.equal(rejected.writes.length, 0);
	assert.equal(session.subscribers.size, h.MAX_SESSION_SUBSCRIBERS);
});

test("closing the response during snapshot does not create a heartbeat later", async () => {
	const snapshot = deferred();
	const h = harness(snapshot.promise);
	const session = await h.openSession("session");
	const response = new Response();
	const serving = h.serveEvents(response, eventsUrl);
	response.destroy();
	snapshot.resolve({ messages: [] });
	await serving;
	assert.equal(session.subscribers.size, 0);
	assert.equal(h.intervalCreations, 0);
	assert.equal(h.timeouts.size, 1);
});

for (const outcome of ["success", "failure"]) {
	test(`snapshot ${outcome} without SSE schedules idle eviction`, async () => {
		const snapshot = deferred();
		const h = harness(snapshot.promise);
		const session = await h.openSession("session");
		const reading = h.getSessionSnapshot(session);
		assert.equal(h.timeouts.size, 0);
		if (outcome === "success") {
			snapshot.resolve({ messages: [] });
			await reading;
		} else {
			snapshot.reject(new Error("snapshot failed"));
			await assert.rejects(reading, /snapshot failed/);
		}
		assert.equal(h.timeouts.size, 1);
		const [{ callback, delay }] = h.timeouts.values();
		assert.equal(delay, h.SESSION_IDLE_TTL_MS);
		callback();
		assert.equal(h.sessions.size, 0);
		assert.equal(h.disposals, 1);
		assert.equal(h.unsubscribes, 1);
	});
}

test("daemon closed event releases attachment and all subscribers", async () => {
	const h = harness();
	const session = await h.openSession("session");
	const response = new Response();
	await h.serveEvents(response, eventsUrl);
	h.emit({ type: "closed" });
	assert.equal(session.closed, true);
	assert.equal(response.destroyed, true);
	assert.equal(h.sessions.size, 0);
	assert.equal(h.disposals, 1);
	assert.equal(h.intervals.size, 0);
});

for (const outcome of ["success", "failure"]) {
	test(`concurrent snapshots defer eviction until the last snapshot ${outcome}`, async () => {
		const h = harness();
		const session = await h.openSession("session");
		const first = deferred();
		const second = deferred();
		const snapshots = [first.promise, second.promise];
		session.connection.getInitialSnapshot = () => snapshots.shift();
		const firstReading = h.getSessionSnapshot(session);
		const secondReading = h.getSessionSnapshot(session);
		assert.equal(session.pendingSnapshots, 2);
		first.resolve({ messages: [] });
		await firstReading;
		assert.equal(session.pendingSnapshots, 1);
		h.scheduleSessionIdleEviction(session);
		assert.equal(h.timeouts.size, 0);
		assert.equal(h.disposals, 0);
		if (outcome === "success") {
			second.resolve({ messages: [] });
			await secondReading;
		} else {
			second.reject(new Error("snapshot failed"));
			await assert.rejects(secondReading, /snapshot failed/);
		}
		assert.equal(session.pendingSnapshots, 0);
		assert.equal(h.timeouts.size, 1);
		const [{ callback }] = h.timeouts.values();
		callback();
		assert.equal(h.disposals, 1);
	});
}

for (const outcome of ["success", "failure"]) {
	test(`HTTP requests retain once per request and release on ${outcome}`, async () => {
		const h = harness();
		const session = await h.openSession("session");
		await h.getSessionSnapshot(session);
		assert.equal(h.timeouts.size, 1);
		const first = deferred();
		const second = deferred();
		const requests = [first.promise, second.promise];
		session.connection.getAvailableModels = () => {
			// Repeated acquisition in the same real request must not double retain.
			assert.equal(h.requireSession("session"), session);
			return requests.shift();
		};
		const request = { method: "GET", url: "/api/models?sessionId=session", headers: {} };
		const firstResponse = new Response();
		const secondResponse = new Response();
		const firstHandling = h.handle(request, firstResponse);
		const secondHandling = h.handle(request, secondResponse);
		assert.equal(session.pendingRequests, 2);
		assert.equal(h.timeouts.size, 0);
		first.resolve([]);
		await firstHandling;
		assert.equal(session.pendingRequests, 1);
		h.scheduleSessionIdleEviction(session);
		assert.equal(h.timeouts.size, 0);
		assert.equal(h.disposals, 0);
		if (outcome === "success") second.resolve([]);
		else second.reject(new Error("models failed"));
		await secondHandling;
		assert.equal(secondResponse.headers[0], outcome === "success" ? 200 : 500);
		assert.equal(session.pendingRequests, 0);
		assert.equal(h.timeouts.size, 1);
		const [{ callback }] = h.timeouts.values();
		callback();
		assert.equal(h.disposals, 1);
	});
}

test("serveEvents sends connected and snapshot before live events that arrived during snapshot", async () => {
	const h = harness();
	const snapshotGate = deferred();
	const session = await h.openSession("session");
	session.connection.getInitialSnapshot = () => snapshotGate.promise;

	const response = new Response();
	const serving = h.serveEvents(response, new URL("http://127.0.0.1/events?sessionId=session"));

	// While getInitialSnapshot is pending, live events arrive from the daemon
	h.emit({ type: "session_event", event: { type: "message_update", delta: "hello" } });
	h.emit({ type: "session_event", event: { type: "message_update", delta: "world" } });

	// Now snapshot finishes
	snapshotGate.resolve({ state: { sessionId: "session" }, messages: [] });
	await serving;

	assert.equal(response.writes.length, 4);
	assert.match(response.writes[0], /"type":"connected"/);
	assert.match(response.writes[1], /"type":"snapshot"/);
	assert.match(response.writes[2], /"delta":"hello"/);
	assert.match(response.writes[3], /"delta":"world"/);
});
