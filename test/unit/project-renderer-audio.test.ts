import { describe, expect, it } from "vitest";

import { audioMixControlsForProjectTrack } from "../../src/render/project-renderer.js";

const track = {
  id: "narration",
  asset: { assetId: "narration-media", sha256: "a".repeat(64) },
};

describe("V2 project audio-mix mapping", () => {
  it("maps validated mix controls by track and media identity without source paths", () => {
    const controls = audioMixControlsForProjectTrack(
      {
        schemaVersion: 2,
        audioMix: {
          tracks: [
            {
              trackId: "narration",
              mediaId: "narration-media",
              role: "primary",
              pan: 0,
              fadeInUs: 100_000,
              fadeOutUs: 200_000,
              ducking: "none",
            },
          ],
        },
      },
      track,
    );

    expect(controls).toEqual({
      id: "narration",
      role: "primary",
      pan: 0,
      fadeInUs: 100_000,
      fadeOutUs: 200_000,
      ducking: "none",
    });
    expect(JSON.stringify(controls)).not.toContain("path");
  });

  it("fails closed for a missing or mismatched V2 audio mix entry", () => {
    expect(() =>
      audioMixControlsForProjectTrack({ schemaVersion: 2, audioMix: { tracks: [] } }, track),
    ).toThrow(/does not match/u);
  });
});
