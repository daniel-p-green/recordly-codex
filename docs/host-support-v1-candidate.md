# Candidate v1 host and runtime support

This is the proposed support boundary for Recordly Codex `v1.0.0`. It separates the
user-facing Codex Desktop Browser host from the local deterministic runtime and CI. The
machine-readable contract is
[`contracts/host-support-v1-candidate.json`](../contracts/host-support-v1-candidate.json).

## Product host

The only proposed v1 interaction surface is Codex Desktop Browser on Apple silicon macOS.
The current observed baseline is macOS `26.5.2` arm64 with Codex Beta `26.715.31251`.
On July 29, 2026, that host completed a real one-shot Browser capture through the current
unreleased `1.0.0` worktree bundle using a private capture-owned click. The visible public navigation
result was independently checked in the Browser; 22 frames were received, accepted, and
acknowledged with zero rejections; and the sealed delivery passed action alignment, final hold,
clipping, decodeability, privacy, and receipt-timing gates. This is host-path and sealed-delivery
proof only, not a v1 acceptance run: the local runtime was unsupported Node 26 and the rehearsal
did not complete preview judgment and final-digest verification.
The version used for every live run must be recorded in the v1 acceptance ledger.

Codex CLI and IDE browser control, Windows as a product host, and native display or window
capture are outside the v1 boundary. Linux CI proves the local runtime and package contracts,
not the Codex Desktop Browser experience.

## Local runtime

| Dependency | Candidate v1 boundary | Evidence |
| --- | --- | --- |
| Node.js | `22.17.0` or newer on major 22, or major 24 | `package.json`, Node 22/24 CI matrix, self-check |
| FFmpeg and FFprobe | Matching major versions, FFmpeg `6.1.1` through `8.x` | CI provisioning, local media tests, self-check |
| Artifact storage | Private owner-local directory or a writable parent from which one can be created with mode `0700` | Self-check and storage tests |
| Capture broker | Ephemeral bind on `127.0.0.1` | Self-check and broker tests |
| MCP bundle | At most 2 MiB and exact candidate SHA-256 | Integrity contract and self-check |

Odd Node releases and Node 26 are intentionally not accepted until they receive the same CI
and package proof. The current shell on the acceptance Mac is Node 26, so it must use a supported
Node 22 or 24 installation before a v1 run can count.

The in-app Browser capability is available only while its `node_repl` execution is active.
Capture must therefore start, execute the rehearsed approved actions, verify visible results,
and stop in one call. Background event polling across separate calls is unsupported and must
fail closed.

## Read-only preflight

Run:

```sh
npm run self-check -- --json
```

The check reports only versions, bounded status codes, counts, and the bundle digest. It does
not print the artifact-root path, helper contents, URLs, page text, frames, tokens, or cookies.
It does not modify the configured artifact root. The MCP handshake uses a disposable private
temporary directory and removes it before returning.

Success requires:

- a supported Node release;
- matching supported FFmpeg and FFprobe releases in a fixed executable location;
- private writable artifact storage, or a writable existing parent;
- an ephemeral IPv4 loopback bind;
- an exact bundle size and SHA-256 match; and
- a raw MCP initialize and 20-tool handshake matching the candidate contract.

The command exits nonzero when any check fails. A sandbox can legitimately block the loopback
probe; release evidence must run the command in the actual installed host environment.

## CI and release proof

The required CI set is quality on Node 22, quality on Node 24, and the plugin/fixture contract.
All three jobs now run the self-check. The v1 release still requires three consecutive green
`main` runs, so adding the checks is not itself completion evidence.
