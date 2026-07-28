# ADR 0001: Use a local headless engine, not a hosted MCP renderer

- Status: Accepted
- Date: 2026-07-28

## Context

The product must create browser recordings without opening another visible app and should keep private capture material on the user machine. A hosted MCP renderer would add upload latency, introduce a capture-data boundary, and require service-side credentials, tenancy, retention, and incident-response design.

## Decision

Ship a Codex desktop plugin that invokes a local, headless engine through a per-session local IPC contract. The engine has no visible UI and binds no network listener. The plugin directs the Codex Browser; the engine captures, renders, encodes, and writes session-scoped artifacts.

## Consequences

Private pixels stay local by default and the initial product has no hosted media infrastructure. Cross-platform packaging, encoder provisioning, and desktop capability validation become release responsibilities. A future hosted service may accept only an explicitly user-selected sanitized export package after a separate security, privacy, and legal decision.
