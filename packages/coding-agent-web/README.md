# Prime Agent Web

Chat with your [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) coding agent from any browser on your network — laptop or phone. Sessions are backed by the shared Prime Agent daemon, so conversations survive closing the tab and stay in sync with the TUI.

## Features

- **Full agent chat** — streaming responses, thinking visibility, tool cards with diffs, approvals, steering, and abort, all over SSE
- **Sessions** — list, create, clone, fork from an earlier prompt, delete, and rename from the sidebar; cold sessions resume from their transcript with one click
- **Files, Git & Jobs panel** — browse and edit workspace files, inspect git diff, manage cron jobs and heartbeats
- **Slash commands** — `/compact`, `/fork`, `/clone`, `/reload`, `/export`, `/new`, `/name` with autocomplete, plus extension commands
- **Model & thinking pickers** — searchable model dropdown (90+ models), thinking-level select
- **Finish notifications** — synthesized two-note chime + browser notification (or in-app toast over plain HTTP) when the agent finishes
- **Mobile-first responsive** — installable PWA (Add to Home Screen), drawer sidebar, safe layouts down to 360 px
- **Resilient** — auto-resume of TUI-cancelled sessions, SSE reconnect indicator, per-client login rate limiting

## Quick start

```bash
npx tsx packages/coding-agent-web/src/main.ts
```

Open `http://127.0.0.1:4677/`. On first boot a password is generated and printed
to the log (also saved to `~/.prime/agent/prime-agent-web/prime-agent-web-password.txt`);
the browser asks for it once and remembers the login for a year.

Serve your LAN (phone access) with:

```bash
npx tsx packages/coding-agent-web/src/main.ts --host 0.0.0.0
```

The startup log prints every reachable address. CLI flags override the
environment: `--host <address>`, `--port <port>`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRIME_AGENT_WEB_HOST` | `127.0.0.1` | Bind address (keep loopback unless you need LAN) |
| `PRIME_AGENT_WEB_PORT` | `4677` | HTTP port |
| `PRIME_AGENT_WEB_TOKEN` | generated per start | Shared token (token mode) |
| `PRIME_AGENT_WEB_AUTH` | `password` | `password` or `token` |
| `PRIME_AGENT_WEB_PASSWORD` | generated on first boot | The single password (password mode) |
| `PRIME_AGENT_WEB_DATA_DIR` | `~/.prime/agent/prime-agent-web` | Stored password hash + login cookies |

## Security model

- One password for one user; sessions are bound to a signed-in cookie (`HttpOnly`, `SameSite=Lax`, 1 year)
- Failed logins are rate limited per client: 5 failures in 10 minutes lock the source for 30 s, doubling per extra failure up to 15 min
- Cross-origin API calls are rejected; static assets are served `no-store`
- Browser notifications require HTTPS or localhost (platform rule); over plain HTTP the UI falls back to an in-app toast + chime
- The gateway talks to the daemon over its local socket only — it never exposes daemon control endpoints to the browser

## HTTPS for phone access

Browser notifications and install prompts work best over HTTPS. Easiest options:

- **Tailscale**: `tailscale serve https / http://127.0.0.1:4677` — valid cert, private network
- Any reverse proxy (Caddy/nginx) with a cert in front of the gateway

## Architecture

`src/main.ts` — HTTP + SSE gateway, auth, static serving.
`src/daemon.ts` — daemon client: attach, create, resume saved sessions, kill, list, resume queue.
`src/password.ts` — password gate with login persistence and rate limiting.
`src/fs.ts` — workspace file browsing/editing with realpath containment.
`src/static/` — the single-page app (vanilla JS, no build step, no runtime deps).

Tests: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/` from the package root.

## Credits

- Finish sound: ["Positive notification"](https://mixkit.co/free-sound-effects/notification/) by Mixkit (free license, no attribution required)
