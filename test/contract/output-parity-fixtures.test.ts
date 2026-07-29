import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateOutputParityFixtureManifest } from "../../scripts/validate-output-parity-fixtures.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const manifestPath = resolve(repositoryRoot, "fixtures/output-parity-v1/fixture-manifest.json");

describe("output-parity v1 fixture contract", () => {
  it("defines a clean-room output-only matrix with decoded checkpoints for every profile and format", async () => {
    const manifest = await validateOutputParityFixtureManifest(manifestPath);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "recordly-codex-output-parity-fixture-manifest",
      suite: "output-parity-v1",
      provenance: {
        origin: "independently-authored-sanitized",
        recordlyMaterial: "none",
      },
    });
    expect(manifest.exclusions).toEqual(
      expect.arrayContaining([
        "native-display-or-window-capture",
        "microphone-or-system-audio-capture",
        "graphical-timeline-editor",
        "recordly-project-file-compatibility",
      ]),
    );
    expect(new Set(manifest.fixtures.map((fixture) => fixture.profile))).toEqual(
      new Set(["landscape-1080p", "square-1080", "vertical-1080"]),
    );
    expect(new Set(manifest.fixtures.map((fixture) => fixture.output.format))).toEqual(
      new Set(["mp4", "gif"]),
    );
    for (const fixture of manifest.fixtures) {
      expect(fixture.requiredEffects).toEqual(
        expect.arrayContaining([
          "trim",
          "speed",
          "crossfade",
          "reviewed-zoom",
          "cursor",
          "click-effect",
          "frame-style",
          "caption",
          "annotation",
        ]),
      );
      expect(fixture.decodedCheckpoints.map((checkpoint) => checkpoint.kind)).toEqual([
        "opening",
        "effect",
        "final",
      ]);
    }
  });
});
