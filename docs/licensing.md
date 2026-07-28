# Licensing and clean-room policy

## Recommendation

Build Recordly Codex as an independently implemented, permissively licensed project (license selection requires maintainer choice and legal review) with a documented clean-room boundary from Recordly. Do **not** copy, port, adapt, or link Recordly source code, assets, shader code, tests, project-file formats, or native helpers into this repository unless the project intentionally accepts AGPL-3.0 obligations for the combined work.

Recordly publicly describes a desktop capture/editor/export product with cursor polish, zoom suggestions, styled frames, and MP4/GIF export, and its repository states it is AGPL-3.0 ([README](https://github.com/webadderallorg/Recordly), [license](https://github.com/webadderallorg/Recordly/blob/main/LICENSE.md)). Product ideas and externally observable behavior can inform requirements, but this is not legal advice and similarity analysis can be fact-specific.

## Clean-room rules

1. This repository implements its own interfaces, event schema, rendering math, assets, tests, and documentation from product requirements and public behavior. It does not vendor Recordly packages or copy code/comments/configuration.
2. Contributors must not paste Recordly source into issues, prompts, design docs, tests, or generated code. Where a contributor has studied Recordly source, document only high-level, non-expressive observations and have a separate implementer write the feature from this architecture.
3. Do not name internal symbols, clone file layout, recreate Recordly `.recordly` project compatibility, or claim compatibility unless a legal review approves the exact interoperability approach.
4. Use independently created or appropriately licensed cursor/background assets. Track each asset’s source, license, attribution, modifications, and redistribution conditions in a third-party notices file.
5. Keep a provenance note for every nontrivial dependency and media asset. Automated license/SBOM checks are release gates.

## What is allowed without taking a dependency

The safe engineering baseline is to use Recordly only as a public product reference: “a polished demo recorder can have cursor smoothing, click emphasis, automatic zooms, styled frames, and MP4 export.” Our architecture then specifies an independent CDP-based capture source and deterministic headless renderer.

Public protocol standards and browser APIs such as CDP can be used directly. Reimplementing a general concept from documentation or independently created tests is materially different from copying implementation. However, the exact legal boundary depends on jurisdiction, contributor knowledge, and distribution model; this document is operational guidance, not a substitute for counsel.

## Options that require a deliberate license decision

| Option | Recommendation | Why |
| --- | --- | --- |
| Independent implementation inspired by public behavior | Preferred for v1 | Preserves a clean boundary and avoids making Recordly a runtime dependency |
| Separate, user-installed Recordly integration through its documented extension/API surface | Possible only after API/license review | Keep processes/packages separate; confirm whether distribution, IPC, and derivative-work questions alter obligations |
| Reuse/modify Recordly source, assets, or native helpers | Only if intentionally AGPL-compliant and reviewed | Likely creates source-offer, corresponding-source, and network-use obligations for the covered work |
| Import a Recordly file format or reverse-engineer non-public behavior | Avoid until counsel approves | Compatibility and expressive-copying risks are higher |
| Ship a hosted renderer/MCP service containing AGPL-derived code | Do not do without counsel | AGPL is specifically concerned with users interacting with modified software over a network |

If the project later chooses AGPL components, isolate them in a clearly labeled component with its complete corresponding source, license notices, modification history, and a distribution/network-use compliance plan. Isolation is not automatically a legal cure; obtain counsel’s review before relying on it.

## Attribution and public wording

Do not imply endorsement, partnership, or compatibility with Recordly. A factual acknowledgement is appropriate only if useful, for example: “Recordly is an independent open-source screen-recording project that informed our product research; Recordly Codex is independently implemented and is not affiliated with it.” Do not use Recordly trademarks, logos, screenshots, or bundled assets without permission or a documented license basis.

All third-party notices go in `THIRD_PARTY_NOTICES.md`; all binary/library licenses go in the release bundle. The public README should link to this policy and state the project’s own final license once selected.

## Legal-review gates

Obtain qualified legal review before: selecting a project license; accepting Recordly-derived contributions; importing a Recordly dependency/asset or extension; adding `.recordly` compatibility; distributing native encoder binaries; offering a hosted capture/render service; collecting private captures; or making trademark/compatibility claims. Confirm the license of FFmpeg and each enabled codec separately, since build configuration and distribution method affect obligations.
