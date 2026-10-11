# Three Way — iPhone / Cloudflare connection build

This build implements the owner's narrowed request: connect an iPhone app to the existing Three Way Worker and exchange test messages between the app and website. No GPT/Claude inference, provider sign-in, model API keys, paid API fallback, or Etsy operations are included.

The native SwiftUI layout and outbound phone connection follow the architecture of the owner's Video Pilot 0.1.37 Build 49. Three Way has its own bundle identifier, Keychain service, icon, Worker, and pairing credentials. Video Pilot and its `tv` Worker are untouched.

## Use on the iPhone

1. Sign and install `Three-Way-0.1.0-Build-1.ipa` with your existing sideload tool. The archive uses an ad-hoc template signature; it still needs personal Apple signing.
2. Save `Three-Way-Phone-Setup.json` to the iPhone's Files app. This is a private pairing file; keep it out of Git and share it only with the owner of the phone.
3. Open Three Way, tap **Import phone setup**, and select that file.
4. Tap **Connect**. Wait for **Connected to Cloudflare**.
5. Tap **Website link**, then open that private link in the browser you want to use. It pairs that browser for eight hours. The public URL by itself cannot read your messages.
6. Send a test message on either screen. Both should show the same accepted message.

Keep the iPhone app open and connected. The laptop can be off. The app pauses when iOS puts it in the background and reconnects when reopened; it does not use a fake audio background mode. The optional keep-awake control only works while the app is in the foreground.

## Data and pairing

The most recent 100 accepted test messages are retained in one SQLite-backed Durable Object on Cloudflare. The iPhone keeps a protected local copy. Messages are plain text rendered safely, up to 2,000 UTF-16 characters each. Browser sends require the phone to be online. A server acknowledgment confirms storage; it does not prove the other screen has already displayed the message.

The phone and browser have different random pairing keys. The setup file stores both; the app stores them in its Keychain. The Worker stores SHA-256 key hashes as secret bindings. Browser links carry their key in a URL fragment, which is removed immediately by the page; pairing sets an HttpOnly, Secure, SameSite cookie. Unpairing clears that browser cookie. Rotating the deployed keys revokes existing pairings. Never publish the setup file, private website link, or a real chat export.

Only one phone connection is active at a time. A second connection replaces the first. Duplicate message IDs with identical content are accepted idempotently while retained in the 100-message window; conflicting content is rejected. No automatic assistant calls exist.

## Build and verify

The iOS app uses Apple frameworks only and targets iOS 17+. A Mac with Xcode and XcodeGen is required to compile it. Run `bash scripts/build_ipa.sh` on that Mac. `scripts/package_ipa.py` checks the bundle, version, device architecture, signature, and ZIP before reporting success. Windows cannot compile this native app.

The independent GitHub workflow can build the IPA as a private Actions artifact. It never merges a PR or publishes a release. The generated IPA must be downloaded and checked before calling the build complete.

For Worker tests, install the dev dependencies with `npm ci` and run `npm test`. The suite uses the real local Workers runtime; it makes no model requests. `python scripts/prepare_assets.py` updates the deployable web module. Deployment requires the `PHONE_ROOM` binding, SQLite migration, room ID, and the two secret key hashes. No paid plan is enabled by these source files.

## Connection protocol

- `GET /health`: public app and protocol identification.
- `GET /api/phone`: native WebSocket upgrade authenticated with the phone key in the Authorization header.
- First socket frame: `state` with protocol `three-way-link/1`; the app marks connected only after this frame.
- Phone sends `{type:"message",id:"<uuid-v4>",text:"..."}`; the Worker returns the canonical state after saving.
- `ping` / `pong`: automatic hibernation-safe heartbeat.
- `POST /api/session`: exchanges the browser pairing link for an eight-hour cookie; matching Origin is required.
- `GET /api/state`: private bounded history and real phone socket status.
- `POST /api/message`: private browser message; matching Origin and an online phone are required.
- `POST /api/logout`: clears this browser's pairing cookie.
- `DELETE /api/reset`: phone-key authenticated removal of the test history, used to clean up verification.

The relay only accepts structured test messages. It cannot forward arbitrary URLs, run commands, access local files, or call assistants.
