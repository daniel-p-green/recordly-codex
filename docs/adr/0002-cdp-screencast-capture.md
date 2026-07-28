# ADR 0002: Capture browser content with CDP screencast frames

- Status: Accepted, capability-gated
- Date: 2026-07-28

## Context

The desired source is the Codex desktop Browser, without another visible screen-recording application. CDP provides browser-scoped frame delivery and aligns timestamps with browser actions. It does not promise native display capture behavior or constant frame cadence.

## Decision

Use `Page.startScreencast` through a capability-limited Browser adapter. Persist each received frame with monotonic timing and ACK it only after durable queueing. Normalize variable source cadence to constant output frame rate in the renderer. Fail a take on unsustainable backpressure or material active-shot gaps.

## Consequences

Capture is constrained to browser content and is suitable for deterministic silent demos. V1 has no system audio/webcam claim. The release test matrix must prove this capability in the supported Codex desktop runtime, and an unavailable capability produces a clear blocked result rather than a fallback to arbitrary desktop capture.
