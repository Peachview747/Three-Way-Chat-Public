# Three Way for iPhone

The original Three Way dashboard, bundled into a native iPhone app. The iPhone owns the conversations and maintains an outbound authenticated WebSocket to Cloudflare. A paired browser uses the same dashboard at https://three-way-chat.jcruzhoovertesla.workers.dev/ while the app is open. The laptop can be off.

This milestone implements phone hosting and the Cloudflare connection. GPT and Claude are honestly shown as disconnected. Prompts save with the selected recipients; no inference, provider sign-in, API keys, credits, or listing publication is performed.

## Install and connect

1. Download the IPA from the public GitHub Actions build and sign it using your normal personal sideload method. It requires iOS 17 or later. It is a separate app from Video Pilot.
2. Open Three Way. Its first screen is the original dashboard.
3. Open **Connections → Import phone setup** and select the private `Three-Way-Phone-Setup.json` supplied separately. Pairing stays in the iPhone Keychain.
4. The app connects to Cloudflare. Keep it open; screen-awake is enabled while connected. iOS may pause networking when locked or backgrounded. Reopen the app to reconnect.
5. Use **Private Website link** to open or share the browser pairing link. Browser pairing lasts eight hours. The public address shows the interface; the private link grants access to this phone’s conversations.

Pairing files, private website links, conversations, credentials and signing certificates must never be committed to this public repository. The checked-in Worker has no account secrets.

## Hosting and storage

The same HTML, CSS and JavaScript are bundled into the app and served as static assets by Cloudflare. On the phone, a bridge restricted to the bundled main frame invokes the local conversation store. In another browser, authenticated requests pass through one Durable Object to the connected phone. Cloudflare does not persist conversations or produce assistant replies.

The phone writes history atomically with complete file protection before acknowledging changes. Concurrent phone and browser requests run on the main actor. Repeated request IDs deduplicate; changing their payload is rejected. Conversation IDs are persisted before use. Damaged history files are preserved and block writes. This build holds at most 50 rooms, 500 prompts and 600 KB of history; export is available. Deleting the app removes its local history.

## Connection protocol

`three-way-host/1` exchanges `hello → ready → connected` before browser operations can run. JSON requests contain `{type:"request", id, action, body}` and responses contain `{type:"response", id, status, body}`. Only state, export, send, new, refresh, login and stop are routed. Login explains that assistants are unavailable; stop has no inference to cancel. There is no arbitrary URL proxy, shell access or access to local files outside chat storage.

One phone owns the connection. A replacement cancels the previous phone’s pending requests. There are at most eight in-flight requests, a ten-second response deadline, and bounded frames. Phone and browser credentials are separate; Cloudflare stores their SHA-256 hashes. Writes require the site’s own Origin. Browser cookies are Secure, HttpOnly and SameSite=Strict. The pairing fragment is removed from the browser address after use. Heartbeats use Durable Object WebSocket auto-responses; reconnects back off to thirty seconds.

## Build and verify

The feature branch `codex/three-way-phone-link` triggers `.github/workflows/three-way-iphone.yml` on a public macOS runner. No private repo minutes, signing secrets or paid services are configured. The workflow tests phone storage, generates the Xcode project, archives the device app, verifies arm64, metadata and bundled dashboard, applies an ad-hoc template signature, and uploads the IPA plus SHA-256 report. Personal signing is still required to install it.

On macOS: `bash scripts/build_ipa.sh`. For Worker tests: `npm ci && npm test`. `python3 scripts/prepare_assets.py` generates both sets of dashboard assets. Worker deployment is separate from the public build and requires the owner’s Cloudflare account; no deploy credentials enter Actions.

The Video Pilot Build 49 IPA was used to inspect the phone-to-Cloudflare hosting pattern. This app has its own bundle identifier, Keychain service, interface assets and pairing keys. It does not reuse Video Pilot’s media background modes or credentials.
