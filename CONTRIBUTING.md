# Contributing

Thanks for contributing. Keep changes small, reviewable, and evidence-backed.

## Before opening a pull request

1. Discuss a materially new capability in an issue first, especially anything involving browser permissions, credentials, capture, rendering, licensing, or telemetry.
2. Add a failing behavioral test before its implementation, then keep the implementation minimal until the test passes.
3. Use only sanitized fixtures. Do not commit recordings, frame streams, cookies, tokens, customer URLs, or captured personal data.
4. Run `npm run check` and `npm run plugin:validate`.
5. State the user-visible behavior, safety boundaries, verification evidence, and any limitation in the pull request.

## Design expectations

- Prefer versioned, machine-readable contracts over prompt-only behavior.
- Keep model decisions separate from deterministic capture, render, encoding, and QA operations.
- Preserve browser safety boundaries. A workflow that needs credentials, permissions, CAPTCHA handling, payment, sensitive uploads, or irreversible action must stop cleanly rather than simulate autonomy.
- Do not introduce Recordly AGPL code or assets without an explicit maintainership and license-compliance decision.

## Commit and review standard

Write focused commits using imperative summaries. Review for behavior, safety, regressions, tests, and public claim accuracy before style. Maintainers may request a narrower patch when a change mixes unrelated concerns.
