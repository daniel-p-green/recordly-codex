# v1 acceptance evidence

The v1 release gate requires 12 privacy-safe live runs: three repetitions for each workflow class in the [v1 roadmap](v1-roadmap.md). Fixture, helper-only, and Playwright-only results do not satisfy this gate.

## Evidence rules

- Use the actual Codex Desktop Browser surface.
- Use only public, authorized HTTPS origins. Store the origin only, never a URL path, query, fragment, credentials, DOM, page text, token, cookie, helper content, or local artifact path.
- All 12 runs must use the same `1.0.0` candidate and committed bundle SHA-256.
- Each run must accept and acknowledge every received frame with zero rejected frames.
- The sealed capture must be approved.
- Preview judgment must be current and accepted.
- The final SHA-256 must be recorded and independently verified.
- A required stop or suspected sensitive-pixel exposure invalidates the run.

## Workflow classes

1. `static-click`
2. `spa-transition`
3. `animated-scroll`
4. `responsive-outputs`

Each class must contain repetitions `1`, `2`, and `3`, with unique run IDs.

## Validation

Keep the sanitized live ledger outside Git until it has been reviewed for privacy. Validate it with:

```bash
npm run acceptance:v1:validate -- --partial /absolute/path/to/sanitized-live-evidence.json
npm run acceptance:v1:validate -- /absolute/path/to/sanitized-live-evidence.json
```

Partial mode validates one through twelve entries against the same exact run schema and reports
that it is not final proof. The final validator still requires exactly 12 passing runs and
rejects extra fields so raw evidence cannot silently widen the ledger. Both modes report only
the candidate version, bundle SHA-256, run count, and workflow count.

The validator’s accepted shape and failure behavior are exercised in `test/unit/v1-acceptance-evidence.test.ts`. Passing that unit test proves the evidence contract, not that any live acceptance run occurred.

## Current status

The current acceptance ledger is `1/12` for the unreleased `1.0.0` candidate bundle
`bd1bb578327e39359781fec4aed674651783815d724cf2fd974248bec7ff3395`.

Three static-click runs completed on July 29-30, 2026 against the prior bundle
`fd9cdfccf0b0473d41f6f0abe15bca39a8e7fbf183b680cc5236d6f9225cedec`. They remain preserved as
superseded historical evidence outside Git, but they no longer count because SPA qualification
exposed an idle-page startup defect and changed the candidate bundle. All 12 release-gating runs,
including the static-click class, must be repeated against the new exact digest.

The rebuilt helper passed a non-counting actual Codex Desktop Browser proof on the idle Vite guide:
observation became ready without an external paint workaround, and stop accounting reported one
received, accepted, and acknowledged frame with zero rejections. Counted SPA runs remain
outstanding.

Static-click repetition 1 then passed under Node `22.23.1` with FFmpeg/FFprobe `8.1.2`:
`18/18/18` received, accepted, and acknowledged frames; zero rejections; approved capture seal;
visually accepted contact sheet; current preview judgment; mode-`0600` final; full independent
decode; and matching preview/final SHA-256
`2c90e27dc736e994304e5975080ed5a6dd69b25a612fb8496e96a25cf12b0134`.
The privacy-safe partial ledger remains outside Git and passes strict partial validation.

A July 29, 2026 pre-v1 rehearsal first exposed two
fail-closed gaps: the Browser host reports injected DOM events as untrusted, and YUV420
vertical pad alignment differed by one row from the clipping predictor. After adding a private
capture-owned action adapter and matching the deterministic even-row composition geometry, a
fresh actual Codex Desktop Browser run:

- recorded one capture-owned click and independently verified the visible navigation result;
- received, accepted, and acknowledged `22/22` frames with zero rejections;
- passed action alignment, final hold, clipping, decodeability, privacy, and receipt-timing
  gates; and
- produced an approved sealed delivery from bundle
  `d1f7c146dc63a20098338ccc0707e327428a770f77de011e98a5d7789a04742f`.

This is host-path and sealed-delivery rehearsal proof only. It does not count because the local
runtime was unsupported Node 26 and the run did not continue through current digest-bound
preview acceptance and independently verified final output.
