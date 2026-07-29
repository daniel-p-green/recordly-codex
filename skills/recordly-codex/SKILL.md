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
3. Rehearse in Browser: opening state, one clear action, and an observable result. Keep the viewport fixed. Use `record_browser_event` only for semantic `pointer`, `click`, `scroll`, `navigation`, `viewport`, and `marker` events. Validate the visible state after each action.
4. Run the start helper once through `browser_run_code_unsafe`, perform the approved flow, then run the matching stop helper once. The helper claims a one-time loopback capability and posts screencast frames directly to the local broker. Frames never pass through the model.
5. Call `inspect_recording_session`. If capture is complete, call `seal_recording_capture`. Sealing requires a successful browser summary, complete acknowledgements, and broker receipt timing; it then renders and quality-checks the recording.
6. Treat the returned MP4, delivery manifest, and quality report as a delivery only when the report says approved. Otherwise report the failed gate and use `discard_recording_session` for an abandoned session.

## Quality and honesty

- Receipt timing is local broker evidence: the first accepted frame is offset zero and later offsets are strictly increasing. Do not invent or submit timing through MCP.
- The baseline renderer is a clean 1080p, 30 fps, silent deliverable. Do not claim cursor paths, click ripples, or zoom effects unless synchronized telemetry supports them.
- A successful tool call or click is not a successful shot. Check the page's visible result, the capture summary, and then the quality report.
- Report an unsupported Browser host capability, blocked approval, failed capture, or candidate-quality output plainly. Do not promise autonomous completion for arbitrary sites.
