# Three Way phone connector

Three Way's iPhone app connects the phone to Cloudflare and shows setup, connection status, and the private website link. The chat dashboard lives at https://three-way-chat.jcruzhoovertesla.workers.dev/. Build 3 removes the embedded dashboard from the IPA. Your iPhone owns the conversations and maintains an outbound authenticated WebSocket. Your laptop can be off while the connector remains open on the phone.

GPT and Claude are not connected in this milestone. The website saves prompts with their chosen recipients; assistant sign-in and replies are not implemented. There are no model API calls or Etsy publishing operations.

## Install and connect

1. Use the IPA from the public GitHub Actions build with your normal personal sideload method, or update the existing Three Way guest app inside LiveContainer. Requires iOS 17 or later. Preserve the existing app's data container when updating.
2. Open **Three Way Connector**. Tap **Import phone setup** and choose the private `Three-Way-Phone-Setup.json` supplied separately. Importing automatically connects. Existing pairing remains in the Keychain; tap **Connect to Cloudflare** if it was already imported.
3. Wait for **Connected to Cloudflare**. Keep the connector open; screen-awake is enabled during the connection.
4. Use **Share private website link** or **Copy private website link** and open it in a browser on another device. The public URL shows the dashboard; the private link pairs that browser to your phone's room for eight hours.
5. Use the website for conversations, prompts, new rooms and exports.

Locking the hosting phone or switching apps pauses this connector. Reopen Three Way to reconnect. LiveContainer background behavior is not verified. This build adds no background execution mode.

Pairing files, private links, conversations, credentials and signing certificates must never enter this public repository.

## Hosting and storage

Cloudflare serves the dashboard's HTML, CSS and JavaScript. The iPhone app contains only the native connector interface. Authenticated browser requests pass through a Durable Object to the phone's conversation store. Cloudflare does not persist conversations or produce assistant replies.

Build 3 preserves the bundle identifier, Keychain service, history file path and history schema from Build 2. It removes the dashboard's native bridge without changing the relay or storage implementation. Updating in place preserves history; deleting the app or its LiveContainer data container removes it.

The phone writes history atomically with complete file protection before acknowledging changes. Requests run on the main actor. Repeated request IDs deduplicate; changing their payload is rejected. Conversation IDs are persisted before use. Damaged history files are preserved and block writes. This build holds at most 50 rooms, 500 prompts and 600 KB of history; export is available on the website.

## Connection protocol

`three-way-host/1` exchanges `hello → ready → connected` before browser operations can run. JSON requests contain `{type:"request", id, action, body}` and responses contain `{type:"response", id, status, body}`. Only state, export, send, new, refresh, login and stop are routed. Login explains that assistants are unavailable; stop has no inference to cancel. There is no arbitrary URL proxy, shell access or access to local files outside chat storage.

One phone owns the connection. A replacement cancels the previous phone's pending requests. There are at most eight in-flight requests, a ten-second response deadline, and bounded frames. Phone and browser credentials are separate; Cloudflare stores their SHA-256 hashes. Writes require the site's own Origin. Browser cookies are Secure, HttpOnly and SameSite=Strict. The pairing fragment is removed from the browser address after use. Heartbeats use Durable Object WebSocket auto-responses; reconnects back off to thirty seconds.

## Build and verify

The feature branch `codex/three-way-phone-link` triggers `.github/workflows/three-way-iphone.yml` on a public macOS runner. The workflow tests phone storage, generates the Xcode project, archives the device app, validates arm64 and metadata, checks the IPA has no bundled dashboard, and applies an ad-hoc template signature. A simulator test verifies the connector screen, unavailable connection before pairing, file-picker cancellation, and absence of the chat interface. The artifact includes the IPA, SHA-256 report and simulator screenshot.

On macOS: `bash scripts/build_ipa.sh`. For Worker tests: `npm ci && npm test`. `python3 scripts/prepare_assets.py` generates Cloudflare's dashboard assets only. Worker deployment is separate and requires the owner's Cloudflare account; no deploy credentials or signing secrets enter Actions.

The Video Pilot Build 49 IPA informed the phone-to-Cloudflare hosting pattern. Three Way has its own bundle identifier, Keychain service and pairing keys. This update does not change Video Pilot.
