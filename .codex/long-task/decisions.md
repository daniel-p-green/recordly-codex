# Decisions

## D-001 — Browser-first, deterministic pipeline

- Context: The intended experience is a URL-to-professional-recording workflow driven by Codex without a separate visible recording app.
- Decision: Use Codex Desktop Browser as the interaction surface; keep capture, rendering, encoding, and QA in local deterministic code coordinated by a versioned manifest.
- Alternatives considered: An Electron editor clone; model-only screenshot/video manipulation; a cloud-first capture service.
- Reason: This preserves browser-directed interaction while making media output reproducible, debuggable, and less token-intensive.
- Consequence or follow-up: Browser availability and permissions remain product constraints. The first implementation must prove frame capture and action telemetry before richer editing features.

## D-002 — Safe autonomy boundary

- Context: Fully unattended interaction with arbitrary sites can encounter identity checks, privileged actions, and security prompts.
- Decision: Autonomously handle only public or explicitly pre-authenticated, approved flows; stop at human-only or sensitive boundaries.
- Alternatives considered: Attempt universal autonomy; require a human at every interaction; silently bypass browser prompts.
- Reason: This is the narrowest honest product promise consistent with safe browser operation.
- Consequence or follow-up: The skill, manifest, and QA report must identify blocked shots and the smallest required human action.

## D-003 — Apache-2.0 for original code; no Recordly code ingestion

- Context: Recordly's AGPL-3.0 license creates distribution obligations if its implementation is incorporated.
- Decision: License original Recordly Codex work under Apache-2.0 and treat Recordly as a design reference unless maintainers explicitly approve an AGPL-compliant integration path.
- Alternatives considered: Make this repository AGPL-3.0 from the start; copy Recordly modules selectively; avoid all reference to Recordly.
- Reason: An independent clean-room foundation keeps early public distribution flexible while accurately naming the upstream boundary.
- Consequence or follow-up: Any future code, assets, or adapted algorithms from Recordly need attribution, provenance review, and a license decision before merge.

## D-004 — Tag-gated source releases before package publication

- Context: The plugin is not yet a production runtime or npm package, but contributors need a reproducible public distribution path.
- Decision: CI validates every pull request and `main`; a `v*` tag validates again and publishes a GitHub source archive only.
- Alternatives considered: Publish an npm package immediately; manual releases; no release workflow until the runtime exists.
- Reason: The archive gives traceable release artifacts without implying registry support or production readiness.
- Consequence or follow-up: Add signed tags, provenance, and an installer-specific package only after the plugin/runtime interface stabilizes.

## D-005 — Contract core precedes capture and rendering

- Context: Browser frame capture and media output must be reproducible and safe before a vertical slice can be trusted.
- Decision: Implement and test the request schema, event stream, capture-frame representation, coordinate mapping, frame-grid normalization, and zoom selection before capture or render modules.
- Alternatives considered: Start with direct browser capture; add an editor UI first; use prompt-only recording plans.
- Reason: These contracts make later capture and rendering inputs bounded, testable, and auditable without claiming that media output exists.
- Consequence or follow-up: The current 15-test core is not a rendering fixture. Add a sanitized fixture, manifest/shot-plan/quality-report schemas, and an end-to-end test before claiming vertical-slice recording support.
