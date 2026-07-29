# v0.5.0 Clean Export File Manifest

This is the exact canonical file set copied by the clean-export contract for the standalone plugin artifact. It is a local release-preparation manifest, not evidence that a tag, release, or marketplace installation exists.

1. `.agents/plugins/marketplace.json`
2. `.codex-plugin/plugin.json`
3. `.mcp.json`
4. `LICENSE`
5. `THIRD_PARTY_NOTICES.md`
6. `browser/capture-runtime.js`
7. `plugin-runtime/recordly-codex-mcp.mjs`
8. `skills/recordly-codex/SKILL.md`
9. `skills/recordly-codex/agents/openai.yaml`

No path whose basename matches `* 2*` or `* 3*` is a canonical release file. Those duplicate working-tree files are explicitly excluded from this manifest, from release preparation, and from the clean export.
