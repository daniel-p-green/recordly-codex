# Recordly Codex

Recordly Codex is an open-source Codex plugin and local TypeScript runtime for creating evidence-backed website recordings from an approved URL and workflow. It is being built as a browser-directed pipeline: Codex plans and rehearses the story, deterministic code captures and renders it, and automated checks decide whether the resulting media is usable.

The first supported environment is Codex Desktop Browser. A recording may run unattended only when the target is public or already authorized and the flow does not require a human-only approval, credential, permission, CAPTCHA, payment, sensitive upload, or irreversible action.

## Status

The public repository is at [github.com/daniel-p-green/recordly-codex](https://github.com/daniel-p-green/recordly-codex). The Codex plugin manifest validates, and the TypeScript contract core now covers recording requests, session events, capture-frame representation, coordinate mapping, frame-grid normalization, and deterministic zoom selection.

The current unit suite has 15 passing tests with 97.69% statement coverage and 91.89% branch coverage. Fixture validation remains a placeholder because no render fixture exists yet. Capture, rendering, and export modules are intentionally not implemented, so this is not a drop-in replacement for the Recordly desktop app.

## Product contract

```text
approved URL + objective
  -> shot plan + rehearsal evidence
  -> versioned recording manifest
  -> deterministic capture and render
  -> quality gates
  -> media file + manifest
```

The manifest is the durable handoff between planning, capture, rendering, and QA. It must never contain secrets, cookies, or raw frame streams.

## Development

Requirements: Node.js 22.17+ and npm 11+.

```bash
npm install
npm run check
npm run plugin:validate
```

Use red-green-refactor for executable behavior. Add a failing test before implementing a new capture, rendering, browser-control, or QA rule.

## CI and releases

Pull requests and pushes to `main` are configured to run formatting, linting, strict type checks, tests, plugin validation, fixture validation, and coverage collection. Pushing a `v*` Git tag is configured to rerun validation and attach a source archive to a GitHub Release; it does not publish an npm package or imply production readiness.

## License and upstream relationship

This repository is Apache-2.0 for its original code. It is an independent project inspired by the recording workflow problem, not an official Recordly integration. Recordly is licensed under AGPL-3.0; do not copy, adapt, or distribute Recordly implementation here without a separate license-compliance decision.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
