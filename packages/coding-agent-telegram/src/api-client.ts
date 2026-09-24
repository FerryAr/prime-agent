import { tryReadGatewayToken } from "./config.js";
export interface SessionInfo {
	id: string;
	activeSessionId?: string;
	sessionId?: string;
	cwd?: string;
	model?: { provider: string; modelId: string };
	messageCount?: number;
	firstMessage?: string;
	workerPid?: number;
	sessionFile?: string;
}

export interface SessionSnapshot {
	activeSessionId: string;
	streamSequence: number;
	state?: {
		cwd: string;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
		sessionFile?: string;
		usage?: { inputTokens: number; outputTokens: number; cost: number };
	};
	messages?: any[];
	children?: any[];
}

export class PrimeApiClient {
	readonly baseUrl: string;
	readonly token?: string;

	constructor(baseUrl: string, token?: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
	}

	private getToken(): string | undefined {
		return this.token || tryReadGatewayToken();
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		const activeToken = this.getToken();
		if (activeToken) {
			headers["authorization"] = `Bearer ${activeToken}`;
			headers["x-prime-agent-token"] = activeToken;
		}
		return headers;
	}

	private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers = { ...this.getHeaders(), ...(options.headers as Record<string, string>) };
		const res = await fetch(url, { ...options, headers });
		if (!res.ok) {
			let errorMsg = `HTTP ${res.status} ${res.statusText}`;
			try {
				const body = await res.json();
				if (body?.error) errorMsg = body.error;
				else if (body?.message) errorMsg = body.message;
			} catch {}
			throw new Error(errorMsg);
		}
		return (await res.json()) as T;
	}

	async getMeta(): Promise<{ cwd: string; home: string; version: string }> {
		return this.request("/api/meta");
	}

	async getSessions(): Promise<SessionInfo[]> {
		const res = await this.request<{ sessions: SessionInfo[] }>("/api/sessions");
		return res.sessions ?? [];
	}

	async openSession(options: { activeSessionId?: string; sessionPath?: string; cwd?: string } = {}): Promise<SessionSnapshot> {
		return this.request("/api/session", {
			method: "POST",
			body: JSON.stringify(options),
		});
	}

	async getState(sessionId: string): Promise<SessionSnapshot> {
		return this.request(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
	}

	async prompt(sessionId: string, message: string, images?: any[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
		await this.request("/api/prompt", {
			method: "POST",
			body: JSON.stringify({ sessionId, message, images, ...(streamingBehavior ? { streamingBehavior } : {}) }),
		});
	}

	async steer(sessionId: string, message: string): Promise<void> {
		await this.request("/api/steer", {
			method: "POST",
			body: JSON.stringify({ sessionId, message }),
		});
	}

	async abort(sessionId: string): Promise<void> {
		await this.request("/api/abort", {
			method: "POST",
			body: JSON.stringify({ sessionId }),
		});
	}

	async respondDialog(
		sessionId: string,
		id: string,
		response: { confirmed?: boolean; value?: string; cancelled?: boolean },
	): Promise<void> {
		await this.request("/api/dialog", {
			method: "POST",
			body: JSON.stringify({ sessionId, id, ...response }),
		});
	}

	async getModels(sessionId: string): Promise<{ models: Array<{ id: string; name: string; provider: string }> }> {
		return this.request(`/api/models?sessionId=${encodeURIComponent(sessionId)}`);
	}

	async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
		await this.request("/api/model", {
			method: "POST",
			body: JSON.stringify({ sessionId, provider, modelId }),
		});
	}

	async setThinking(sessionId: string, level: string): Promise<void> {
		await this.request("/api/thinking", {
			method: "POST",
			body: JSON.stringify({ sessionId, level }),
		});
	}

	async newSession(sessionId: string): Promise<void> {
		await this.request("/api/new", {
			method: "POST",
			body: JSON.stringify({ sessionId }),
		});
	}

	async compact(sessionId: string, instructions?: string): Promise<any> {
		return this.request("/api/compact", {
			method: "POST",
			body: JSON.stringify({ sessionId, instructions }),
		});
	}

	async getGitDiff(sessionId: string): Promise<{ diff?: string; branch?: string; status?: string }> {
		return this.request(`/api/git/diff?sessionId=${encodeURIComponent(sessionId)}`);
	}

	async browseFs(path?: string): Promise<{ path: string; entries: Array<{ name: string; path: string }> }> {
		const q = path ? `?path=${encodeURIComponent(path)}` : "";
		return this.request(`/api/fs/browse${q}`);
	}

	async listWorkspace(
		sessionId: string,
		path: string = "",
	): Promise<{ path: string; entries: Array<{ name: string; type: "dir" | "file"; size?: number }> }> {
		return this.request(`/api/fs/list?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`);
	}

	async readWorkspaceFile(
		sessionId: string,
		path: string,
	): Promise<{ path: string; content?: string; binary?: boolean; size?: number }> {
		return this.request(`/api/fs/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`);
	}

	async listCronJobs(sessionId: string): Promise<{ jobs: any[] }> {
		return this.request(`/api/cron?sessionId=${encodeURIComponent(sessionId)}`);
	}

	async addCronJob(sessionId: string, schedule: string, prompt: string): Promise<{ job: any }> {
		return this.request("/api/cron", {
			method: "POST",
			body: JSON.stringify({ sessionId, schedule, prompt }),
		});
	}

	async cancelCronJob(sessionId: string, jobId: string): Promise<void> {
		await this.request(`/api/cron?sessionId=${encodeURIComponent(sessionId)}&jobId=${encodeURIComponent(jobId)}`, {
			method: "DELETE",
		});
	}

	async renameSession(sessionId: string, name: string): Promise<void> {
		await this.request("/api/session-name", {
			method: "POST",
			body: JSON.stringify({ sessionId, name }),
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.request(`/api/session?sessionId=${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
		});
	}

	async getSubagentMessages(sessionId: string, childId: string): Promise<{ childId: string; messages: any[] }> {
		return this.request(`/api/subagent-messages?sessionId=${encodeURIComponent(sessionId)}&childId=${encodeURIComponent(childId)}`);
	}

	async askSideQuestion(sessionId: string, question: string): Promise<{ id: string }> {
		return this.request("/api/side-question", {
			method: "POST",
			body: JSON.stringify({ sessionId, question }),
		});
	}

	async exportSession(sessionId: string): Promise<{ path?: string; markdown?: string; html?: string }> {
		return this.request("/api/export", {
			method: "POST",
			body: JSON.stringify({ sessionId }),
		});
	}

	/**
	 * Subscribes to the /events SSE stream for a session.
	 * Returns an unsubscribe callback and a ready promise that resolves when the stream is connected.
	 */
	subscribeEvents(
		sessionId: string,
		onEvent: (event: any) => void,
		onError?: (error: any) => void,
	): { unsubscribe: () => void; ready: Promise<void> } {
		const controller = new AbortController();
		const activeTok = this.getToken();
		const tokenQuery = activeTok ? `&token=${encodeURIComponent(activeTok)}` : "";
		const url = `${this.baseUrl}/events?sessionId=${encodeURIComponent(sessionId)}${tokenQuery}`;

		let resolveReady: () => void;
		let rejectReady: (err: any) => void;
		const ready = new Promise<void>((res, rej) => {
			resolveReady = res;
			rejectReady = rej;
		});

		(async () => {
			try {
				const headers: Record<string, string> = {
					accept: "text/event-stream",
				};
				if (activeTok) {
					headers["authorization"] = `Bearer ${activeTok}`;
					headers["x-prime-agent-token"] = activeTok;
				}
				const res = await fetch(url, {
					headers,
					signal: controller.signal,
				});

				if (!res.ok) {
					const err = new Error(`SSE stream failed: HTTP ${res.status}`);
					rejectReady(err);
					throw err;
				}

				if (!res.body) {
					const err = new Error("No response body for SSE stream");
					rejectReady(err);
					throw err;
				}

				resolveReady();

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (!controller.signal.aborted) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					// Normalize Windows newlines
					buffer = buffer.replace(/\r\n/g, "\n");

					let boundaryIndex: number;
					while ((boundaryIndex = buffer.indexOf("\n\n")) !== -1) {
						const block = buffer.slice(0, boundaryIndex);
						buffer = buffer.slice(boundaryIndex + 2);

						if (!block.trim()) continue;
						for (const line of block.split("\n")) {
							if (line.startsWith("data: ")) {
								const jsonStr = line.slice(6).trim();
								if (!jsonStr) continue;
								try {
									const data = JSON.parse(jsonStr);
									onEvent(data);
								} catch (parseErr) {
									console.warn("SSE JSON.parse failed:", parseErr, "line:", jsonStr.slice(0, 100));
								}
							}
						}
					}
				}
			} catch (err: any) {
				if (!controller.signal.aborted) {
					rejectReady(err);
					onError?.(err);
				}
			}
		})();

		return {
			unsubscribe: () => {
				controller.abort();
			},
			ready,
		};
	}
}
