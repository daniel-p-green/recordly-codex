# AGENTS.md

## Project purpose

Build an open-source Codex plugin and local TypeScript runtime for making professional, evidence-backed recordings of approved website workflows. The product is browser-directed and deterministic: the model plans and judges, while capture, rendering, encoding, and artifact checks are implemented as tested code.

## Non-negotiable boundaries

- Support Codex Desktop Browser first. Do not claim that Codex CLI or IDE integrations can drive the in-app browser.
- Operate only on public or explicitly authorized, pre-authenticated targets. Never bypass authentication, CAPTCHA, consent, permission, anti-bot, or browser safety controls.
- Stop and request direction for secrets, payments, irreversible state changes, sensitive uploads, or user approvals that cannot safely be completed.
- Keep recordings, raw frame streams, cookies, credentials, and user data out of Git. Use sanitized fixtures in tests.
- Preserve the distinction between a plan, a rehearsal, a capture, a rendered candidate, and a quality-approved deliverable.

## Engineering contract

- Work red-green-refactor: add a failing behavioral test, make the smallest implementation pass it, then refactor with tests green.
- Keep capture and rendering deterministic. Model output may create a versioned manifest, but it must not be the only record of actions or quality evidence.
- Validate a visible result after each browser action; a click or tool success alone is not a completed shot.
- Use strict TypeScript, Biome, Vitest, and the repository scripts. Run the narrowest relevant checks before expanding to `pnpm run check`.
- Avoid implementing product modules until their public contract and tests are agreed. Do not add mock-only capabilities to public claims.

## Repository hygiene

- Keep public documentation accurate, concise, and free of private machine paths, personal tokens, customer data, and unlicensed assets.
- Preserve unrelated concurrent changes. Read callers, tests, config, and nearby conventions before editing.
- Use Apache-2.0 for original project code. Do not copy or link Recordly AGPL implementation into this repository without an explicit licensing decision and the required notices.
