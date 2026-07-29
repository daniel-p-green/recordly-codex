# Recordly Codex

Recordly Codex is an Apache-2.0 Codex plugin and local TypeScript runtime for evidence-backed website recordings. Give Codex an approved URL and objective; local code owns frame persistence, timing, rendering, encoding, and artifact checks. It does not use another visible recording app.

The supported interaction surface is Codex Desktop Browser. It is not a Codex CLI or IDE browser integration.

## Current capability

| Capability | Current behavior | Boundary |
| --- | --- | --- |
| Session control | Five local MCP tools create, inspect, append semantic events, seal, and discard a session | URL and objective are required; a session is not a completed recording. |
| Browser capture | Generated start/stop helper entrypoints call a per-session loopback broker | The Codex Browser host must expose `browser_run_code_unsafe`; the MCP server cannot invoke Browser actions itself. |
| Evidence | Broker-owned receipt offsets, frame hashes, canonical metadata, and semantic telemetry stay in a private artifact root | Raw frames never enter model context or Git. |
| Delivery | Sealing a complete capture runs the deterministic renderer and returns an MP4, sanitized delivery manifest, and quality report | Delivery is approved only with complete broker receipt timing and non-frozen evidence. |
| Visual treatment | The renderer produces a clean 1080p, 30 fps, silent baseline with source-frame framing | It does not fabricate cursor motion, click effects, or zooms without synchronized telemetry. |

The checked local evidence covers built stdio MCP calls, a loopback-only browser capture/render fixture, receipt-timed delivery, and redacted failure paths. It is not a claim that every public site, Browser host version, or authentication flow will work unattended. A Codex Desktop marketplace install and a real approved-site end-to-end capture still require release-time live verification.

## Install from a release

Use a released tag when one is available; `main` is appropriate only for development.

```bash
codex plugin marketplace add daniel-p-green/recordly-codex --ref <released-tag>
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

The install command above has been validated as the supported marketplace shape, but a post-release Codex Desktop install remains a release gate. Do not treat a local build, a marketplace listing, or an MCP process as proof that the Desktop Browser host can run the capture helpers.

Requirements: Node.js 22.17+, npm 11+, `ffmpeg`, and `ffprobe`. The loopback E2E harness also needs a supported system Chrome; that Chrome harness is test evidence, not the Codex Browser runtime.

## Use in Codex Desktop

1. Confirm that the site and the proposed actions are public or explicitly authorized. State the objective and any allowed origins.
2. Call `create_recording_session` with `url`, `objective`, and, when needed, `allowedOrigins` or `allowPrivateOrigin`. It creates a private session and returns two Browser helper entrypoints plus capture configuration.
3. Inspect and rehearse in Codex Desktop Browser at the fixed viewport. To capture, the host must offer `browser_run_code_unsafe`; run the returned start helper once in the approved page, drive only the approved workflow, then run its matching stop helper once.
4. Use `record_browser_event` for semantic `pointer`, `click`, `scroll`, `navigation`, `viewport`, or `marker` events. The service assigns sequence numbers and monotonic timestamps. Frame and health events are broker-owned and cannot be supplied through MCP.
5. Use `inspect_recording_session` to read safe status and paths. Call `seal_recording_capture` only after a successful stop summary. It renders and quality-checks the capture, then returns exactly three contained delivery artifacts: `recording.mp4`, `recording-manifest.json`, and `quality-report.json`.
6. Use `discard_recording_session` for failed, abandoned, or unapproved work. It removes the owned temporary evidence and helpers.

The loopback broker grants one random capability token on the helper's one-time claim. It accepts only loopback JSON requests for that session and origin. Each accepted frame receives a local monotonic `receiptOffsetUs`; the page cannot choose it. The first offset is zero and later offsets are strictly increasing. Legacy evidence can be inspected, but cannot become a quality-approved delivery.

Stop and ask the user rather than proceeding through credentials, MFA/OTP, CAPTCHA or bot controls, consent or device permissions, payment, uploads of sensitive material, downloads, publishing, deletion, access changes, legal acceptance, or any irreversible action. Never bypass a browser or site safety control.

## Privacy and artifacts

Session directories and owner tokens use restrictive local permissions. Browser-visible helpers are separate from the private artifact root. The delivery manifest preserves the target origin and evidence hashes while omitting target path, query, fragment, credentials, and raw-frame paths. No cookies, headers, raw DOM, page text, or raw frame stream should be placed in prompts, Git, CI logs, or issue reports.

See [architecture](docs/architecture.md) for the boundary design and delivery rules, [threat model](docs/threat-model.md) for the action/approval policy, and [licensing](docs/licensing.md) for the Recordly clean-room boundary.

## Development and release

Changes use red-green-refactor. Run `npm ci`, `npm run check`, and `npm run plugin:validate` before release; `npm ci` rebuilds source outputs and verifies that the committed MCP bundle and its dependency notices are reproducible from esbuild's actual input graph. The repository contains a capability matrix because supported behavior has material safety consequences; a separate changelog is not added until a tagged public release establishes a versioned change history.

This project is independent from [Recordly](https://github.com/webadderallorg/Recordly). Recordly is AGPL-3.0; do not copy, adapt, link, or distribute its implementation or assets here without a separate legal and licensing decision.
