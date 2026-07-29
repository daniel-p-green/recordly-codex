# Architecture

## Operating model

Recordly Codex is a local Codex Desktop Browser plugin. The model plans and judges a bounded workflow; deterministic local code owns capture evidence, timing, rendering, encoding, and quality checks. The model receives artifact paths and compact status, never raw frame streams.

```mermaid
flowchart LR
  I["Approved URL + objective"] --> M["Five-tool local MCP service"]
  M --> H["Per-session Browser helpers"]
  H --> B["Codex Desktop Browser host"]
  B -->|"loopback only"| C["Capture broker"]
  C --> E["Private frame + receipt evidence"]
  E --> S["Seal gate"]
  S --> R["Deterministic render + FFmpeg"]
  R --> D["MP4 + manifest + quality report"]
```

The Browser host, not MCP, runs the helpers. It must expose `browser_run_code_unsafe`. The helpers use only the active page object and a loopback endpoint; they do not need Node imports, filesystem access, process access, or a model-visible data channel.

## Session contract

`create_recording_session` accepts `url`, `objective`, and optional `allowedOrigins`/`allowPrivateOrigin`. The service fixes the viewport at 1440×900 and delivery profile at 1920×1080, 30 fps, silent MP4 with bounded attempts. It creates a private session root, broker, capture configuration, and two generated helper entrypoints.

The other tools are:

| Tool | Purpose |
| --- | --- |
| `record_browser_event` | Append model-described semantic `pointer`, `click`, `scroll`, `navigation`, `viewport`, or `marker` evidence. The service assigns session ID, sequence, and monotonic timestamp. |
| `inspect_recording_session` | Return redacted status and contained paths. |
| `seal_recording_capture` | Require complete capture evidence, render, encode, and return delivery artifacts only when approved. |
| `discard_recording_session` | Close the broker and remove the owned session and helper entrypoints. |

Frame and capture-health events are not MCP inputs. They are emitted by the local broker after a Browser helper posts an actual screencast frame.

## Capture, timing, and privacy

The helper performs one claim for its session and receives a random capability token. The broker accepts JSON only from loopback, only for that session and approved origin, and rejects oversized or malformed frames. It writes a frame before the helper ACKs the CDP screencast frame.

At local broker receipt, each accepted frame is assigned `receiptOffsetUs`: zero for the first frame and strictly increasing thereafter. This is timing evidence created locally, not page data. Partial or legacy timing may remain inspectable, but cannot receive quality-approved delivery status.

Artifact roots are absolute, contained, owner-token protected directories. Browser helpers live separately in the Browser-approved bridge root. Raw frames, cookies, headers, raw DOM, and captured page text are excluded from MCP output, manifests intended for delivery, Git, and model context.

## Seal and delivery

Sealing requires a stopped capture summary with complete acknowledgements, no rejected frames, stable frame geometry, valid hashes, and complete broker receipt timing. The renderer creates a constant-frame-rate 1920×1080 H.264 MP4, probes it with FFmpeg tooling, samples opening/midpoint/final frames, checks for frozen evidence, then emits exactly:

1. `recording.mp4`
2. `recording-manifest.json`
3. `quality-report.json`

The delivery manifest includes origin, objective, aggregate evidence hashes, and quality provenance while omitting target path/query/fragment, credentials, and raw-frame paths. A receipt-timed, non-frozen capture is approved; a legacy-timed one is only a candidate.

The visual baseline deliberately stays conservative: fixed framing and deterministic CFR video. Cursor synthesis, click effects, and zooms are out of delivery scope until their telemetry is synchronized to capture receipt timing. The runtime will not invent those visual events.

## Supported scope and live evidence

The final approved evidence exercised the local MCP service, one-time Browser-to-broker claim, bounded hero/scroll capture, receipt-timed rendering, and the three contained delivery artifacts against an authorized public workflow. Identifiers, paths, captured pixels, and hashes are intentionally not published.

That evidence proves the supported path, not arbitrary web autonomy. It does not cover login, CAPTCHA, payment, uploads, downloads, browser permissions, cross-origin expansion, native windows, audio, or irreversible side effects. Those conditions stop the workflow for user direction.
