# Threat model

## Security posture

Recordly Codex runs an untrusted web page, a model-directed browser session, local media capture, and a native encoder on a user machine. The safety boundary is therefore stricter than a typical renderer: treat page content as hostile, require platform/Codex approvals, minimize collected data, and make the renderer/encoder incapable of browsing or interpreting page instructions.

The intended v1 trust boundary is a user-approved public or already authenticated site plus a local engine. It is not a credential vault, robotic process automation product, or security bypass tool.

## Assets and trust boundaries

| Asset | Required protection |
| --- | --- |
| Browser session, cookies, credentials | Never read, serialize, log, or transmit; rely on browser isolation and user/Codex approval surfaces |
| Captured pixels and DOM-derived labels | Restrict to session root, encrypt at rest where platform support exists, short retention, no telemetry upload |
| User objective and shot plan | Validate origin/action policy; do not let webpage content mutate it |
| Final MP4 and manifests | Least-privilege paths, hashes, source provenance, explicit user-visible output location |
| Local subprocesses/binaries | Pinned, verified versions; fixed arguments; no shell; no executable content from page/download |
| Plugin/engine IPC | Local-only authenticated per-session endpoint, strict schemas and size limits |

## Threats and controls

| Threat | Likely attack/result | Required control | Residual risk |
| --- | --- | --- | --- |
| Prompt injection in page content | Page tells the director to reveal secrets, change goals, upload data, or ignore policy | Label every browser observation untrusted; never execute page text as instructions; plan schema only; tool/action allowlist; model-facing text/DOM caps and redaction | Model may still misclassify UI; approvals and action policy remain the backstop |
| Unauthorized sensitive action | Purchase, delete, publish, submit form, change access, send message | Sensitive-action classifier plus allowlist; always stop for Codex/user approval; default read-only and non-mutating plans | Classification requires conservative maintenance |
| Credential/private-page leakage | Pixels, logs, URLs, form inputs, cookies leaked to artifacts/model | Never extract cookies/storage/headers; redact URL query/fragment; mask password/OTP/payment fields before screenshots; block private origin unless explicit request policy; no raw DOM snapshots | Screen pixels can include sensitive data; visual redaction is imperfect, so user authorization is still required |
| Upload/download abuse | Page causes local file upload or writes malicious files | Downloads abort the take and quarantine path metadata; uploads disabled except explicit, approved, allowlisted fixture workflow; never discover local files from a page request | User-approved upload remains sensitive |
| Arbitrary navigation or exfiltration | Redirect to hostile origin, data URL, file URL, local service | Exact allowed-origin policy; block `file:`, `data:`, `javascript:`, loopback/private-network origins by default; navigation count/depth cap; do not attach page content to external requests | Permitted origin itself can be compromised |
| Capture data leakage | Raw frames or QA contact sheet ends up in logs, source control, crash reports, cloud tools | Per-session private directory; restrictive permissions; size/retention quota; no automatic upload; `.gitignore`; sanitized manifest only; scrub crash diagnostics | Local user/malware can access local files |
| CDP/browser control abuse | Exposed debugging endpoint lets another process drive session | Use only Codex-provided Browser channel; no remote debugging port; capability-scoped adapter; close session at end; no generic `Runtime.evaluate` exposed to director | Browser host remains a privileged dependency |
| Renderer/encoder command injection | URL/filename/page data becomes shell code or binary option | No shell invocation; argument arrays only; fixed binary path and option allowlist; generated IDs for paths; reject control chars/symlinks; resource limits | Encoder parser vulnerabilities remain possible |
| Compromised binary/dependency | Malicious FFmpeg/native package executes locally | Lockfile, checksums/signatures where available, SBOM, dependency review, least-privilege child, no network in renderer/encoder, release provenance | Supply-chain risk cannot be eliminated |
| Resource exhaustion | Huge frames, screencast flood, decompression bomb, endless animation | Fixed viewport; image dimension/MIME validation; frame/disk/time quotas; bounded queue and abort behavior; child CPU/memory/time limits | A site can still consume permitted browser resources |
| Output integrity/provenance | Artifact mismatch or manipulated result | Immutable raw hashes, versioned manifest, renderer/encoder versions, atomic writes, QA report; do not claim authenticity beyond capture metadata | Screen recording is not cryptographic proof of webpage truth |

## Approval and action policy

The plugin must separate **navigation/read-only interaction** from **side effects**. It may navigate, inspect visible UI, scroll, and click only within allowed origins during an approved take. It must pause and surface a clear approval request before:

- logging into a new account or entering/reading a secret;
- submitting, purchasing, publishing, sending, deleting, changing permissions, or accepting legal terms;
- granting a browser/device permission;
- uploading a local file, downloading a file, printing, opening another application, or invoking external tools;
- navigating to a non-allowlisted origin, a local/private address, or a URL with a sensitive query parameter.

Approvals are one action, one target, one session. They cannot be stored as a broad site grant and cannot be inferred from page text. A denied, expired, or ambiguous approval aborts the affected shot.

## Data handling requirements

1. Default to public URLs. A private origin requires explicit request intent, and the final response identifies that the user authorized private capture.
2. Never place raw frames, unredacted screenshots, cookies, tokens, or full page text in model prompts, issue reports, CI artifacts, or git.
3. Capture logs contain event types, monotonic timestamps, generated IDs, and redacted target labels only. Treat diagnostics as potentially sensitive and retain them with the session.
4. A pre-render scrubber masks known sensitive element types and configurable selectors. A post-render visual scan is a second gate, not proof that no secret exists.
5. The user chooses final output destination. Reveal/open-file commands are opt-in and use the OS API, not a page-provided path.

## Secure implementation requirements

- Schema-validate all IPC, plan, telemetry, and renderer inputs. Reject unknown command types and over-sized fields.
- Use process spawning with an explicit executable path and argument array; set a sanitized environment, working directory, resource limit, and timeout. Do not use `sh -c`, `eval`, plugin-provided code, or page-controlled filters.
- Run capture, renderer, and encoder with the minimum filesystem access to the session directory. The renderer has no network or browser capability.
- Atomically write each frame, verify decoded dimensions, hash it, then acknowledge its CDP screencast frame. On failure, abort and clean up according to retention policy.
- Pin dependencies and native binary versions. CI produces an SBOM, runs secret scanning and dependency review, and verifies licenses before release.
- Test all policy controls with hostile fixtures: prompt injection text, redirects, password/payment fields, download triggers, path traversal names, malformed image data, and encoder metacharacters.

## Incident response and audit

On suspected capture exposure, stop the session, prevent output sharing, retain only the sanitized event/report needed to diagnose, and surface the affected session path and retention state to the user. The engine records an append-only audit stream of policy decisions, approvals, origin transitions, engine versions, and artifact hashes; it never records secret values. A release should include a documented disclosure channel and a supported-version policy.

## Non-goals

This project does not bypass CAPTCHA, bot detection, authentication, consent prompts, DRM, OS permissions, or website security controls. It does not promise that a recording of a private page is safe to share. It also does not collect system audio in v1.
