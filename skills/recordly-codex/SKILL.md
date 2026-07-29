---
name: recordly-codex
description: Create and direct evidence-backed interactive website recordings through Codex Desktop Browser and local MCP tools. Use for an approved URL and a bounded objective; stop at credentials, permissions, CAPTCHA, payment, sensitive uploads, or irreversible actions.
---

# Recordly Codex

Use this skill only for an approved public or explicitly pre-authenticated website flow. Codex directs the Browser; local deterministic code persists frames, stamps receipt timing, renders, encodes, and checks artifacts. Never place raw frames, cookies, full DOM text, or private page data in model context.

## Preconditions

- Require Codex Desktop Browser. Do not claim that CLI or IDE integrations can drive it.
- Confirm the URL, objective, allowed origin scope, and that the intended actions are authorized.
- Stop for credentials, MFA/OTP, CAPTCHA, consent/device permissions, payments, uploads, downloads, legal acceptance, publishing, deletion, access changes, or any irreversible action. Do not bypass controls.
- Confirm the host exposes `browser_run_code_unsafe` before attempting capture. The local MCP service cannot itself drive Browser actions; that host capability is required to run the generated start/stop helpers.

## MCP session flow

1. Call `create_recording_session` with `url` and `objective`. Add `allowedOrigins` only when the default origin is insufficient; use `allowPrivateOrigin` only with explicit authorization.
2. Read the returned session ID, browser-start helper, browser-stop helper, and capture configuration. Helpers are one-session entrypoints, not arbitrary scripts.
3. Rehearse in Browser: opening state, one clear action, and an observable result. Keep the viewport fixed. Use `record_browser_event` only for planned semantic `pointer`, `click`, `scroll`, `navigation`, `viewport`, and `marker` context. Planned events do not count as observed-action evidence. Validate the visible state after each action.
4. Run the start helper once through `browser_run_code_unsafe`, perform the approved flow, then run the matching stop helper once. The helper claims a one-time loopback capability and posts screencast frames directly to the local broker. Observation stays unarmed until the broker durably accepts frame one. CDP must then provide a nonempty main-frame ID, loader ID, URL, and `securityOrigin` exactly matching the recording origin; mismatch fails before challenge or observer installation. For each valid epoch, the broker independently parses the document URL, permits only credential-free HTTP(S), and requires its canonical origin to match the session and request origins before returning a fresh authenticated, nonpersistent 256-bit marker. Start succeeds with `observedReady: true` only after isolated evaluation succeeds and an exact console ready handshake pins the first valid closure-only 256-bit nonce, within a 10-second readiness limit. Timeout fails capture and performs per-step 250 ms best-effort teardown including CDP detach. After readiness, the helper observes only trusted clicks and trusted-wheel-derived scrolling. The trusted CDP/DevTools boundary accepts only isolated `console.debug` messages with exactly two direct strings, exact current marker equality, a payload no larger than 4 KiB, and the exact ready or event envelope. Old epoch markers, old nonces, and conflicting later ready nonces are ignored; malformed routed payloads or matching-route activity during a navigation readiness gap fail closed. No Runtime binding APIs are used, and `executionContextId` remains diagnostic/non-gating. The helper strips marker and nonce before broker delivery, so neither enters artifacts. A capture may issue at most 32 observer challenges.
5. Call `inspect_recording_session`. If capture is complete, call `seal_recording_capture`. Sealing requires a successful browser summary, complete acknowledgements, and broker receipt timing; it then renders and quality-checks the recording.
6. Treat the returned MP4, delivery manifest, and quality report as a delivery only when the report says approved. Otherwise report the failed gate and use `discard_recording_session` for an abandoned session.

## Editable project flow

1. After a capture is sealed and quality-approved, call `create_recording_project` with its session ID.
2. Call `inspect_recording_project` before editing. Treat the canonical project as one complete versioned document.
3. Submit a validated full-document revision through `revise_recording_project`. Manual and bounded automated revision modes are distinct; never bypass the automatic revision limit.
4. Call `render_recording_project_preview` with the exact current revision and inspect the resulting artifact.
5. Call `render_recording_project_final` only after a matching preview exists for that same revision. If the project changed, render a new preview first.

The project may declare trims, constant or ramped speed, cuts/crossfades, observed cursor/click effects, manual or automatic zooms, annotations, captions, PiP, WAV audio, and explicit local render hooks. MP4 and GIF are supported; GIF cannot contain audio. A rendered artifact is a candidate until the required preview/final state and human editorial review are satisfied.

## Quality and honesty

- Receipt timing is local broker evidence: the first accepted frame is offset zero, later frame offsets are strictly increasing, and automatically observed trusted-click and trusted-wheel-derived scroll actions share that receipt clock. Do not invent or submit timing or observed actions through MCP.
- Observed evidence is intentionally narrow: trusted-click coordinates/button, plus the first nonzero actual window scroll position/delta found within a bounded window of at most 120 animation-frame attempts spaced by 16 ms after a trusted wheel, roughly two seconds. No movement in that window produces no scroll evidence. Never expand observation to selectors, element text, DOM, cookies, storage, or the target URL path.
- The sealed-capture baseline is a clean 1080p, 30 fps, limited-range, silent H.264 deliverable with media and decoded composition checks. The intended v0.3.0 project renderer can add source-keyed cursor motion, click ripple/bounce effects, zooms, overlays, PiP, audio, ramps, and transitions from validated project inputs. Never invent missing observed evidence.
- Treat “near-output parity” as a bounded composition claim, not Recordly source/API compatibility, pixel identity, editor parity, or feature completeness. Recordly code and assets are outside this Apache-2.0 clean-room implementation.
- Action alignment is temporal and visible, not causal or semantic: approval requires an automatically observed action, a decoded visual change in the allowed result window, and a sufficient final hold. It does not prove that the action caused the change or that the result satisfies the objective.
- A successful tool call or click is not a successful shot. Check the page's visible result, capture summary, and quality report. Treat missing/malformed observed evidence, no decoded change, insufficient final hold, clipping, frozen frames, incomplete receipt timing, or media mismatch as a failed approval.
- Report an unsupported Browser host capability, blocked approval, failed capture, or candidate-quality output plainly. Do not promise autonomous completion for arbitrary sites.
- The published v0.2.0 release remains the latest marketplace and authorized-site proof. Until v0.3.0 is released, clean-installed, and accepted on an approved site, describe its project/render capabilities as locally verified candidate behavior.
