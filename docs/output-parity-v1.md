# Output parity v1

`output-parity-v1` is a clean-room fixture contract for the v0.5.0 renderer. It is not a claim of Recordly feature, project-file, editor, source, API, or pixel parity.

For every fixture in `fixtures/output-parity-v1/fixture-manifest.json`, the renderer must produce the stated geometry and format for both preview and final, then decode the declared opening, effect, and final checkpoints. The suite covers MP4 and GIF at 1920×1080 landscape, 1080×1080 square, and 1080×1920 vertical output.

The required effect vocabulary is trim, speed, crossfade, reviewed zoom, cursor, click effect, frame style, caption, and annotation. A fixture must show each declared effect in decoded output. A project field alone is not enough.

Near-output parity permits an independent renderer and codec differences. It does not permit incompatible geometry, wrong timing, omitted declared effects, or skipped decoded checkpoints. It does not mean identical pixels.

The contract excludes native display/window capture, microphone or system-audio capture, a graphical timeline editor, `.recordly` compatibility, Recordly extensions/marketplace execution, native Recordly capture backends, and Recordly implementation, assets, tests, shaders, or golden outputs. Imported audio/video are renderer inputs only; they do not create device-capture or dynamic-webcam parity. Editorial trim proposals and transition suggestions remain review-only.

Fixtures are independently authored, sanitized, repository-owned test material. Their only raster asset is a tiny hand-authored P3 PPM color checker. Do not replace it with captured pixels, an external download, or another product’s derivative asset.

Run `npm run fixtures:output-parity:validate` for structural validation. `test/integration/output-parity-render.test.ts` renders each fixture as preview and final, probes the candidates, and decodes every checkpoint. `npm run fixtures:validate` runs both the structural and executable checks. FFmpeg and FFprobe are required; their absence fails the check rather than skipping it.
