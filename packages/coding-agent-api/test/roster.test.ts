import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectDaemon } from "../src/daemon.js";
import { RosterHub } from "../src/roster.js";

vi.mock("../src/daemon.js", () => ({ connectDaemon: vi.fn() }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class Response extends EventEmitter {
	writes: string[] = [];
	blocked = false;
	destroyed = false;
	writableEnded = false;
	write(payload: string) {
		this.writes.push(payload);
		return !this.blocked;
	}
	end() {
		this.writableEnded = true;
		this.emit("close");
	}
	destroy() {
		this.destroyed = true;
		this.emit("close");
	}
	asResponse() {
		return this as unknown as ServerResponse;
	}
	events() {
		return this.writes.map((payload) => JSON.parse(payload.split("data: ")[1]));
	}
}

function client(supported = true) {
	const events = new EventEmitter();
	return {
		events,
		isConnected: true,
		supportsServerCapability: vi.fn(() => supported),
		close: vi.fn(() => events.emit("close")),
		request: vi.fn(async () => ({ success: true, data: { roster: [] } })),
		onMessage: (listener: (message: unknown) => void) => {
			events.on("message", listener);
			return () => {
				events.off("message", listener);
			};
		},
		onClose: (listener: () => void) => {
			events.on("close", listener);
			return () => {
				events.off("close", listener);
			};
		},
	};
}

type Client = Awaited<ReturnType<typeof connectDaemon>>;
const hubs: RosterHub[] = [];
function hub() {
	const value = new RosterHub();
	hubs.push(value);
	return value;
}
afterEach(async () => {
	for (const value of hubs.splice(0)) await value.dispose();
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("roster lifecycle", () => {
	it.each(["count", "bytes"])("restarts with a fresh baseline on startup %s overflow", async (limit: string) => {
		vi.useFakeTimers();
		const first = client();
		const second = client();
		const pending = deferred<{ success: boolean; data: { roster: never[] } }>();
		first.request.mockReturnValue(pending.promise);
		vi.mocked(connectDaemon)
			.mockResolvedValueOnce(first as unknown as Client)
			.mockResolvedValueOnce(second as unknown as Client);
		const response = new Response();
		const value = hub();
		const subscription = value.subscribe(response.asResponse());
		await Promise.resolve();
		const total = limit === "count" ? 257 : 1;
		for (let index = 0; index < total; index++) {
			first.events.emit("message", {
				type: "roster_update",
				changed: [{ agentId: "stale", metadata: limit === "bytes" ? "x".repeat(1_048_576) : index }],
				removed: [],
			});
		}
		await subscription;
		expect(first.close).toHaveBeenCalledOnce();
		expect(first.events.eventNames()).toEqual([]);
		expect(value.available).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(connectDaemon).toHaveBeenCalledTimes(2);
		expect(value.available).toBe(true);
		expect(response.events().at(-1)).toMatchObject({ type: "roster.snapshot", available: true, entries: [] });
		pending.resolve({ success: true, data: { roster: [] } });
		await Promise.resolve();
		expect(response.events().some((event) => event.type === "roster.update")).toBe(false);
	});

	it("replays startup changed and removed updates in order before the baseline", async () => {
		const daemon = client();
		const pending = deferred<{ success: boolean; data: { roster: never[] } }>();
		daemon.request.mockReturnValue(pending.promise);
		vi.mocked(connectDaemon).mockResolvedValue(daemon as unknown as Client);
		const response = new Response();
		const subscription = hub().subscribe(response.asResponse());
		await Promise.resolve();
		daemon.events.emit("message", {
			type: "roster_update",
			changed: [{ agentId: "a", metadata: "old" }],
			removed: [],
		});
		daemon.events.emit("message", { type: "roster_update", changed: [], removed: ["a"] });
		daemon.events.emit("message", {
			type: "roster_update",
			changed: [{ agentId: "a", metadata: "new" }],
			removed: [],
		});
		pending.resolve({ success: true, data: { roster: [] } });
		await subscription;
		expect(response.events()).toHaveLength(2);
		expect(response.events()[1].entries).toEqual([{ agentId: "a", metadata: "new" }]);
	});

	it("does not let an abandoned connection replace a new subscriber's client", async () => {
		const pending = deferred<Client>();
		const abandoned = client();
		const current = client();
		vi.mocked(connectDaemon)
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(current as unknown as Client);
		const value = hub();
		const oldResponse = new Response();
		const oldSubscription = value.subscribe(oldResponse.asResponse());
		oldResponse.destroy();
		const response = new Response();
		await value.subscribe(response.asResponse());
		pending.resolve(abandoned as unknown as Client);
		await oldSubscription;
		expect(abandoned.close).toHaveBeenCalledOnce();
		expect(current.close).not.toHaveBeenCalled();
		expect(value.available).toBe(true);
	});

	it("tears down the daemon and drain handler when a blocked browser leaves", async () => {
		const daemon = client();
		vi.mocked(connectDaemon).mockResolvedValue(daemon as unknown as Client);
		const response = new Response();
		response.blocked = true;
		await hub().subscribe(response.asResponse());
		expect(response.listenerCount("drain")).toBe(1);
		response.destroy();
		expect(response.listenerCount("drain")).toBe(0);
		expect(daemon.events.eventNames()).toEqual([]);
		expect(daemon.close).toHaveBeenCalledOnce();
	});

	it("closes a late connection after the browser disconnects", async () => {
		const pending = deferred<Client>();
		vi.mocked(connectDaemon).mockReturnValue(pending.promise);
		const value = hub();
		const res = new Response();
		const daemon = client();
		const subscription = value.subscribe(res.asResponse());
		res.destroy();
		pending.resolve(daemon as unknown as Client);
		await subscription;
		expect(daemon.close).toHaveBeenCalledOnce();
		expect(daemon.request).not.toHaveBeenCalled();
		expect(res.writes).toEqual([]);
		expect(res.listenerCount("close")).toBe(0);
	});

	it("ignores late subscribe replies after dispose and rejects new subscriptions", async () => {
		const daemon = client();
		const pending = deferred<{ success: boolean; data: { roster: never[] } }>();
		daemon.request.mockReturnValue(pending.promise);
		vi.mocked(connectDaemon).mockResolvedValue(daemon as unknown as Client);
		const value = hub();
		const res = new Response();
		const subscription = value.subscribe(res.asResponse());
		await Promise.resolve();
		await value.dispose();
		pending.resolve({ success: true, data: { roster: [] } });
		await subscription;
		expect(value.available).toBe(false);
		expect(daemon.events.eventNames()).toEqual([]);
		expect(res.writes).toEqual([]);
		await expect(value.subscribe(new Response().asResponse())).rejects.toThrow("disposed");
	});

	it("cancels unsupported daemon retries when the last browser leaves", async () => {
		vi.useFakeTimers();
		vi.mocked(connectDaemon).mockResolvedValue(client(false) as unknown as Client);
		const res = new Response();
		const unsubscribe = await hub().subscribe(res.asResponse());
		expect(vi.getTimerCount()).toBe(1);
		unsubscribe();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(connectDaemon).toHaveBeenCalledOnce();
	});

	it("keeps a baseline and monotonically ordered state under repeated backpressure", async () => {
		const daemon = client();
		vi.mocked(connectDaemon).mockResolvedValue(daemon as unknown as Client);
		const res = new Response();
		res.blocked = true;
		const unsubscribe = await hub().subscribe(res.asResponse());
		expect(res.events().map((event) => event.type)).toEqual(["roster.connected"]);
		res.emit("drain");
		expect(res.events()[1].type).toBe("roster.snapshot");
		for (let index = 0; index < 100; index++) {
			daemon.events.emit("message", {
				type: "roster_update",
				changed: [{ agentId: "agent", metadata: { index } }],
				removed: [],
			});
		}
		expect(res.writes).toHaveLength(2);
		expect(res.listenerCount("drain")).toBe(1);
		res.blocked = false;
		res.emit("drain");
		const events = res.events().slice(1);
		expect(events.length).toBeLessThanOrEqual(3);
		const sequences = events.map((event) => event.sequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		const last = events.at(-1);
		expect((last.entries ?? last.changed)[0].metadata).toEqual({ index: 99 });
		unsubscribe();
		expect(res.listenerCount("drain")).toBe(0);
		expect(res.listenerCount("close")).toBe(0);
		expect(daemon.close).toHaveBeenCalledOnce();
	});
});
