# Recordly Codex

Recordly Codex is an Apache-2.0 Codex plugin and local TypeScript runtime for producing evidence-backed recordings of approved browser workflows. Codex Desktop Browser performs the approved interaction; local code owns capture evidence, timing, rendering, encoding, and artifact checks. It does not use another visible recording app.

v0.5.0 has source, fixture, one authorized public-workflow, public-release, and clean-install proof. The live workflow remains bounded to the helper surface and one approved site.

`main` is now the unreleased v1.0.0 candidate line. Install the verified v0.5.0 tag until v1.0.0 completes its acceptance, CI, security, lifecycle, and release-integrity gates.

## Supported workflow

Use only Codex Desktop Browser with public or explicitly authorized, pre-authenticated sites. Create a session from an approved URL and objective, capture the visible result, seal a quality-approved capture, then create and render a versioned project.

## Released installation

Install the public [`v0.5.0` release](https://github.com/daniel-p-green/recordly-codex/releases/tag/v0.5.0) with the marketplace selector declared by this repository:

```bash
codex plugin marketplace add daniel-p-green/recordly-codex --ref v0.5.0
codex plugin add recordly-codex@recordly-codex
```

`recordly-codex@recordly-codex` selects the one `recordly-codex` plugin in `.agents/plugins/marketplace.json`; its source is the repository root, which preserves the `.codex-plugin/` and `.mcp.json` layout. The committed standalone MCP bundle and [third-party notices](THIRD_PARTY_NOTICES.md) are included in the clean export. Node.js plus `ffmpeg` and `ffprobe` are still required on the host when sealing a capture.

PR [#13](https://github.com/daniel-p-green/recordly-codex/pull/13) merged to `main` at `5c92394fbf13400a532b6fd631889bf05cc532b0`. The default `main` CI rerun and an isolated release-workflow rerun passed, and the public release source archive exists. A clean isolated public marketplace installation reported `recordly-codex@recordly-codex` installed and enabled at `0.5.0`; its installed bundle SHA-256 was `966261cfe8988536a33f45c30d32b81fdd739cc47fd321b6f8b0fcbcda9f256e`. A sequential raw MCP check reported server version `0.5.0` and exactly 20 unique tools from `tools/list`.

The runtime exposes 20 local MCP tools:

| Stage | Tools |
| --- | --- |
| Capture | `create_recording_session`, `record_browser_event`, `inspect_recording_session`, `seal_recording_capture`, `discard_recording_session` |
| Project | `create_recording_project`, `inspect_recording_project`, `revise_recording_project`, `render_recording_project_preview`, `render_recording_project_final` |
| Preview QA | `inspect_recording_project_preview`, `judge_recording_project_preview` |
| Media | `import_recording_project_media` |
| Profiles | `list_recording_profiles`, `get_recording_profile`, `create_recording_profile`, `update_recording_profile`, `apply_recording_profile` |
| Editorial | `propose_recording_project_editorial`, `apply_accepted_recording_project_editorial` |

A safe approved workflow can run autonomously: Codex validates each visible browser result, renders a preview, inspects the returned contact-sheet image, records a digest-bound accept/revise/reject judgment, and renders final only after an accepted current preview. It still stops for authentication, CAPTCHA, secrets, payments, consent or device permissions, sensitive uploads, legal acceptance, publishing, deletion, access changes, or another irreversible action.

## v0.5.0 live acceptance evidence

One authorized public capture of `https://recordly.dev/` completed end to end through the Codex Playwright helper surface. The exact v0.5.0 MCP bundle exposed 20 tools and accepted and acknowledged all 572 received capture frames with zero rejections. Its seal passed action-alignment, clipping, decodeability, and privacy gates; the resulting project was migrated to V2, applied the built-in product profile, and applied one deterministic, observed-input zoom proposal.

The inspected square preview was 1080×1080 at 30 fps: 573 frames over 19.1 seconds, `yuv420p` TV range, with no audio. Its contact sheet was visually accepted with zero reported issues, and final rendering produced the same artifact digest as that accepted preview. Codex in-app Browser separately verified the visible hero-to-feature state. Computer Use successfully recorded the Codex window, but its action adapter degraded, so that recording is visual evidence only and is not action provenance. This proof used the helper surface, not a claim of native in-app Browser capture, and covers this one authorized workflow rather than all sites or workflows.

## Capture and evidence

`create_recording_session` accepts `url`, `objective`, and bounded capture limits. The recording origin is derived from the URL; the tool has no custom origin-set parameter.

Generated one-session Browser helpers send CDP screencast frames to a loopback broker. The broker persists frame receipts and narrow, trusted action evidence on one monotonic clock. Planned events submitted through `record_browser_event` are context only; they cannot stand in for observed actions. Treat the returned helper contents as private: execute them only through the returned, matching one-session Codex Desktop Browser entrypoint. Do not paste, log, store, or share their contents.

Codex Desktop Browser capture is a rehearsed one-shot operation: import both returned private
entrypoints and start capture, perform the already-approved Browser actions, verify the visible
result, and stop capture within one `node_repl` execution. The Browser capability is scoped to
that active execution context, so yielding between start and stop invalidates the capture. A
failed or interrupted attempt must be discarded rather than sealed.

Sealing fails closed unless the capture and media gates pass, including durable frame timing, a trusted observed action, a decoded visible result, final hold, frozen-frame, clipping, privacy, and media checks. A sealed delivery contains a deterministic MP4, manifest, and quality report.

## Project, preview, and final

Projects are canonical full documents with monotonic revisions and SHA-256 identities. They can declare bounded trims, speed changes, cuts/crossfades, cursor and click effects from observed evidence, zooms, annotations, captions, imported media, and constrained presentation settings.

The normal flow is:

1. Create and inspect a project from a sealed, quality-approved capture.
2. Optionally apply an exact built-in or owner-local profile, or import approved media from the configured root.
3. Request evidence-backed editorial suggestions. Only explicitly selected zoom proposal IDs can be applied. Trim and transition suggestions are review-only.
4. Render the exact current revision as a preview, then inspect its technical evidence and contact-sheet image.
5. Submit `judge_recording_project_preview` using the exact returned project and preview SHA-256 digests. A revise verdict requires a new bounded revision and a new preview.
6. Render final only after a matching preview and accepted current judgment exist. Any revision makes earlier preview and judgment evidence stale.

`RECORDLY_CODEX_IMPORT_ROOT` is a stable runtime configuration boundary for imported media. The import tool accepts only a bounded relative file name, never a caller-provided path or root. Image/video/audio bytes are copied into private digest-verified storage; imported audio is normalized to WAV. There is no direct device, URL, or arbitrary filesystem import.

## Outputs and proof

MP4 and GIF output are supported. GIF has no audio. Built-in profiles cover 1920×1080 landscape, 1080×1080 square, and 1080×1920 vertical output with draft, standard, and high quality settings. The output-parity fixture suite renders preview and final in both MP4 and GIF at all three geometries and decodes declared checkpoints. That is fixture proof, not pixel identity with Recordly or proof of all real-world workflows.

See [the capability matrix](docs/capability-matrix.md), [architecture](docs/architecture.md), [MCP protocol v0.5](docs/mcp-protocol-v0.5.md), [v1 MCP candidate](docs/mcp-protocol-v1-candidate.md), [v1 host support](docs/host-support-v1-candidate.md), [v1 persisted-state policy](docs/persisted-state-v1-candidate.md), [v1.0 goal and TODO](docs/v1-roadmap.md), [v1 acceptance evidence](docs/v1-acceptance-evidence.md), and [output-parity contract](docs/output-parity-v1.md) for the exact boundaries.

## Intentionally narrower than Recordly

Recordly Codex is not compatible with Recordly’s desktop editor or project format. It has no native display/window capture, microphone capture, system-audio capture, GUI timeline, `.recordly` import/export, marketplace extensions, or native Recordly capture backends. It only accepts imported audio/video, has narrower background, webcam, and export controls, and does not claim Recordly source, API, file, editor, or pixel parity.

## Developer checks

```bash
npm ci
npm run plugin:validate
npm run fixtures:output-parity:validate
npm run check
```

Requirements: Node.js 22.17+ on major 22 or Node.js 24, plus matching FFmpeg and FFprobe versions from FFmpeg 6.1.1 through 8.x. Run `npm run self-check -- --json` before recording. The local Chrome harness and fixture suite are test evidence, not a Codex Desktop Browser proof.
