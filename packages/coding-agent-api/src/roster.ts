import type { ServerResponse } from "node:http";
import type { DaemonOutbound } from "@earendil-works/pi-coding-agent";
import { connectDaemon } from "./daemon.js";

type DaemonClient = Awaited<ReturnType<typeof connectDaemon>>;
type RosterUpdate = Extract<DaemonOutbound, { type: "roster_update" }>;
type RosterEntry = RosterUpdate["changed"][number];

interface RosterSubscriber {
	res: ServerResponse;
	ready: boolean;
	closed: boolean;
	pending: string[];
	initialized: boolean;
	unsubscribe: () => void;
	onDrain?: () => void;
}

const RECONNECT_DELAY_MS = 1_000;
const UNSUPPORTED_RETRY_DELAY_MS = 30_000;
const MAX_ROSTER_SUBSCRIBERS = 8;
const MAX_PENDING_PAYLOADS = 2;
const MAX_STARTUP_UPDATES = 256;
const MAX_STARTUP_BYTES = 1_048_576;

function eventPayload(event: unknown, id?: number): string {
	return `${id === undefined ? "" : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(event)}\n\n`;
}

export type { RosterEntry, RosterUpdate };

export class RosterHub {
	readonly #entries = new Map<string, RosterEntry>();
	readonly #subscribers = new Set<RosterSubscriber>();
	#client: DaemonClient | undefined;
	#clientCleanup: (() => void) | undefined;
	#startPromise: Promise<void> | undefined;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#generation = 0;
	#sequence = 0;
	#available = false;
	#disposed = false;

	get available(): boolean {
		return this.#available;
	}

	async subscribe(res: ServerResponse): Promise<() => void> {
		if (this.#disposed) throw new Error("Roster hub is disposed");
		if (this.#subscribers.size >= MAX_ROSTER_SUBSCRIBERS) {
			throw new Error("Too many roster browser connections");
		}
		const subscriber: RosterSubscriber = {
			res,
			ready: false,
			closed: false,
			pending: [],
			initialized: false,
			unsubscribe: () => undefined,
		};
		this.#subscribers.add(subscriber);
		const unsubscribe = () => {
			if (subscriber.closed) return;
			subscriber.closed = true;
			subscriber.pending = [];
			res.off("close", unsubscribe);
			if (subscriber.onDrain) res.off("drain", subscriber.onDrain);
			subscriber.onDrain = undefined;
			this.#subscribers.delete(subscriber);
			this.#stopIfUnused();
		};
		subscriber.unsubscribe = unsubscribe;
		res.on("close", unsubscribe);
		if (res.destroyed || res.writableEnded) {
			unsubscribe();
			return unsubscribe;
		}

		try {
			await this.#ensureStarted();
		} catch (error) {
			process.stderr.write(
				`prime-agent-web: roster unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
		if (subscriber.closed) return unsubscribe;

		// The baseline already includes all updates received during startup.
		subscriber.initialized = true;
		subscriber.pending = [
			eventPayload({ type: "roster.connected", available: this.#available }),
			this.#snapshotPayload(),
		];
		subscriber.ready = true;
		this.#flush(subscriber);
		return unsubscribe;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		for (const subscriber of [...this.#subscribers]) {
			subscriber.unsubscribe();
			subscriber.res.end();
		}
		this.#stopIfUnused();
	}

	async #ensureStarted(): Promise<void> {
		if (this.#disposed || this.#subscribers.size === 0) return;
		if (this.#client?.isConnected && this.#available) return;
		if (!this.#startPromise) {
			const start = this.#connect(this.#generation);
			const tracked = start.finally(() => {
				if (this.#startPromise === tracked) {
					this.#startPromise = undefined;
					if (!this.#available) this.#scheduleReconnect(RECONNECT_DELAY_MS);
				}
			});
			this.#startPromise = tracked;
		}
		await this.#startPromise;
	}

	#stopIfUnused(): void {
		if (this.#subscribers.size > 0) return;
		this.#generation++;
		this.#startPromise = undefined;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#clientCleanup?.();
		this.#clientCleanup = undefined;
		this.#client?.close();
		this.#client = undefined;
		this.#available = false;
		this.#entries.clear();
	}

	async #connect(generation: number): Promise<void> {
		const client = await connectDaemon();
		if (this.#disposed || generation !== this.#generation || this.#subscribers.size === 0) {
			client.close();
			return;
		}
		if (!client.supportsServerCapability("agent_roster")) {
			this.#available = false;
			this.#entries.clear();
			client.close();
			this.#scheduleReconnect(UNSUPPORTED_RETRY_DELAY_MS);
			return;
		}

		let pending: RosterUpdate[] | undefined = [];
		let pendingBytes = 0;
		let resolveClosed!: () => void;
		const closed = new Promise<undefined>((resolve) => {
			resolveClosed = () => resolve(undefined);
		});
		const handleClose = () => {
			if (this.#client !== client) return;
			this.#clientCleanup?.();
			this.#clientCleanup = undefined;
			this.#client = undefined;
			this.#available = false;
			this.#entries.clear();
			this.#publish({ type: "roster.snapshot", available: false, entries: [] });
			this.#scheduleReconnect(RECONNECT_DELAY_MS);
		};
		const removeMessageListener = client.onMessage((message) => {
			if (this.#client !== client || message.type !== "roster_update") return;
			if (pending) {
				const bytes = Buffer.byteLength(JSON.stringify(message));
				if (pending.length >= MAX_STARTUP_UPDATES || pendingBytes + bytes > MAX_STARTUP_BYTES) {
					// A new subscription must provide a complete baseline; never replay a truncated queue.
					handleClose();
					client.close();
					return;
				}
				pending.push(message);
				pendingBytes += bytes;
			} else this.#applyUpdate(message);
		});
		const removeCloseListener = client.onClose(handleClose);
		this.#client = client;
		this.#clientCleanup = () => {
			pending = [];
			pendingBytes = 0;
			resolveClosed();
			removeMessageListener();
			removeCloseListener();
		};

		try {
			const response = await Promise.race([
				client.request({ type: "roster_subscribe" }, 30_000, { recoverable: false }),
				closed,
			]);
			if (!response) return;
			if (this.#client !== client || this.#disposed || generation !== this.#generation) return;
			if (!response.success || typeof response.data !== "object" || response.data === null) {
				throw new Error(response.success ? "invalid roster payload" : response.error);
			}
			const roster = (response.data as { roster?: RosterEntry[] }).roster;
			if (!Array.isArray(roster)) throw new Error("invalid roster payload");
			this.#entries.clear();
			for (const entry of roster) this.#entries.set(entry.agentId, entry);
			this.#available = true;
			this.#publish({ type: "roster.snapshot", available: true, entries: roster });
			for (const update of pending) this.#applyUpdate(update);
			pending = undefined;
		} catch (error) {
			if (this.#client !== client || generation !== this.#generation) return;
			this.#available = false;
			this.#clientCleanup?.();
			this.#clientCleanup = undefined;
			this.#client = undefined;
			client.close();
			this.#scheduleReconnect(RECONNECT_DELAY_MS);
			throw error;
		}
	}

	#scheduleReconnect(delay: number): void {
		if (this.#disposed || this.#subscribers.size === 0 || this.#reconnectTimer) return;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#ensureStarted().catch(() => undefined);
		}, delay);
		this.#reconnectTimer.unref?.();
	}

	#applyUpdate(update: RosterUpdate): void {
		if (this.#disposed || this.#subscribers.size === 0) return;
		if (update.resync) this.#entries.clear();
		for (const entry of update.changed) this.#entries.set(entry.agentId, entry);
		for (const agentId of update.removed ?? []) this.#entries.delete(agentId);
		this.#publish({
			type: "roster.update",
			available: this.#available,
			changed: update.changed,
			removed: update.removed ?? [],
			resync: update.resync === true,
		});
	}

	#snapshotPayload(): string {
		return eventPayload(
			{
				type: "roster.snapshot",
				available: this.#available,
				sequence: this.#sequence,
				entries: [...this.#entries.values()],
			},
			this.#sequence,
		);
	}

	#publish(event: Record<string, unknown>): void {
		const id = ++this.#sequence;
		const payload = eventPayload({ ...event, sequence: id }, id);
		for (const subscriber of this.#subscribers) this.#queue(subscriber, payload);
	}

	#queue(subscriber: RosterSubscriber, payload: string): void {
		if (subscriber.closed || !subscriber.initialized) return;
		if (!subscriber.ready) {
			if (subscriber.pending.length < MAX_PENDING_PAYLOADS) subscriber.pending.push(payload);
			else subscriber.pending = [this.#snapshotPayload()];
			return;
		}
		try {
			if (!subscriber.res.write(payload)) {
				subscriber.ready = false;
				subscriber.onDrain = () => {
					subscriber.onDrain = undefined;
					if (subscriber.closed) return;
					subscriber.ready = true;
					this.#flush(subscriber);
				};
				subscriber.res.once("drain", subscriber.onDrain);
			}
		} catch {
			subscriber.unsubscribe();
			subscriber.res.destroy();
		}
	}

	#flush(subscriber: RosterSubscriber): void {
		while (subscriber.ready && !subscriber.closed && subscriber.pending.length > 0) {
			const payload = subscriber.pending.shift();
			if (payload !== undefined) this.#queue(subscriber, payload);
		}
	}
}
