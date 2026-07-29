# Recordly Codex

Recordly Codex is an Apache-2.0 Codex plugin and local TypeScript runtime for evidence-backed website recordings. Give Codex an approved URL and objective; local code owns frame persistence, timing, rendering, encoding, and artifact checks. It does not use another visible recording app.

The supported interaction surface is Codex Desktop Browser. It is not a Codex CLI or IDE browser integration.

## Current capability

| Capability | Current behavior | Boundary |
| --- | --- | --- |
| Session control | Five local MCP tools create, inspect, append planned semantic events, seal, and discard a session | URL and objective are required; a session is not a completed recording. |
| Browser capture | Generated start/stop helpers call a per-session loopback broker and automatically observe trusted page clicks and trusted-wheel-derived scrolling only after the first frame is durably accepted | A document is eligible only when CDP supplies nonempty frame ID, loader ID, and URL and its `securityOrigin` exactly matches the recording origin. After that local guard and the durable baseline, each document epoch obtains a fresh authenticated, nonpersistent 256-bit marker from the broker. Start returns only after successful isolated evaluation and a console ready handshake pin the epoch's first valid 256-bit nonce, with a 10-second readiness limit. Repeated signals for the active or in-flight identity are deduplicated; a changed loader creates one replacement epoch. No Runtime binding API or page main-world function is exposed. |
| Evidence | The broker gives frames and observed actions one monotonic receipt clock; hashes, strict trusted-click and trusted-wheel-derived scroll records, and canonical metadata stay in a private artifact root | Click records require `event.isTrusted`. After a trusted wheel, scroll observation checks a bounded window of at most 120 animation-frame attempts spaced by 16 ms, roughly two seconds, and emits only the first nonzero resulting window position/delta. It does not collect selectors, DOM, text, cookies, storage, or the target URL path. |
| Delivery | Sealing renders a deterministic CFR MP4 and runs media, temporal visible-result, final-hold, frozen-frame, privacy, and decoded clipping checks | Approval fails closed unless broker timing, an automatically observed action, a visible decoded change, final hold, clipping, and the other delivery gates all pass. |
| Visual treatment | The renderer produces a contained 1080p, 30 fps, limited-range, silent H.264 baseline and verifies decoded source edges, border, matte, and aspect | Temporal alignment proves that a visible result followed an observed action in the allowed window; it does not prove causation or understand page semantics. No cursor, click, or zoom overlay is fabricated. |

The published v0.2.0 release was installed and enabled through the Git marketplace, then exercised against one authorized public workflow. It adds automatically observed trusted-click and trusted-wheel-derived scroll evidence plus fail-closed temporal visible-result and decoded clipping QA. These proofs do not mean that every public site, Browser host version, authentication flow, or page transition will work unattended.

## Install from a release

Use a released tag when one is available; `main` is appropriate only for development.

```bash
codex plugin marketplace add daniel-p-green/recordly-codex --ref v0.2.0
codex plugin add recordly-codex@recordly-codex
```

`recordly-codex@recordly-codex` is the selector declared by this repository's one-plugin marketplace manifest. The source is the repository root, so the plugin's `.codex-plugin/` and `.mcp.json` layout remain intact.

Marketplace installs start the committed `plugin-runtime/recordly-codex-mcp.mjs` bundle. It embeds the MCP SDK and local runtime dependencies, so an installed plugin does not depend on `node_modules`, a build output directory, or a separate recording application. Its bundled npm dependency notices are shipped in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Node.js and, when sealing a capture, `ffmpeg` and `ffprobe` are still required on the host.

For a clean developer checkout:

```bash
npm ci
npm run plugin:validate
npm run check
```

The v0.2.0 tag, release workflow, marketplace package, installed stdio MCP runtime, and Browser-helper path were verified after release. The clean installed bundle matched SHA-256 `ea7da03dfd3f4ac31d6dfb76a788aac3e2ad5d3d8c6c47e3265e3ceb9f39b0f2`; raw JSON-RPC exposed exactly the five documented tools and passed session create/discard with empty stderr. Each later tag still requires its own clean marketplace-install and authorized-site acceptance check. Do not treat a local build, a marketplace listing, or an MCP process as that proof.

Requirements: Node.js 22.17+, npm 11+, `ffmpeg`, and `ffprobe`. The loopback E2E harness also needs a supported system Chrome; that Chrome harness is test evidence, not the Codex Browser runtime.

## Use in Codex Desktop

1. Confirm that the site and the proposed actions are public or explicitly authorized. State the objective and any allowed origins.
2. Call `create_recording_session` with `url`, `objective`, and, when needed, `allowedOrigins` or `allowPrivateOrigin`. It creates a private session and returns two Browser helper entrypoints plus capture configuration.
3. Inspect and rehearse in Codex Desktop Browser at the fixed viewport. To capture, the host must offer `browser_run_code_unsafe`; run the returned start helper once in the approved page, drive only the approved workflow, then run its matching stop helper once. Startup navigation only records a main-frame document whose CDP `securityOrigin` equals the recording origin and whose ID, loader ID, and URL are nonempty. A mismatch fails before challenge issuance or observer installation. After the broker durably accepts frame one, the helper sends the document URL with its authenticated epoch challenge request. The broker parses it as HTTP(S), rejects embedded credentials, and requires its canonical origin to match both the session and declared origins before challenge-count or marker side effects. It then returns a fresh 256-bit marker. Start returns `observedReady: true` only after isolated evaluation succeeds and an exact `{kind:"ready", nonce}` console handshake pins the first valid 256-bit nonce. Navigation activation is generation-serialized: duplicate signals for the active or pending identity are ignored, a changed loader receives a fresh epoch marker, and an A→B→A return cannot reuse A's old marker or nonce. The broker permits at most 32 observer challenges per capture; exceeding the cap fails capture closed.
4. Use `record_browser_event` only for planned semantic `pointer`, `click`, `scroll`, `navigation`, `viewport`, or `marker` notes. These model-described events are useful context, but they do not satisfy the observed-action approval gate. Frame, capture-health, and observed-action evidence are broker-owned and cannot be supplied through MCP.
5. Use `inspect_recording_session` to read safe status and paths. Call `seal_recording_capture` only after a successful stop summary. It renders the capture, aligns broker-timed observed actions to CFR frames, checks for a visible decoded result and final hold, verifies decoded clipping and media properties, and returns exactly three contained delivery artifacts: `recording.mp4`, `recording-manifest.json`, and `quality-report.json`.
6. Use `discard_recording_session` for failed, abandoned, or unapproved work. It removes the owned temporary evidence and helpers.

The loopback broker grants one random capability token on the helper's one-time claim. The token stays out of injected page code. The broker accepts only loopback JSON requests for that session and origin. Each accepted frame and observed action receives a local monotonic `receiptOffsetUs`; the page cannot choose it. The first frame offset is zero, later frame offsets are strictly increasing, and observed actions share that clock. An observed event before the first durable frame, or malformed, oversized, unauthenticated, wrong-origin, excessive, incomplete, or unpersisted evidence, fails the capture closed. Legacy evidence can be inspected, but cannot become a quality-approved delivery.

Stop and ask the user rather than proceeding through credentials, MFA/OTP, CAPTCHA or bot controls, consent or device permissions, payment, uploads of sensitive material, downloads, publishing, deletion, access changes, legal acceptance, or any irreversible action. Never bypass a browser or site safety control.

## Privacy and artifacts

Session directories, observed-event records, and owner tokens use restrictive local permissions. Browser-visible helpers are separate from the private artifact root. Per-document broker challenge markers are never persisted, and the helper strips marker and nonce before broker event delivery, so neither enters evidence or delivery artifacts. Before rendering, each artifact ancestor must be a real non-symlink directory and each frame realpath must remain under the verified session realpath. The delivery manifest preserves the target origin, evidence hashes, sanitized observed action type/coordinates or deltas, and CFR frame index while omitting raw receipt timestamps, target path, query, fragment, credentials, raw-frame paths, selectors, DOM, and page text. No cookies, headers, raw DOM, page text, raw frames, or private observed-event files should be placed in prompts, Git, CI logs, or issue reports.

See the [capability matrix](docs/capability-matrix.md) for exact supported and unsupported behavior, [architecture](docs/architecture.md) for the boundary design, [threat model](docs/threat-model.md) for the action/approval policy, and [licensing](docs/licensing.md) for the Recordly clean-room boundary.

## Development and release

Changes use red-green-refactor. Run `npm ci`, `npm run check`, and `npm run plugin:validate` before release; `npm ci` rebuilds source outputs and verifies that the committed MCP bundle and its dependency notices are reproducible from esbuild's actual input graph. The repository contains a capability matrix because supported behavior has material safety consequences; a separate changelog is not added until a tagged public release establishes a versioned change history.

This project is independent from [Recordly](https://github.com/webadderallorg/Recordly). Recordly is AGPL-3.0; do not copy, adapt, link, or distribute its implementation or assets here without a separate legal and licensing decision.
