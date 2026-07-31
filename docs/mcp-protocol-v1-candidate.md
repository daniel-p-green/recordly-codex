# MCP protocol v1 candidate

The candidate v1 wire contract contains the current 20 production tools. Its machine-readable review snapshot is [`contracts/mcp-v1-candidate.json`](../contracts/mcp-v1-candidate.json).

The contract test creates the production MCP server, calls `tools/list`, canonicalizes each complete input and output JSON Schema, and compares these fields for every tool:

- name and title;
- read-only and destructive annotations;
- SHA-256 of the complete canonical input schema;
- SHA-256 of the complete canonical output schema.

Run the drift gate with:

```bash
npx vitest run test/contract/mcp-v1-contract.test.ts
```

Any difference is a review event, not an instruction to refresh the snapshot automatically. The change must first be classified:

- Patch: no tool, annotation, input-schema, or output-schema change.
- Minor: additive tool or backward-compatible optional behavior, with a new reviewed snapshot and protocol note.
- Major: removal, rename, new required field, accepted-input narrowing, output removal, output reinterpretation, or other client-visible break.

This snapshot covers the MCP wire surface only. Persisted session, sealed-delivery, project, profile, and preview-judgment compatibility must receive a separate explicit support and migration policy before v1.0.

## Candidate additive diagnostics

Failed tool outputs may include an optional bounded `error.reason` machine code
(`stale_preview_judgment`, `final_publication_failed`, `unsupported_state`, and related
capture reasons). Reasons never carry helper tokens, raw URLs, page text, local paths, or
secrets. Clients that ignore unknown optional fields remain compatible; refreshing this
snapshot is required when the output schema digest changes.

