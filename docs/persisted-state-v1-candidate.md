# Candidate v1 persisted-state policy

This document freezes the compatibility, retention, and recovery behavior proposed for
Recordly Codex `v1.0.0`. The machine-readable review boundary is
[`contracts/persisted-state-v1-candidate.json`](../contracts/persisted-state-v1-candidate.json).
The release is not approved until the separate upgrade and clean-install rehearsal passes.

## Compatibility rule

Persisted data is private to one configured artifact root and its owner token. Reads do not
rewrite state. An unknown envelope or payload version, malformed shape, invalid digest, unsafe
path, or foreign owner fails closed; the runtime does not guess, downgrade, or silently repair
the artifact.

| State | Supported envelope | Supported payload | v1 behavior |
| --- | ---: | ---: | --- |
| Session metadata | 1 | 1 | Read exact version; no migration |
| Capture summary | 1 | 1 | Read exact version; no migration |
| Capture broker state | 1 | 1 | Read exact version; apply the recovery table below |
| Recording project | 1 | 1, 2 | Read both without mutation; migrate V1 to V2 only on an explicit project mutation |
| Owner-local profile | 1 | 1 | Read exact version; no migration |
| Preview judgment | 1 | 1 | Read exact version; immutable and bound to exact project/render digests |

A V2 recording project cannot be revised back to V1. The V1-to-V2 migration is deterministic,
preserves sealed capture-source identity, and occurs only when the caller explicitly revises the
project, applies a profile, or applies accepted editorial work. Inspection alone leaves the
persisted V1 project unchanged.

## Upgrade behavior

The candidate compatibility promise for the last supported pre-1.0 release is limited to the
formats in the table above. Upgrade reads are non-mutating. The first explicit mutation of a V1
project writes a V2 revision; all other supported state remains at its existing version.

Unsupported or corrupt state blocks the affected operation with a bounded error. It is never
deleted or rewritten automatically. Recovery is to preserve the artifact root for diagnosis,
then either return to the producing version or explicitly discard the affected recording session.
The final v1 release notes must name the exact supported pre-1.0 version after the isolated
upgrade rehearsal proves it.

## Retention and deletion

There is no automatic expiry, background garbage collection, or abandoned-session deletion.
Recording sessions remain under the private artifact root until the owner explicitly calls
`discard_recording_session`. Before deletion, discard validates the session identifier, ownership,
private regular evidence files, and contained helper directory. A successful discard removes both
the session directory and its browser-helper directory.

Projects, owner-local profiles, preview judgments, previews, and final media do not have
individual delete tools in the candidate v1 contract. They remain in the configured artifact
root until the user removes or archives that root outside Recordly Codex. v1 documentation and
support must not imply per-item deletion that the runtime does not provide.

## Interrupted capture recovery

| Persisted broker phase | Recovery on next access |
| --- | --- |
| `ready` | Start a replacement broker for the active session |
| `claimed` or `running` | Mark the broker failed and write a failed capture summary with reason `broker_interrupted` |
| `failed` | Remain failed |
| `stopped` | Remain stopped |

An interrupted `claimed` or `running` capture is not retried automatically because the runtime
cannot prove frame continuity or browser state. The failed evidence remains inspectable and can be
explicitly discarded. A new recording requires a new session.

## Release evidence still required

This policy specifies behavior; it does not prove a release upgrade. Before tagging v1, run the
isolated install/upgrade/uninstall/reinstall rehearsal, verify all supported state from the named
pre-1.0 release, and record any unsupported-state diagnostic without private paths, URLs, page
text, frames, tokens, or cookies.
