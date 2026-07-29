# Capability matrix

This is the v0.5.0 source and fixture contract, supplemented by one authorized public-workflow acceptance run. That run used the Codex Playwright helper surface on `https://recordly.dev/`; it is not a claim of native in-app Browser capture, a tagged release, or a clean-installed plugin.

| Area | Supported behavior | Boundary |
| --- | --- | --- |
| Host | Codex Desktop Browser is the only supported interaction surface | No Codex CLI or IDE browser-control claim |
| Targets | Public or explicitly authorized, pre-authenticated browser workflows | Stop for auth, MFA, CAPTCHA, secrets, consent/device permissions, payments, sensitive uploads, legal acceptance, publishing, deletion, access changes, and irreversible actions |
| MCP surface | 20 tools across capture, project, preview QA, media, profiles, and editorial | Capture, sealed delivery, project, preview, judgment, and final are distinct states |
| Capture | Per-session Browser helpers stream CDP screencast frames to a loopback broker | Browser-scoped only. No native display/window, microphone, system-audio, or desktop capture |
| Evidence | Durable frames and trusted click / wheel-derived scroll observations share broker receipt timing | Planned MCP events are context only. No DOM, selectors, text, cookies, storage, or page path capture |
| Sealed delivery | Deterministic CFR MP4 plus manifest and quality report, gated by visible-result, final-hold, frozen-frame, clipping, privacy, and media checks | A sealed delivery proves only its bounded evidence and gates, not objective correctness or general aesthetic quality |
| Project editing | Versioned full-document revisions, trims, speed regions, cuts/crossfades, observed cursor/click effects, zooms, annotations, captions, and constrained presentation | No GUI timeline, collaborative merge editor, arbitrary patch API, `.recordly` compatibility, or Recordly editor parity |
| Profiles | Fixed built-ins plus owner-local, digest-bound profile snapshots | Profile application is an explicit revision. Built-ins cover landscape 1920×1080, square 1080×1080, and vertical 1080×1920 |
| Imported media | Image, video, and audio can be imported from `RECORDLY_CODEX_IMPORT_ROOT` using only a bounded relative file name | No caller-supplied path/root, remote import, live webcam/mic capture, or browser/system-audio capture. Audio is imported and normalized to WAV |
| Editorial | Evidence-backed zoom proposals can be applied only by explicit accepted proposal IDs and exact proposal digest | Trim proposals and transition suggestions are review-only. Do not apply them automatically |
| Preview QA | A current preview can be decoded into technical evidence plus a contact-sheet image and then receive an immutable digest-bound accept/revise/reject judgment | A new revision stales prior preview/judgment evidence. Final requires a matching preview and accepted current judgment |
| Output | Deterministic MP4 or GIF, with draft/standard/high profiles; GIF rejects audio | No native export dialogs, arbitrary codecs, alpha video, variable-frame-rate output, or Recordly’s full export controls |
| Test proof | Output-parity fixtures render preview and final as MP4 and GIF at 1920×1080, 1080×1080, and 1080×1920, then decode checkpoints. One authorized public v0.5.0 run accepted 572/572 frames, passed its seal gates, applied an observed-input zoom, and visually accepted its 1080×1080 preview before final rendering | Fixture proof is neither pixel identity nor broad live-workflow proof. The public run was a Codex Playwright-helper proof, not native in-app Browser capture, release, or clean-install proof |
| Privacy | Private, contained artifact roots and digest-verified staging snapshots | No visual-redaction guarantee. An authorized page may still show sensitive pixels |

Compared with the public Recordly desktop app, this implementation is intentionally narrower: it has no native capture backends, GUI timeline, saved `.recordly` projects, marketplace extensions, broad background/wallpaper controls, dynamic webcam controls, or full export-control surface. Recordly Codex is independently implemented and does not claim source, API, file-format, editor, or pixel parity.
