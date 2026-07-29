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

## 2026-07-28 — v0.1.0 release, marketplace install, and live delivery reconciled

- Outcome: Released `db660aa` as `v0.1.0`, verified the public protected-main release path, and completed the pinned Git marketplace installation and authorized `recordly.dev` delivery checks.
- Verified: PR #8, `main`, and tag CI are green; the release source asset is published. The installed marketplace bundle hash is `f6b1d381c0c06cfad8fcfae8775e31a4584b62976f99deec0a6c4270459f8744`, starts without `node_modules`, `dist`, `coverage`, or recording artifacts, and passes raw JSON-RPC initialize/list/create/discard with exactly five tools. The approved live capture rendered 661 source frames to 669 output frames in 22.3 seconds as 1920×1080, 30 fps, silent H.264 `yuv420p` limited-range video; broker receipt timing, privacy/hash checks, frozen-frame detection, final state, and visual QA passed.
- Remaining product gap at v0.1.0: decoded action/result alignment and clipping assertions were not implemented. The v0.2.0 candidate closes those automated QA gaps with broker-timed observed actions while keeping causal semantics, cursor/click/zoom overlays, and standalone shot-plan editing out of scope.

## 2026-07-28 — v0.2.0 observed-action and fail-closed QA candidate

- Outcome: Prepared the v0.2.0 package/plugin surfaces and public capability record for automatic trusted-click and trusted-wheel-derived scroll evidence, temporal visible-result alignment, decoded clipping QA, and fail-closed approval.
- Verified implementation: Observation remains unarmed until the broker durably accepts frame one. CDP document identity now requires nonempty ID, loader ID, URL, and `securityOrigin` exactly matching the recording origin; mismatch fails locally before challenge or isolated-world work. Each valid document epoch requests an authenticated fresh 256-bit marker with its document URL. Before phase/count/random side effects, the broker parses that URL, permits only credential-free HTTP(S), and requires its canonical origin to match the fixed session and declared request origins. Challenges are available only after the baseline, are never logged or persisted, and are capped at 32 per capture. Start returns `observedReady: true` only after isolated `Runtime.evaluate` succeeds without exception and an exact console ready handshake pins the first valid isolated-world nonce. The observer uses its captured `console.debug` to emit exactly two strings; CDP `Runtime.consoleAPICalled` filters for `debug`, the single current marker, direct-string payload at most 4 KiB, and exact ready or event shape. Runtime binding APIs are absent. Unmatched console traffic, retired markers/nonces, and conflicting later ready nonces are ignored; malformed routed payloads fail closed. A→B→A creates a fresh third epoch and cannot reuse A's first credentials. `executionContextId` is diagnostic/non-gating. The helper strips marker and nonce before broker event delivery, so neither enters broker evidence or artifacts. Initial readiness has a 10-second limit; timeout fails capture and gives each observation-tail, context cleanup, screencast stop, CDP detach, and failure-report step a 250 ms best-effort deadline. After readiness, the Browser helper accepts only `isTrusted` clicks and derives scroll evidence only from a trusted wheel. It checks a bounded window of at most 120 animation-frame attempts spaced by 16 ms, roughly two seconds, records the first nonzero actual resulting window position/delta, and emits nothing if the settlement window finds no movement. Generation-serialized activation deduplicates repeated navigation events for the active or in-flight document; a changed loader creates one replacement epoch, stale work retires, and only the newest world becomes active. Missing identity after arming or routed activity while the epoch is unready fails capture closed. Stop invalidates activation, waits for queued lifecycle and retired-context cleanup, detaches console observation, drains pending frame/action work, and then stops the screencast. Cleanup tolerates only a recognized context-already-destroyed race; other errors fail closed. The loopback broker rejects pre-baseline observations, validates exact schemas, origin and capability, applies body/rate/count bounds and scroll coalescing, assigns the frame receipt clock, and persists private records without following symlinks. The renderer verifies each artifact ancestor and frame realpath, maps observed actions to CFR frames, requires a decoded visible change and final hold, checks decoded source edges/border/matte/aspect, and withholds approval on any required failure.
- Claim boundary: Alignment proves only that a visible decoded change followed an observed action in the bounded window; it does not prove causation, page semantics, or objective correctness. Planned MCP telemetry cannot replace observed evidence. No cursor, click, zoom overlay, or standalone shot-plan editor is claimed.
- Release gate: Rebuild and validate the deterministic standalone bundle and notices, then repeat clean marketplace-install and authorized-site acceptance after v0.2.0 is published.

## 2026-07-28 — v0.2.0 headed acceptance and independent release audit passed

- Outcome: Completed a final headed acceptance of the authorized Recordly workflow through Codex Desktop Browser and an independent Terra High release audit. The audit judged the resulting recording professionally usable with no release blocker.
- Verified capture: Browser start returned `observedReady: true`. One trusted-wheel-derived scroll was captured and sanitized. Stop reported 1,010 received, accepted, and acknowledged frames, zero rejected frames, and no degradation.
- Verified delivery: Sealing approved a silent H.264 `yuv420p` limited-range MP4 at 1920×1080 and 30 fps. Full decode and probe checks reported 1,022 decoded frames over 34.066016 seconds with no audio. The observed action at frame 305 aligned to a visible result at frame 308; visible delta was 0.216615 against a 0.02 threshold, and final hold was 23.766666 seconds. Clipping, aspect, matte, border, frozen-frame, final-state, privacy, and hash gates passed. Inspected sensitive evidence files used mode `0600`.
- Verified release evidence: The latest security review cleared P0–P2. The deterministic bundle is 944,608 bytes with SHA-256 `ea7da03dfd3f4ac31d6dfb76a788aac3e2ad5d3d8c6c47e3265e3ceb9f39b0f2`. The canonical suite passes 97 tests across 17 files, plus fixture validation, typecheck, bundle reproducibility, and plugin validation.
- Publication and install gate closed: PR #9 merged to protected `main` at `b1a2f6e8c2de13439fd9f3a3f66fe8070c6c3871`; `main` and `v0.2.0` tag CI are green; and the validated release workflow published [v0.2.0](https://github.com/daniel-p-green/recordly-codex/releases/tag/v0.2.0). The 351,224-byte `recordly-codex-v0.2.0.tar.gz` source asset has release SHA-256 `74c0d8490a196bed64d96a82e8a4f69fe36eabff4125dd3bd23a706afdf0126a`. The marketplace is pinned to v0.2.0, and the plugin is installed and enabled at version 0.2.0 with bundle SHA-256 `ea7da03dfd3f4ac31d6dfb76a788aac3e2ad5d3d8c6c47e3265e3ceb9f39b0f2`. Before raw smoke, its cache had no `node_modules`, `dist`, `coverage`, `artifacts`, or `.playwright-mcp` directories, and no v0.1.0 cache. Raw JSON-RPC initialization listed exactly five expected tools; create/discard passed with empty stderr. Smoke-created empty helper directories were removed. No explicit v0.2.0 publication/install gate remains.

## 2026-07-29 — v0.3.0 editable project and renderer candidate

- Outcome: Added five editable-project MCP tools to the five capture-session tools and documented the intended v0.3.0 package. Projects are canonical full documents with monotonic revisions, bounded automated revision, exact-revision previews, and finals gated on a matching current preview.
- Verified implementation: The renderer supports MP4/GIF, trims, constant/ramped speed, cuts/crossfades, source-keyed cursor and click effects, manual/automatic zoom, annotations, captions, bounded PPM PiP, bounded WAV audio, declared hooks, and deterministic quality profiles. Capture frames and renderer media are consumed only from private exclusive digest-verified snapshots, with cleanup on success/failure; final publication uses an exclusive contained staging path and atomic rename.
- Evidence: The integrated suite passes 137 tests across 25 files, including explicit MP4 and GIF project E2E coverage. TypeScript, production build, deterministic bundle, plugin, fixture, and hygiene gates pass. The candidate bundle is 1,050,935 bytes with SHA-256 `97e6afa0001747a3620bec27cd647d16177b9df24c72e8caa7ab75011a440375`.
- Release gate at this milestone: Publish v0.3.0, clean-install it from the marketplace, verify exactly ten tools over raw stdio, and repeat an authorized-site Codex Desktop Browser acceptance workflow. This gate was subsequently closed in the release entry below.

## 2026-07-29 — v0.3.0 live candidate acceptance passed

- Outcome: Completed an approved Recordly.dev hero-to-features capture and carried its approved v0.2.0 sealed delivery through v0.3.0 project creation, revision, preview, and final without recapture.
- Capture evidence: Codex Desktop Browser accepted and acknowledged 892 frames with zero rejected frames. Private evidence files were mode `0600`, and visual QA passed.
- Migration evidence: A missing v0.2 cursor track migrated as an intentionally hidden cursor. Rendering did not depend on a legacy `0644` capture-event log, and proportional legacy screencast frames scaled to the sealed source geometry. Incompatible or unverified evidence remains fail-closed.
- Project/render evidence: Raw MCP exposed exactly ten tools. The decoded MP4 preview was 1920×1080 at 30 fps for 29.533333 seconds. The project advanced from revision 0 to 1 without recapture; the second preview and final produced the same deterministic SHA.
- Checks: The full suite passes 138 tests across 25 files. Before this final live-only no-code step, the deterministic 1,053,240-byte bundle had SHA-256 `6ab1455733de81bd8ac259b815f2d428c490335eed4e29ad1bcba5eea2e2a228`; build, typecheck, bundle/plugin, fixture, and hygiene gates were green.
- Release gate at this milestone: Publish the tag and repeat clean marketplace-install verification. This gate was subsequently closed in the release entry below.

## 2026-07-29 — v0.3.0 public release and installed verification complete

- Outcome: Merged commit `5e526b71d279eceb65ea24ce9dff6e9e8ecabfc5` to protected `main` and published [v0.3.0](https://github.com/daniel-p-green/recordly-codex/releases/tag/v0.3.0).
- CI evidence: Main run `30433535484` passed after a Node 22 infrastructure retry.
- Installed evidence: The plugin is installed and enabled at version 0.3.0. Its server reported 0.3.0, exposed exactly ten tools, passed create/discard smoke, and produced empty stderr.
- Integrity evidence: The installed bundle SHA-256 matched source at `6ab1455733de81bd8ac259b815f2d428c490335eed4e29ad1bcba5eea2e2a228`.
- Closeout: No v0.3.0 publication or install gate remains. The documented safety, host, authorization, and parity limitations still apply.
