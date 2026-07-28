# Recordly Codex

Recordly Codex is an open-source Codex plugin and local TypeScript runtime for creating evidence-backed website recordings from an approved URL and workflow. It is being built as a browser-directed pipeline: Codex plans and rehearses the story, deterministic code captures and renders it, and automated checks decide whether the resulting media is usable.

The first supported environment is Codex Desktop Browser. A recording may run unattended only when the target is public or already authorized and the flow does not require a human-only approval, credential, permission, CAPTCHA, payment, sensitive upload, or irreversible action.

## Status

The repository is public at [github.com/daniel-p-green/recordly-codex](https://github.com/daniel-p-green/recordly-codex), protected from direct changes, and its initial CI run is green. The plugin manifest validates. A clean `npm ci` completes with zero reported audit vulnerabilities.

The completed local capture-render tranche includes:

- A bounded CDP screencast capture adapter with durable-frame acknowledgement and capture-health telemetry.
- A compiler that verifies immutable frame hashes, emits a canonical sanitized manifest, builds a deterministic constant-frame-rate timeline, and classifies QA preconditions.
- A deterministic renderer and encoder fixture that produces a valid 1920x1080, 30 fps, 30-frame silent H.264 MP4.
- A system-Chrome, loopback-only E2E fixture that records opening, action, and result states while blocking external requests, then verifies the manifest, telemetry, decoded media, and a sampled output frame.

The suite has 34 passing tests. Before the final CI coverage-threshold configuration, its coverage report was 93.92% lines and 85.74% branches. The fixture is deliberately a local proof harness, not a user-facing browser-control integration.

This is still not a drop-in autonomous recorder. The runtime does not yet include a Codex Desktop Browser-to-local-engine MCP/control bridge, and it has not yet recorded a real approved public-site workflow. Those two proofs remain required before claiming that Codex can autonomously create a real site recording.

## Product contract

```text
approved URL + objective
  -> shot plan + rehearsal evidence
  -> versioned recording manifest
  -> deterministic capture and render
  -> quality gates
  -> media file + manifest
```

The canonical manifest and its frame hashes are the durable handoff between planning, capture, rendering, and QA. They must never contain secrets, cookies, query values, or raw frame streams.

## Development

Requirements: Node.js 22.17+ and npm 11+.

```bash
npm ci
npm run check
npm run plugin:validate
```

Use red-green-refactor for executable behavior. Add a failing test before implementing a new capture, rendering, browser-control, or QA rule. The local E2E fixture needs a supported system Chrome plus FFmpeg and FFprobe; it does not use the Codex Browser surface.

## CI and releases

Pull requests and pushes to `main` are configured to run formatting, linting, strict type checks, tests, plugin validation, fixture validation, and coverage collection. Pushing a `v*` Git tag is configured to rerun validation and attach a source archive to a GitHub Release; it does not publish an npm package or imply production readiness.

## License and upstream relationship

This repository is Apache-2.0 for its original code. It is an independent project inspired by the recording workflow problem, not an official Recordly integration. Recordly is licensed under AGPL-3.0; do not copy, adapt, or distribute Recordly implementation here without a separate license-compliance decision.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
