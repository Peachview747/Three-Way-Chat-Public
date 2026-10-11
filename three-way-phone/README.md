# AI Room phone connector

AI Room’s iPhone app hosts the conversations used by the dashboard at <https://ai.jch76.workers.dev/>. The phone maintains an authenticated outbound WebSocket to Cloudflare, calls the assistant services, saves chat history locally, and can back that history up to the private app-data repository. The laptop can be off.

## Build 8

Build 8 connects ChatGPT through Codex device authorization and Claude through Claude Code service authorization. OAuth credentials stay in the iPhone Keychain and are never included in browser traffic, setup files, conversation exports, or GitHub backups. Completed replies are written atomically to the phone.

The app uses the same silent background-audio hosting pattern as Video Pilot Build 49. Leave **Keep hosting when app is in background** enabled to switch apps or lock the screen. iOS can still suspend the app after a force quit, an audio interruption, or system resource pressure; the connector automatically reconnects when execution resumes.

The display name is AI Room. The bundle identifier, Keychain service, conversation path, and relay protocol remain stable so an in-place update preserves existing pairing and history. Build 8 requires a setup file whose `server` is exactly `https://ai.jch76.workers.dev/`.

## Install and connect

1. Install the Build 8 IPA using your usual personal sideload method or update the existing guest app inside LiveContainer. It requires iOS 17 or later. Preserve the app’s data container during an update.
2. Open **AI Room Connector**, tap **Import phone setup**, and choose the private `AI-Room-Phone-Setup.json`. Importing connects automatically. Existing pairing remains in Keychain; tap **Connect to Cloudflare** if it was already imported.
3. Wait for **Connected to Cloudflare**. Leave background hosting enabled if the connector must remain available while the app is not visible.
4. Use **Share private website link** or **Copy private website link** and open that exact link on the other device. The fragment pairs the browser and is removed from its address after use.
5. Under **Assistant connections**, connect ChatGPT and Claude. ChatGPT uses a device code. Claude opens its service login and returns a code that must be pasted into the connector.
6. Use the website for individual prompts, replies from both services, multi-round discussions, new rooms, and exports.

The setup guide inside the app also explains manual room and browser pairing codes. Private setup files, private links, conversations, OAuth credentials, Worker secrets, and signing certificates must never enter this public repository.

## Hosting, storage, and backup

Cloudflare serves the dashboard and routes fixed, authenticated room actions through a Durable Object. The phone calls ChatGPT and Claude directly; Cloudflare never receives provider credentials. The phone holds at most 50 rooms, 500 messages, and 600 KB of history.

History is stored with file protection that remains available after the first device unlock, allowing a background reply to finish. Writes are atomic. Repeated request IDs deduplicate, changed payloads are rejected, and damaged history files are preserved instead of overwritten.

After a history change, the phone sends an authenticated snapshot to `/api/backup`. When `GITHUB_TOKEN` is configured as an encrypted Worker secret, the Worker writes it to `conversations/ai-room-conversations.json` in `Peachview747/Three-Way-Chat-App-Data`. Optional Worker variables `GITHUB_REPOSITORY` and `GITHUB_BACKUP_PATH` can override those defaults. The token needs contents read/write access only to that private repository.

## Relay security

`three-way-host/1` exchanges `hello → ready → connected` before browser operations run. Only state, export, send, new, refresh, login, and stop are routed. There is no arbitrary URL proxy, shell access, or access to local files outside chat storage.

One phone owns the connection. A replacement cancels the prior phone’s pending requests. There are at most eight in-flight operations, a 15-second standard deadline, a three-minute assistant deadline, and bounded frames. Phone and browser credentials are separate; Cloudflare stores their SHA-256 hashes. Browser writes require the site’s own Origin. Cookies are Secure, HttpOnly, and SameSite=Strict. WebSocket heartbeats use Durable Object auto-responses and reconnects back off to 30 seconds.

## Build and verify

The public branch `codex/three-way-phone-link` triggers `.github/workflows/three-way-iphone.yml` on a public macOS runner. It tests local conversation storage, builds the device archive, verifies metadata and arm64 packaging, checks that no dashboard is bundled in the IPA, applies the ad-hoc template signature, and runs the connector simulator UI test. The artifact contains the IPA, checksum report, and simulator screenshots.

Run Worker tests with `npm ci && npm test`. On macOS, run `bash scripts/build_ipa.sh`. `python3 scripts/prepare_assets.py` regenerates the Worker’s dashboard assets. Worker deployment is separate and requires the owner’s Cloudflare account.

The Video Pilot Build 49 IPA informed the background-hosting pattern. AI Room retains its own bundle identifier, Keychain services, and pairing credentials.
