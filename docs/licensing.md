# Licensing and clean-room policy

Recordly Codex original code is Apache-2.0. It is independently implemented and is not affiliated with [Recordly](https://github.com/webadderallorg/Recordly).

Recordly is AGPL-3.0. Do not copy, port, adapt, link, vendor, or distribute its source, comments, tests, assets, shaders, project formats, native helpers, or internal file layout in this repository without an explicit legal and licensing decision. Public product behavior and general requirements can inform independent work, but are not permission to reproduce expressive implementation.

## Contributor rules

1. Write interfaces, tests, rendering behavior, helper code, and documentation independently from public requirements and standard browser APIs.
2. Do not paste Recordly source into prompts, issues, tests, design notes, or generated code. If someone has reviewed its source, keep their contribution to high-level non-expressive observations and use an independent implementer for code.
3. Do not claim Recordly compatibility or recreate its project-file format without legal review.
4. Use only independently created or properly licensed media assets and record third-party notices before release.

## Bundled npm notices

`plugin-runtime/recordly-codex-mcp.mjs` includes npm code selected by esbuild's actual bundle input graph. The committed [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lists every included package by name, version, declared license identifier, and installed license or notice text. It is generated deterministically by `npm run bundle`; do not edit it manually.

`npm run bundle:check` rebuilds the graph and fails if either the runtime bundle or the notices are stale, incomplete, unresolved, oversized, or contain local paths. `npm run plugin:validate` also runs that check. Development-only packages that are not in the runtime bundle are intentionally excluded.

## Release gates

Legal review is required before accepting Recordly-derived material, offering a hosted capture/render service, bundling FFmpeg, shipping a format-compatibility feature, or making trademark/compatibility claims. FFmpeg and codec licensing depend on the distributed build; verify that separately before a binary release.

This policy is operational guidance, not legal advice.
