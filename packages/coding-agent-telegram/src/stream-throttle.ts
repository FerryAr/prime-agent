const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

export class ProgressiveThrottle {
	private readonly startedAt: number;
	private lastUpdateAt = 0;
	private pendingTimer?: NodeJS.Timeout;
	private pendingAction?: () => Promise<void>;

	constructor() {
		this.startedAt = Date.now();
	}

	getIntervalMs(): number {
		const elapsed = Date.now() - this.startedAt;
		if (elapsed < MINUTE_MS) {
			return 1000; // 1s
		}
		if (elapsed < 5 * MINUTE_MS) {
			return 2000; // 2s
		}
		if (elapsed < 15 * MINUTE_MS) {
			return 5000; // 5s
		}
		return 10000; // 10s
	}

	schedule(action: () => Promise<void>): void {
		this.pendingAction = action;
		const now = Date.now();
		const interval = this.getIntervalMs();
		const elapsedSinceLast = now - this.lastUpdateAt;

		if (elapsedSinceLast >= interval) {
			this.flush();
		} else if (!this.pendingTimer) {
			const delay = interval - elapsedSinceLast;
			this.pendingTimer = setTimeout(() => {
				this.pendingTimer = undefined;
				this.flush();
			}, delay);
		}
	}

	flush(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
		if (this.pendingAction) {
			const act = this.pendingAction;
			this.pendingAction = undefined;
			this.lastUpdateAt = Date.now();
			void act().catch(() => undefined);
		}
	}

	cancel(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
		this.pendingAction = undefined;
	}
}
