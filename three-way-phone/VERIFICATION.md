# Verification

## Raspberry Pi 5 migration

AI Room’s active host is now a Node.js service for 64-bit Raspberry Pi OS. The service preserves the deployed WebSocket protocol and room credentials, stores conversations atomically under `/var/lib/ai-room`, invokes the official Codex and Claude Code CLIs without a shell, bounds output and execution time, supports cancellation, and reconnects through systemd without inbound ports.

Three Pi-host tests cover persistent conversations and replies, request deduplication, room creation, provider status, service-login guidance, and shell-safe CLI argument handling. The six existing Miniflare tests continue to cover relay authentication, handshake, replacement, concurrency, bounded input, and backup authorization. Installer scripts pass Bash syntax validation. The GitHub workflow now runs on Ubuntu ARM64; it no longer requests a macOS runner or builds an IPA.

Physical Pi verification still requires installing on the owner’s Raspberry Pi 5, completing both provider logins, and confirming the private website link reaches the service. The old iPhone connector must be disconnected because only one host can own the room.

## Build 8 assistants, background hosting, and private backup

Build 8 adds ChatGPT Codex device authorization, Claude Code service authorization, Keychain token storage and refresh, real assistant responses, stop handling, and multi-round discussion. It adds an audio background mode and silent keep-alive modeled on Video Pilot Build 49. Conversation files remain readable after the first unlock so replies can finish in the background. The Worker accepts phone-authenticated backups and writes them through an encrypted `GITHUB_TOKEN` secret to the private data repository. The secret must be configured before backup becomes active.

Miniflare tests cover backup authentication, input validation and the missing-secret failure in addition to the relay suite. Native compilation, simulator UI validation, and IPA packaging run on the macOS Actions runner. Provider authorization and long-duration background behavior require physical-device testing because CI has no user service accounts or iOS background lifecycle.

## Build 6 app rename

Display name, connector text, website branding, export filename, and IPA artifact names use AI Room. Stable internal identifiers and conversation storage are preserved. Native build validation remains pending on macOS.

## Build 5 setup guidance

Added an in-app setup guide and manual browser-pairing code controls. Updated the website dialog and regenerated its deployed assets. The connector UI test now opens and dismisses setup help before testing import cancellation. Native UI tests require the macOS Actions runner and have not been run in this Linux environment.

## Build 4 URL update

The connector validation, displayed website, relay test origin, and Worker name now target `https://ai.jch76.workers.dev/`. Packaging and Actions artifact names use Build 4. Import an updated private setup file after updating in place. Deployment to the `jch` Cloudflare account and a new device IPA build require external credentials/macOS tooling; local relay tests do not establish live deployment or device behavior. Background handling is unchanged.

## Earlier builds

Build 3 changes only the app interface and packaging: the native connector replaces the embedded chat dashboard. The Cloudflare dashboard, relay, conversation store, Keychain service, bundle identifier and storage schema are unchanged.

- Previous Build 2 passed public Actions run 38098509343, including native storage tests, device archive, IPA checks and embedded-dashboard simulator tests.
- The deployed Worker previously passed authentication, handshake, heartbeat, phone-owned state/prompt routing and offline-denial checks with a protocol client. Five Miniflare integration tests cover authentication, handshake, replacement, bounded concurrency, disconnection and public assets.
- The owner has opened the previous app successfully inside LiveContainer. A real phone-to-Cloudflare pairing has not yet been confirmed.
- Build 3's workflow runs the native storage tests, device archive, connector-only package validation and new connector simulator test. Results are recorded in the PR and distributed build report.
- Private pairing keys and conversations are excluded from public source and artifacts.
