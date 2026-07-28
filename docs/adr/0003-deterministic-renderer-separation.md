# ADR 0003: Separate deterministic rendering from model-directed capture

- Status: Accepted
- Date: 2026-07-28

## Context

Models are useful for deciding a narrative and interpreting sampled QA, but they are unsuitable for per-frame processing, reproducible output, and untrusted capture handling. Page content must not gain render or system authority.

## Decision

Compile immutable captured frames and telemetry into a versioned timeline. A pure renderer consumes only that timeline, generated design preset, and frame files. Encoding uses a pinned binary through an argument-array allowlist. The model sees only sanitized plan/QA summaries and optional redacted, downscaled samples.

## Consequences

The pipeline can be unit-tested and rendered reproducibly from fixtures. Rendering cannot use the browser or network, so new visual features require explicit timeline/schema work rather than prompt changes. Visual QA remains probabilistic and is a gate for retries, not a provenance guarantee.
