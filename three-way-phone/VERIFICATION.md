# Verification

## Build 4 URL update

The connector validation, displayed website, relay test origin, and Worker name now target `https://ai.jch.workers.dev/`. Packaging and Actions artifact names use Build 4. Import an updated private setup file after updating in place. Deployment to the `jch` Cloudflare account and a new device IPA build require external credentials/macOS tooling; local relay tests do not establish live deployment or device behavior. Background handling is unchanged.

## Earlier builds

Build 3 changes only the app interface and packaging: the native connector replaces the embedded chat dashboard. The Cloudflare dashboard, relay, conversation store, Keychain service, bundle identifier and storage schema are unchanged.

- Previous Build 2 passed public Actions run 38098509343, including native storage tests, device archive, IPA checks and embedded-dashboard simulator tests.
- The deployed Worker previously passed authentication, handshake, heartbeat, phone-owned state/prompt routing and offline-denial checks with a protocol client. Five Miniflare integration tests cover authentication, handshake, replacement, bounded concurrency, disconnection and public assets.
- The owner has opened the previous app successfully inside LiveContainer. A real phone-to-Cloudflare pairing has not yet been confirmed.
- Build 3's workflow runs the native storage tests, device archive, connector-only package validation and new connector simulator test. Results are recorded in the PR and distributed build report.
- Private pairing keys and conversations are excluded from public source and artifacts.
- GPT and Claude sign-in/inference and background operation are not implemented or verified by this update.
