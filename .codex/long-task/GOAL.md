# Goal

## Outcome

Deliver a public, reproducible Codex plugin named `recordly-codex` and a first vertical-slice path for turning an approved website URL and objective into a quality-gated interactive recording. Codex Desktop Browser directs the workflow while local deterministic code owns capture, composition, encoding, and verification.

## Constraints

- Keep the repository public-safe from its first commit: no secrets, cookies, captured frames, personal data, private URLs, or unlicensed third-party code/assets.
- Support Codex Desktop Browser first. Do not promise browser control in Codex CLI or IDE environments.
- Permit unattended execution only for public or explicitly pre-authenticated, user-authorized flows. Stop at credentials, CAPTCHAs, browser permissions, payments, sensitive uploads, irreversible actions, and other user-only confirmations.
- Treat Recordly as an upstream reference, not a copy source. Do not incorporate AGPL-3.0 implementation or assets without a written license-compliance decision.
- Use strict TypeScript, red-green-refactor for executable behavior, deterministic manifests, and evidence-backed quality gates.
- Prefer a small vertical slice over a speculative editor clone. No native desktop app or hosted service is in the initial scope.

## Evidence

- `.codex-plugin/plugin.json` and `skills/recordly-codex/SKILL.md` define the Codex-facing contract.
- `README.md`, `docs/architecture.md`, `docs/threat-model.md`, and `docs/licensing.md` define public scope and safety constraints.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json`, and `.github/workflows/` define the reproducible engineering gate.
- The public repository is `https://github.com/daniel-p-green/recordly-codex`, protected from direct changes, and its initial CI run is green. Plugin validation passes; a clean `npm ci` completes with zero reported audit vulnerabilities.
- The completed local vertical slice includes the request/event contracts, a bounded CDP screencast capture adapter, immutable frame-hash verification, a canonical sanitized manifest, deterministic CFR timeline compilation, and deterministic render/encode fixtures.
- A system-Chrome, loopback-only E2E fixture proves opening -> action -> result capture evidence, a compiled manifest and telemetry, a decoded MP4, and a sampled output frame without external requests. It produces a valid 1920x1080, 30 fps, 30-frame silent H.264 MP4.
- The suite has 34 passing tests. Before final CI coverage-threshold configuration, the coverage report was 93.92% lines and 85.74% branches.
- The Codex Desktop Browser-to-local-engine MCP/control bridge and a real approved public-site demo remain unproven.

## Milestones

1. Establish public repository governance, plugin scaffold, strict tooling, CI, and tag-gated source release. **Complete:** the public protected repository and initial CI run are green.
2. Define versioned recording-manifest, shot-plan, and quality-report contracts with red tests. **Partially complete:** request/event/CFR/coordinate/frame-grid/zoom contracts and canonical recording-manifest compilation are implemented and tested; standalone shot-plan and quality-report contracts remain.
3. Build a local deterministic vertical slice for a sanitized fixture: fixed viewport, bounded scripted interactions, capture evidence, basic cursor/click treatment, and MP4 export. **Complete for the system-Chrome loopback fixture; not yet complete for Codex Browser or a real approved public site.**
4. Add visual and technical quality gates with one bounded retry path and a manifest-backed final report.
5. Validate installability in Codex Desktop, run a real approved-site demonstration, and publish a candid capability/limitation matrix.

## Done when

- [x] A public repository contains a valid Codex plugin, contributor/security governance, and reproducible CI/release controls.
- [ ] The plugin directs Codex through authorized Browser-only recording workflows without claiming unsupported autonomy.
- [ ] A tested local vertical slice produces a 1080p MP4 and a sanitized versioned manifest from an approved public fixture. The completed proof uses an explicitly permitted loopback fixture, not a real approved public site.
- [ ] Automated checks verify browser action/result alignment, output dimensions/duration, decodeability, frozen-frame detection, clipping checks, and declared final state.
- [x] The public documentation names the supported environment, privacy boundary, upstream license boundary, and human-intervention triggers.
- [x] Remaining unsupported workflows and production risks are explicit.
