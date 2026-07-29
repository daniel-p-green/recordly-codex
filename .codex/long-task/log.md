# Work log

Record meaningful milestones only. Keep entries concise and evidence-based.

## 2026-07-28 — Goal and public foundation initialized

- Outcome: Defined the Browser-first, deterministic-recording objective and created the public plugin/governance/tooling scaffold.
- Verified: Initial repository state contained no tracked project files; the installed Codex plugin validator and skill validator define the manifest contract used by this scaffold.
- Next: Validate the scaffold after dependency installation, then define the recording-manifest contract through red tests.
- Blocker or risk: GitHub repository creation, default branch protection, and actual Codex Desktop Browser installation proof require separate live checks. Capture/render support is not implemented.

## 2026-07-28 — Contract core verified; render fixture remains pending

- Outcome: Established a tested TypeScript contract core for request validation, session events, capture-frame representation, coordinates, frame-grid normalization, and deterministic zoom selection.
- Verified: Public repository exists at `github.com/daniel-p-green/recordly-codex`; plugin validation passes; 15 unit tests pass with 97.69% statement and 91.89% branch coverage.
- Next: Define the remaining versioned recording-manifest, shot-plan, and quality-report contracts, then add a sanitized render fixture before implementing capture or export.
- Blocker or risk: `fixtures:validate` is currently a placeholder because there is no render fixture. No browser capture, media rendering, encoding, or end-to-end recording proof exists.

## 2026-07-28 — Capture-render vertical slice and loopback E2E verified

- Outcome: Completed the local capture-render tranche: bounded CDP screencast intake, immutable frame evidence, canonical manifest/timeline compilation, deterministic render/encode fixtures, and a loopback-only system-Chrome E2E path.
- Verified: The public protected repository's initial CI is green. A clean `npm ci` completed with zero reported audit vulnerabilities. The 34-test suite reported 93.92% line and 85.74% branch coverage before final CI threshold configuration. The E2E fixture blocks external requests and verifies a 1920x1080, 30 fps, 30-frame silent H.264 MP4, manifest, telemetry, and sampled frame.
- Next: Add the Codex Desktop Browser-to-local-engine MCP/control bridge, then run and preserve evidence from one real approved public-site workflow.
- Blocker or risk: The E2E browser is system Chrome driven by Playwright Core. It is intentionally not evidence that Codex Browser can control the local runtime or that an arbitrary approved site is safe for unattended recording.

## 2026-07-28 — Browser helper containment verified; Browser runtime boundary remains blocked

- Outcome: Moved generated start/stop helpers into the ignored, fixed `.playwright-mcp/recordly-codex/<session-id>/` bridge while keeping configuration, telemetry, frames, and summaries under the private owned artifact root.
- Verified: Built stdio MCP still exposes exactly five tools. The focused bridge contract has 18 passing tests; the full suite has 62 passing tests, with 91.35% lines and 82.26% branches. Helpers and per-session bridge directories are private, symlink-checked, and removed with the matching owned session. `npm ci`, `npm run check`, and plugin validation pass.
- Next: Add a persistent local bridge or Browser-supported module-loading contract before claiming real Codex Browser capture support.
- Blocker or risk: The earlier module-loader approach was not a viable capture path. It is superseded by the generated helper and loopback-broker design recorded below; do not interpret this historical entry as the current capability statement.

## 2026-07-28 — Brokered Browser capture and delivery documentation reconciled

- Outcome: Replaced the blocked runtime assumption with the supported helper-to-loopback-broker path. The public contract now names the five MCP tools, helper claim, receipt timing, seal-triggered delivery, privacy boundary, and required Browser host capability.
- Verified: Final approved live evidence covered the authorized public workflow at a high level: helper claim, bounded hero/scroll capture, receipt-timed render, and contained MP4/manifest/quality-report delivery. No captured pixels, local paths, tokens, or hashes are retained in public documentation.
- Next: Perform marketplace installation and Codex Desktop compatibility checks from a released revision; preserve only sanitized proof.
- Blocker or risk: `browser_run_code_unsafe`, FFmpeg/FFprobe, and the Codex Desktop marketplace install are host/runtime prerequisites. Unsupported sensitive or irreversible actions still stop for a user.
