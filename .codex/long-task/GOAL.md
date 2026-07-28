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
- The public repository is `https://github.com/daniel-p-green/recordly-codex`; local plugin validation passes.
- The contract core has 15 passing unit tests: 97.69% statement coverage and 91.89% branch coverage across the request schema, event stream, capture-frame representation, coordinates, frame grid, and zoom selection.
- A future end-to-end fixture must prove: approved URL -> shot plan -> rehearsal telemetry -> versioned manifest -> rendered MP4 -> automated quality report.

## Milestones

1. Establish public repository governance, plugin scaffold, strict tooling, CI, and tag-gated source release. **Implemented locally; awaiting the initial public commit and CI run.**
2. Define versioned recording-manifest, shot-plan, and quality-report contracts with red tests. **Partially complete:** request/event/CFR/coordinate/frame-grid/zoom contracts are implemented and unit-tested; the recording manifest, shot-plan, and quality-report schemas remain.
3. Build a local deterministic vertical slice for a sanitized public fixture: fixed viewport, bounded scripted interactions, capture evidence, basic cursor/click treatment, and MP4 export.
4. Add visual and technical quality gates with one bounded retry path and a manifest-backed final report.
5. Validate installability in Codex Desktop, run a real approved-site demonstration, and publish a candid capability/limitation matrix.

## Done when

- [ ] A public repository contains a valid Codex plugin, contributor/security governance, and reproducible CI/release controls.
- [ ] The plugin directs Codex through authorized Browser-only recording workflows without claiming unsupported autonomy.
- [ ] A tested local vertical slice produces a 1080p MP4 and a sanitized versioned manifest from an approved public fixture.
- [ ] Automated checks verify browser action/result alignment, output dimensions/duration, decodeability, frozen-frame detection, clipping checks, and declared final state.
- [x] The public documentation names the supported environment, privacy boundary, upstream license boundary, and human-intervention triggers.
- [x] Remaining unsupported workflows and production risks are explicit.
