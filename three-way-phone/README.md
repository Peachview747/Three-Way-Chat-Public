# AI Room Raspberry Pi 5 host

AI Room now runs continuously on a Raspberry Pi 5 with 64-bit Raspberry Pi OS. The Pi owns conversations, connects to ChatGPT and Claude through their official command-line service logins, and maintains the authenticated outbound WebSocket to <https://ai.jch76.workers.dev/>. iPhone, iPad, and desktop devices are browser clients; no Mac, Xcode, inbound port, or iOS app is required.

The Pi keeps the existing Cloudflare room and host credential from the private setup JSON. Browsers now connect with one six-digit PIN; room codes, browser pairing codes, and private pairing links are no longer required.

## Requirements

- Raspberry Pi 5 running Raspberry Pi OS 64-bit
- Reliable power and network access; Ethernet is preferred
- The private `AI-Room-Pi-Setup.json` file from the app-data repository
- ChatGPT and Claude subscriptions that permit Codex CLI and Claude Code login
- Optional GitHub access to `Peachview747/Three-Way-Chat-App-Data` for encrypted private-repository backup

The service uses Node.js 20 or newer. The installer adds Node.js 22 when the installed version is older, installs the official `@openai/codex` and `@anthropic-ai/claude-code` packages, creates a locked-down `ai-room` system account, and enables a systemd service.

## Install on the Pi

Copy the private setup JSON onto the Pi, then run:

```bash
git clone --branch codex/three-way-phone-link https://github.com/Peachview747/Three-Way-Chat-Public.git
cd Three-Way-Chat-Public/three-way-phone/pi-host
sudo ./install.sh /path/to/AI-Room-Pi-Setup.json
```

The installer prints the AI Room website address. Open it on any device and enter the six-digit PIN configured as the Worker secret.

Connect both subscriptions from the Pi terminal:

```bash
sudo ai-room-login gpt
sudo ai-room-login claude
```

Both commands display a browser URL or device code that can be completed from a phone. Credentials are stored under `/var/lib/ai-room` for the dedicated service account and are never sent to Cloudflare or included in conversation backups.

Check the host:

```bash
systemctl status ai-room
journalctl -u ai-room -f
```

The service starts at boot and reconnects with bounded exponential backoff. All connections are outbound, so the router needs no port forwarding.

## Private GitHub backup

Conversation history is stored locally at `/var/lib/ai-room/conversations.json` with owner-only permissions and atomic replacement. To also back it up to the private data repository:

```bash
sudo apt install gh
sudo ai-room-configure-github-backup Peachview747/Three-Way-Chat-App-Data
```

GitHub shows a device code that can be approved on a phone. The helper clones the private repository as the `ai-room` user and adds `conversations/ai-room-conversations.json`. Subsequent conversation changes commit and push automatically. GitHub credentials remain on the Pi.

## Moving from the iPhone host

Only one host may own the room WebSocket. Disconnect or remove the old AI Room Connector after the Pi is installed. Opening the old connector and tapping Connect will replace the Pi until systemd reconnects.

Existing conversations from the iPhone do not automatically move to the Pi. Export them from the website before switching if they must be retained. The Pi starts with a new local conversation file while keeping the same browser pairing.

## Assistant behavior

The host executes provider CLIs directly without a shell. Prompts are passed as process arguments, output is capped, each request has a 170-second process deadline, and browser stop requests abort the active child process. ChatGPT uses `codex exec` with a read-only sandbox and an isolated working directory. Claude uses print mode without session persistence. AI Room supplies recent room context and saves final replies itself.

The browser supports ChatGPT, Claude, both services, and one to three discussion rounds. Clicking a disconnected provider’s setup button returns the exact Pi login command.

## Cloudflare relay

Cloudflare serves the dashboard and routes a fixed set of authenticated operations through the existing Durable Object. It does not store conversations or assistant credentials. The PIN is stored only as a SHA-256 Worker secret, failed attempts are rate-limited, and a successful login creates a separate signed eight-hour browser session. Browser writes require the site’s own Origin, cookies are Secure/HttpOnly/SameSite=Strict, and at most eight operations can be pending.

The internal `/api/phone` route and `PHONE_*` binding names are retained for compatibility with the deployed room and private setup file. They now identify the Raspberry Pi host.

## Development and verification

Run locally on Linux:

```bash
cd three-way-phone/pi-host && npm ci && npm test
cd .. && npm ci && npm test
```

The public `AI Room Raspberry Pi 5 host` workflow runs these checks on GitHub’s Ubuntu ARM64 runner and validates the installer scripts. No macOS runner or IPA build is used.

The previous iOS source remains in the repository as migration history, but it is no longer the deployment target.
