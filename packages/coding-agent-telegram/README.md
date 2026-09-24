# @earendil-works/prime-agent-telegram

A Telegram Client for Prime Agent.

Control your Prime Agent sessions, run coding tasks remotely from your smartphone, monitor live tool execution, switch models, and inspect workspace files anywhere without open ports.

Inspired by [OpenCode Telegram Bot](https://github.com/grinev/opencode-telegram-bot) and [Hermes Agent](https://github.com/NousResearch/hermes-agent).

---

## Features

- **Remote Coding**: Send prompts from Telegram and watch Prime Agent execute tools and generate code in real time.
- **Progressive Stream Throttling**: Updates messages smoothly without triggering Telegram API rate limits (`429 Too Many Requests`).
- **Strict Security Whitelist**: Only user IDs specified in `TELEGRAM_ALLOWED_USER_ID` can interact with the bot.
- **Multi-Modal Vision**: Send photos or screenshots of terminal errors, UI designs, or bug logs directly from your phone camera.
- **Voice Note Prompts**: Send voice memos in Telegram; automatically transcribed via Whisper STT and executed as prompts.
- **Interactive File Browser (`/ls`)**: Browse workspace files and directories with inline buttons and download files to your phone.
- **Pinned Live Status (`/pin`)**: Pin an auto-updating status card in your chat tracking active model, working directory, tokens, and cost.
- **Scheduled Automations (`/task` & `/tasks`)**: Create recurring cron jobs directly from Telegram.
- **Session Management**: Switch sessions (`/sessions`) or start fresh sessions (`/new`).
- **Interactive Approvals**: Confirm or deny sensitive tool execution permissions via inline buttons (`✅ Allow` / `❌ Deny`).

---

## Quick Start

### 1. Create a Telegram Bot
1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Follow the instructions to choose a name and username.
3. Copy the **Bot Token** (e.g., `123456789:ABCdefGHIjkl...`).

### 2. Find Your Telegram User ID
Send any message to [@userinfobot](https://t.me/userinfobot) in Telegram. It will reply with your numeric User ID (e.g., `987654321`).

### 3. Start Prime Agent API Gateway
Run the headless API gateway (or the Web UI) on your machine:
```bash
prime-agent api
# or: prime-agent web
```

### 4. Start the Telegram Bot
Run with the `prime-agent` CLI:

```bash
prime-agent telegram --token "YOUR_BOT_TOKEN" --user-id "YOUR_NUMERIC_USER_ID"
```

Or configure using environment variables:

```bash
export TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN"
export TELEGRAM_ALLOWED_USER_ID="YOUR_NUMERIC_USER_ID"
export PRIME_AGENT_API_URL="http://127.0.0.1:4677"

prime-agent telegram
```

---

## Bot Commands

| Command | Description |
| --- | --- |
| `/status` | Display active session ID, directory, model, tokens, and cost |
| `/new` | Create a new session |
| `/sessions` | Browse and switch between recent sessions with inline buttons |
| `/model` | Select model provider and model ID via inline menu |
| `/thinking` | Configure thinking level (`off`, `low`, `medium`, `high`, `max`) |
| `/diff` | View git diff of the current working directory |
| `/ls [path]` | Interactive workspace file browser with tap-to-download |
| `/pin` | Pin an auto-updating live status message in the chat |
| `/task <cron> <prompt>` | Schedule an automated cron task |
| `/tasks` | List and cancel scheduled tasks |
| `/compact` | Trigger context compaction |
| `/abort` | Abort the currently running agent task |
| `/help` | Show command reference |

---

## Multimodal & Voice Features

### Photo & Screenshot Input
Send any photo or screenshot to the bot with an optional caption. Prime Agent receives the image and processes it with multimodal vision models.

### Document & File Input
Send `.py`, `.ts`, `.json`, `.diff`, or `.log` files to the bot. The content will be automatically formatted and included in the prompt.

### Voice Memos (Whisper STT)
To enable voice prompts, configure an OpenAI or Whisper API key:
```bash
export OPENAI_API_KEY="sk-..."
# or: export WHISPER_API_KEY="sk-..."
# optional custom endpoint: export WHISPER_API_BASE_URL="https://..."
```
Speak into Telegram voice memo; the bot transcribes your speech and executes it as a coding prompt.

---

## Lifecycle & Management

```bash
# Check running status
prime-agent telegram --status

# Stop running bot
prime-agent telegram --stop

# Restart bot
prime-agent telegram --restart
```

Runtime process info is stored in `~/.prime/agent/prime-agent-telegram/gateway.json`.
