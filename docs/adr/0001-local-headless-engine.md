# ADR 0001: Use a local headless engine, not a hosted MCP renderer

- Status: Accepted (amended 2026-07-29)
- Date: 2026-07-28

## Context

The product must create browser recordings without opening another visible app and should keep private capture material on the user machine. A hosted MCP renderer would add upload latency, introduce a capture-data boundary, and require service-side credentials, tenancy, retention, and incident-response design.

## Decision

Ship a Codex desktop plugin that invokes a local, headless engine through a per-session local IPC contract. The engine has no visible UI. Capture helpers talk to a **loopback-only HTTP broker** (`127.0.0.1` / `::1`) that exists for one session, accepts capability-gated JSON, and never binds a public network interface. The plugin directs the Codex Browser; the engine captures, renders, encodes, and writes session-scoped artifacts.

## Consequences

Private pixels stay local by default and the initial product has no hosted media infrastructure. Cross-platform packaging, encoder provisioning, and desktop capability validation become release responsibilities. A future hosted service may accept only an explicitly user-selected sanitized export package after a separate security, privacy, and legal decision.

## Amendment note

The original wording said the engine “binds no network listener.” That overstated the IPC shape: the loopback broker is an intentional, session-scoped listener constrained by the threat model. Non-loopback binding remains forbidden.
