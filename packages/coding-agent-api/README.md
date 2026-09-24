# @earendil-works/prime-agent-api

Headless HTTP REST and Server-Sent Events (SSE) API Gateway for Prime Agent.

This package decouples Prime Agent's core session lifecycle, prompt streaming, filesystem operations, and daemon IPC communication from the browser Web UI, allowing external clients (such as Telegram bots, Discord bots, Slack bots, CLI tools, and automation pipelines) to interact seamlessly with Prime Agent.

---

## Features

- **Decoupled Architecture**: Exposes all Prime Agent capabilities over standard HTTP REST & SSE.
- **Daemon Process Bridge**: Connects to the local Prime Agent daemon socket (`DaemonClient`) and manages multi-session lifecycles automatically.
- **Real-Time Streaming**: Server-Sent Events (`/events`) stream reasoning, assistant text deltas, tool execution start/end, and subagent updates with automatic backpressure protection.
- **Daemon Roster Tracking**: `/events/roster` streams multi-session updates across all active and saved sessions.
- **Security & Authentication**: Supports `Authorization: Bearer <token>`, `X-Prime-Agent-Token`, and query parameters (`?token=...`).
- **Filesystem & Git**: Browse workspace directories, read/write files safely within sandbox boundaries, and inspect git diffs.
- **Cron & Heartbeats**: Add, list, and cancel automated background jobs.

---

## CLI Usage

Start, stop, or inspect the API gateway using the `prime-agent` CLI:

```bash
# Start API gateway on default port (4677)
prime-agent api

# Start with custom port and host
prime-agent api --port 4888 --host 0.0.0.0

# Start with custom auth token
prime-agent api --token "your-secret-token"

# Check running status and retrieve token
prime-agent api --status

# Stop the running API gateway
prime-agent api --stop

# Restart the API gateway
prime-agent api --restart
```

Gateway process information (PID, URL, and Token) is automatically persisted to `~/.prime/agent/prime-agent-api/gateway.json`.

---

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PRIME_AGENT_API_PORT` | Port for the API server | `4677` |
| `PRIME_AGENT_API_HOST` | Host address to bind | `0.0.0.0` |
| `PRIME_AGENT_API_TOKEN` | Secret token required for requests | Auto-generated (24-byte base64url) |
| `PRIME_AGENT_API_DAEMON_SOCKET` | Unix domain socket path for Prime Agent daemon | `defaultDaemonSocketPath()` |
| `PRIME_AGENT_API_DATA_DIR` | Directory for gateway runtime metadata | `~/.prime/agent/prime-agent-api` |

---

## API Endpoints Overview

### Metadata & Sessions
* `GET /api/meta`: Returns working directory, home directory, and version.
* `GET /api/sessions`: Lists all active and saved sessions.
* `POST /api/session`: Attach to an existing session or create a new session.
* `GET /api/state?sessionId=<id>`: Get current session snapshot, state, and recent messages.
* `DELETE /api/session?sessionId=<id>`: Terminate and delete session transcript.

### Prompting & Execution
* `POST /api/prompt`: Send a user prompt (supports `images`, `streamingBehavior: "steer" | "followUp"`).
* `POST /api/steer`: Interrupt or redirect current task execution.
* `POST /api/abort`: Abort currently running task.
* `POST /api/dialog`: Respond to interactive tool permission requests (`confirmed: true/false`, `value: string`).

### Controls & Configuration
* `GET /api/models?sessionId=<id>`: List available models and providers.
* `POST /api/model`: Switch active model (`provider`, `modelId`).
* `POST /api/thinking`: Set thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
* `POST /api/compact`: Trigger context compaction.

### Real-Time Streaming
* `GET /events?sessionId=<id>`: SSE stream of session events (`agent_message`, `tool_execution_start`, `bash_start`, etc.).
* `GET /events/roster`: SSE stream of global session roster updates.

### Workspace & Filesystem
* `GET /api/fs/browse?path=<path>`: Browse host directory hierarchy.
* `GET /api/fs/list?sessionId=<id>&path=<relPath>`: List files in session workspace.
* `GET /api/fs/file?sessionId=<id>&path=<relPath>`: Read file content from session workspace.
* `PUT /api/fs/file`: Write file content in session workspace.
* `GET /api/git/diff?sessionId=<id>`: Get git diff for session workspace.

---

## Programmatic Usage

You can also embed the API server directly in Node.js applications:

```typescript
import { createApiServer } from "@earendil-works/prime-agent-api";

const instance = await createApiServer({
  port: 4677,
  token: "secret-token",
});

console.log(`API running at ${instance.url}`);

// Close server when done
await instance.close();
```
