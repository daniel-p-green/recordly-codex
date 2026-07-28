---
name: recordly-codex
description: Plan, rehearse, and quality-gate deterministic interactive website recordings through Codex Browser. Use when a user asks Codex to turn an approved URL or site workflow into a professional recording plan, capture manifest, or browser-driven demo video.
---

# Recordly Codex

Create repeatable website-recording workflows for Codex Desktop Browser. Treat this skill as a director and quality controller; use deterministic code for capture, rendering, encoding, and artifact checks once those runtime components exist.

## Preconditions

- Require Codex Desktop Browser (`browser:browser`, target `iab`) for browser inspection and interaction. Do not claim CLI or IDE browser support.
- Confirm that the target URL and intended actions are authorized. Use public or explicitly pre-authenticated sessions only.
- Stop for user approval when a workflow reaches credentials, payment, irreversible actions, CAPTCHA, consent prompts, file uploads containing sensitive material, or browser permission prompts that Codex cannot safely approve.
- Do not attempt to bypass access controls, anti-bot controls, rate limits, or browser safety boundaries.

## Workflow

1. Inspect the approved target at a fixed viewport and identify the shortest user-visible story: opening state, key action, observable result, and ending state.
2. Write a shot plan before acting. Give each shot a stable identifier, purpose, expected visible state, action, wait condition, and retry limit.
3. Rehearse the full interaction in Browser. Record semantic action telemetry such as timestamp, click point, scroll position, navigation, viewport, and visible assertion. Do not treat a successful click as proof of the intended result.
4. Produce a deterministic recording manifest from the rehearsal. Keep narrative choices separate from captured evidence so the same manifest can be rendered consistently.
5. Capture only after the rehearsal passes. Use a fixed viewport, explicit waits, bounded retries, and a known output directory. Never place full frame streams or recordings in model context.
6. Render from the manifest with deterministic tooling. Add cursor paths, click effects, framing, zooms, captions, backgrounds, and encoding only when the runtime supports them and the result is traceable to manifest data.
7. Quality-check duration, output dimensions, frozen frames, action/result alignment, visible clipping, and final-state assertions. Retry only failed shots within their bounds; otherwise return the evidence and blocker.

## Manifest contract

Use one versioned JSON manifest as the handoff between planning, capture, rendering, and QA. Include at least:

- `schemaVersion`, `recordingId`, and creation metadata.
- Approved target URL, viewport, and session assumptions. Never put secrets or cookies in the manifest.
- Ordered shot definitions, deterministic action telemetry, visible assertions, and retry limits.
- Capture artifact references with timestamps and hashes when available.
- Render profile, output path, and quality-gate results.

Treat the manifest as an append-only evidence record during a run. Generate a new manifest revision for a deliberate replan rather than mutating captured evidence.

## Completion language

Say a recording is complete only after the requested media file and its manifest pass the declared quality gates. If a browser permission, identity challenge, unavailable browser feature, or unsupported website behavior blocks the workflow, report the exact blocked shot and the smallest human action needed. Do not promise unattended completion for arbitrary sites.
