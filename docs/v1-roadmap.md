# Recordly Codex v1.0 goal and TODO

## Goal

Release `v1.0.0` as a stable, clean-room Codex Desktop plugin for the documented browser-to-final workflow. A clean install of the tagged release must expose the frozen MCP contract and complete the acceptance matrix below without bypassing browser, authorization, privacy, or quality gates.

v1.0 is complete only when:

- the four-workflow public acceptance matrix passes three consecutive times per workflow (12/12 runs);
- every accepted run acknowledges all received frames, reports zero rejected frames, produces an approved sealed capture, receives a current digest-bound preview acceptance, and verifies the final artifact digest;
- the actual Codex Desktop Browser path is verified separately from helper-only or fixture proof;
- Node 22 and Node 24 quality jobs plus the plugin/fixture contract pass on three consecutive `main` runs;
- a clean install, upgrade from the last supported pre-1.0 release, raw MCP handshake, uninstall, and reinstall all pass in an isolated environment;
- the release tag, package metadata, plugin metadata, MCP server version, committed bundle, checksums, protocol documentation, capability matrix, and release notes agree;
- the security/privacy review has no unresolved high-severity findings, tracked code has zero lint warnings, and no private capture artifacts or machine-specific paths are present.

Stop and request a release decision if satisfying these gates would require expanding the documented authorization model, capturing credentials or sensitive pixels, weakening a fail-closed control, or claiming a host capability that Codex Desktop has not demonstrated.

## v1.0 scope

The supported product remains intentionally narrow: Codex Desktop Browser directs an approved workflow; the local runtime captures evidence, creates versioned projects, renders a judged preview, and publishes a deterministic MP4 or GIF final.

Native display/window capture, microphone or system-audio capture, a GUI timeline, `.recordly` compatibility, arbitrary codecs, hosted rendering, and Recordly feature parity are not v1.0 requirements.

## Acceptance matrix

Use public or explicitly authorized, privacy-safe targets. Record the URL, objective, host/runtime versions, checksums, capture counters, seal result, preview judgment, final digest, and any deviation for every run.

1. Static or server-rendered page with a click and visible result.
2. Client-rendered SPA with a route/state transition and visible result.
3. Long, animated page with sustained scrolling and final-state hold.
4. Responsive workflow rendered through landscape, square, and vertical project outputs.

## Prioritized TODO

### P0 — Stabilize the post-v0.5 line

- [x] Align package, lockfile, plugin, MCP server, tests, and committed bundle as the unreleased `1.0.0` candidate.
- [x] Restore zero tracked-code lint warnings after the modular runtime extraction.
- [x] Replace broad duplicate-file ignores with explicit cleanup so legitimate numbered fixtures remain visible to Git.
- [x] Pass `npm run check`, `npm run plugin:validate`, and `npm run test:coverage`.
- [x] Keep v0.5.1 unreleased; use v0.5.0 as the supported upgrade baseline and prove that exact lifecycle before v1.0.0.

### P0 — Freeze the v1 contract

- [x] Define the v1 compatibility policy for the 20 MCP tools, accepted schemas, structured outputs, persisted sessions, projects, profiles, and judgments.
- [x] Add machine-readable contract snapshots that fail on unreviewed tool/schema drift.
- [x] Document the candidate Codex Desktop, Node, FFmpeg, FFprobe, and operating-system support boundary; actual Desktop Browser proof remains a separate release gate.
- [x] Specify candidate upgrade and migration behavior, including explicit failure behavior for unsupported state; name the supported pre-1.0 version only after the isolated rehearsal passes.
- [x] Define artifact retention, discard, interrupted-broker recovery, and abandoned-session cleanup semantics.

### P0 — Prove the real Browser workflow

- [x] Build a privacy-safe acceptance-run manifest and result validator for the four workflow classes.
- [ ] Complete 12/12 acceptance runs with the evidence required by the goal. Current verified
  ledger: `0/12` for freeze-candidate bundle
  `35e6348dff874f5e1f8d2df0ff54486ab6ad338dc9dc53e99eadf027329c8ae9` after P0 hardening,
  diagnostics, and allowlisted packaging. Prior `1/12` evidence for
  `bd1bb578327e39359781fec4aed674651783815d724cf2fd974248bec7ff3395` is superseded and must be
  repeated against the frozen digest.
- [x] Verify the actual Codex Desktop Browser execution path independently of the legacy helper and fixture proof. The corrected pre-v1 one-shot rehearsal used a capture-owned click, visibly completed the approved navigation, captured and acknowledged 22/22 frames with zero rejections, and produced an approved sealed delivery. It does not count toward 12/12 acceptance because it ran under unsupported Node 26 and did not complete the preview-judgment and final-digest gates.
- [x] Add regression coverage for redirects, SPA execution-context replacement, broker interruption, timeout, frame backpressure, stale preview judgment, and failed final publication.
- [x] Make every supported failure return a bounded, actionable diagnostic without exposing helper tokens, raw URLs, page text, or local secrets.

### P1 — Make installation and operation supportable

- [x] Add a read-only self-check for Node, FFmpeg/FFprobe, writable private artifact storage, loopback availability, bundle integrity, and MCP handshake.
- [ ] Document install, first recording, project revision, preview judgment, final render, discard, upgrade, uninstall, and recovery paths.
- [ ] Test clean install, upgrade, uninstall, and reinstall in an isolated Codex profile.
- [ ] Define a sanitized support bundle containing versions, counters, error codes, and hashes but no frames, tokens, cookies, DOM, page text, or sensitive URL components.

### P1 — Complete security and release review

- [ ] Re-review the threat model against the final helper, broker, filesystem, media-import, FFmpeg, and publication paths.
- [ ] Run dependency, license, secret, tracked-artifact, local-path, and generated-bundle audits; resolve all high-severity findings.
- [x] Define and verify an allowlisted release archive. `package.json` `files` plus
  `scripts/release-package-files.json` and `npm run pack:check` reject the previous
  `.gitignore`-fallback tarball that included internal logs and test/CI sources.
- [ ] Verify fail-closed behavior for symlinks, traversal, capability replay, wrong origin, oversized payloads, malformed persisted state, and interrupted publication.
- [ ] Produce the v1 file manifest, checksums, third-party notices, changelog, protocol reference, capability matrix, and evidence ledger.
- [ ] Require three consecutive green `main` CI runs before tagging, then verify the tag and clean installed bundle independently.

### P2 — After v1.0

- [ ] Evaluate additional host platforms or capture capabilities only with separate capability, privacy, permission, and licensing decisions.
- [ ] Consider richer editing or export controls only when they preserve deterministic manifests, bounded inputs, and current preview approval.
