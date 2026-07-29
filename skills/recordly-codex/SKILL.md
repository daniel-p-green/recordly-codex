---
name: recordly-codex
description: Create and finish evidence-backed recordings of safe, approved website workflows through Codex Desktop Browser and the local Recordly Codex MCP tools. Use for public or explicitly authorized pre-authenticated URLs, capture-to-final rendering, digest-bound preview inspection and model judgment, profiles, imported media, or evidence-backed editorial zooms. Stop for authentication, CAPTCHA, secrets, consent or device permissions, payments, sensitive uploads, legal acceptance, publishing, deletion, access changes, or irreversible actions.
---

# Recordly Codex

Use Codex Desktop Browser only. For a safe approved workflow, carry the recording through final autonomously: verify visible browser results, inspect the preview image, record a precise judgment, and make only bounded revisions. Local code persists frames, receipt timing, rendering, encoding, and checks. Never put raw frames, cookies, page text, DOM, storage, or credentials in model context.

## Preconditions and hard stops

- Confirm the URL, objective, and intended actions are public or explicitly authorized and pre-authenticated.
- Stop and request direction for login, MFA/OTP, CAPTCHA, secrets, consent or device permission, payment, sensitive upload, download requiring confirmation, legal acceptance, publishing, deletion, access changes, or any irreversible action. Never bypass a browser or site safety control.
- Require the Codex Desktop Browser host capability needed to run the returned Browser helpers. Do not claim CLI or IDE browser control.
- Treat the canonical origin derived from the URL as fixed. Do not look for a custom origin-set parameter.

## Capture to sealed delivery

1. Call `create_recording_session` with `url` and `objective`; use bounded capture limits only when needed.
2. Read the returned one-session Browser helper entrypoints and capture configuration. Treat helper contents as private: execute them only through the returned matching one-session Codex Desktop Browser entrypoint. Do not paste, log, store, or share their contents.
3. In Codex Desktop Browser, establish the opening state and perform only the approved workflow. After every action, inspect the visible result. `record_browser_event` may record planned semantic context, but it never satisfies observed-action evidence.
4. Run the matching start helper once, complete the approved flow, and run the matching stop helper once. Do not inject alternate capture code or attempt native/window/audio capture.
5. Inspect the session. If the capture stopped cleanly, call `seal_recording_capture`. Continue only when its quality report is approved; otherwise report the failed gate and discard the abandoned session.

The broker owns durable frame timing and narrow trusted click / wheel-derived scroll observations. Do not invent observed actions, timing, selectors, page text, or causal claims. A click or successful tool call is not a completed shot; the visible result and sealed QA gates decide that.

## Project to final

1. Call `create_recording_project` from an approved sealed capture, then `inspect_recording_project`.
2. Optionally use profiles: list/get a profile, create an owner-local snapshot, or update one with its exact expected revision and digest, then apply it to the exact current project. Profile application creates a revision.
3. Import optional image, video, or audio only from the runtime-configured `RECORDLY_CODEX_IMPORT_ROOT`. Pass a bounded relative file name, never a path or import root. Imported audio is normalized to WAV; imported media is not live webcam, microphone, browser audio, or system audio capture.
4. Call `propose_recording_project_editorial` for the exact current revision. Assess the returned evidence and select zoom proposal IDs deliberately. Apply only those IDs with `apply_accepted_recording_project_editorial`, the exact project revision, and exact proposal SHA-256. Treat trim proposals and transition suggestions as review-only.
5. Make any further full-document edit with `revise_recording_project`. Use automated mode only within its remaining revision budget.
6. Render the exact current revision with `render_recording_project_preview`, then call `inspect_recording_project_preview`. Inspect the returned contact-sheet image and technical QA.
7. Call `judge_recording_project_preview` with the exact project SHA-256 and preview artifact SHA-256 returned by inspection. Use `accept`, `revise`, or `reject` and attach concise, time-bounded issues. On `revise`, create a new bounded revision and repeat preview, inspection, and judgment. Do not reuse stale evidence.
8. Call `render_recording_project_final` only for the exact current revision after its matching preview and accepted current judgment. Report the final artifact digest and what proof was used.

## Scope and honesty

- MP4 and GIF are supported; GIF has no audio. Built-in output geometries are 1920×1080 landscape, 1080×1080 square, and 1080×1920 vertical.
- The renderer supports bounded composition, not Recordly editor compatibility. There is no native display/window/microphone/system-audio capture, GUI timeline, `.recordly` compatibility, marketplace extension support, or broad Recordly background, webcam, and export controls.
- Fixture and source checks prove bounded behavior only. Do not claim a released, clean-installed plugin or a live Codex Desktop Browser workflow until those have been independently verified.
