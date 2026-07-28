import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { probeRenderedVideo } from "../../src/encoder/probe.js";
import {
  cleanupRenderedFixtureCandidate,
  renderSanitizedFixtureCandidate,
} from "../../src/render/sanitized-fixture.js";

describe("sanitized render fixture", () => {
  it("renders a deterministic browser-style recording that passes its delivery contract", async () => {
    const candidate = await renderSanitizedFixtureCandidate();
    try {
      await access(candidate.outputPath);
      expect((await stat(candidate.outputPath)).size).toBeGreaterThan(10_000);

      const probe = await probeRenderedVideo(candidate.outputPath);
      expect(probe).toEqual({
        width: 1920,
        height: 1080,
        fps: 30,
        frameCount: 30,
        durationSeconds: 1,
        hasAudio: false,
      });

      // A sampled decoded frame catches broken filter/overlay changes without relying on MP4 bytes,
      // whose metadata can vary across FFmpeg builds.
      const firstFrameHash = createHash("sha256")
        .update(await readFile(candidate.firstFramePath))
        .digest("hex");
      expect(firstFrameHash).toBe(
        "83b75e6e13e553330be2b1ae21ff18bfe8eec5b4831ba7519e1e503559ea5281",
      );
      const clickFrameHash = createHash("sha256")
        .update(await readFile(candidate.clickFramePath))
        .digest("hex");
      expect(clickFrameHash).toBe(
        "955878e7d732f171e548190786cb0e26da6bea3d38594fa8d33ac0b0b2669902",
      );
    } finally {
      await cleanupRenderedFixtureCandidate(candidate);
    }
  }, 60_000);

  it("isolates concurrent render artifacts", async () => {
    const [first, second] = await Promise.all([
      renderSanitizedFixtureCandidate(),
      renderSanitizedFixtureCandidate(),
    ]);
    let firstCleaned = false;
    try {
      expect(first.artifactRoot).not.toBe(second.artifactRoot);
      expect(first.outputPath).not.toBe(second.outputPath);
      await expect(
        Promise.all([probeRenderedVideo(first.outputPath), probeRenderedVideo(second.outputPath)]),
      ).resolves.toEqual([
        {
          width: 1920,
          height: 1080,
          fps: 30,
          frameCount: 30,
          durationSeconds: 1,
          hasAudio: false,
        },
        {
          width: 1920,
          height: 1080,
          fps: 30,
          frameCount: 30,
          durationSeconds: 1,
          hasAudio: false,
        },
      ]);
      await cleanupRenderedFixtureCandidate(first);
      firstCleaned = true;
      await expect(access(second.outputPath)).resolves.toBeUndefined();
    } finally {
      await Promise.all([
        firstCleaned ? Promise.resolve() : cleanupRenderedFixtureCandidate(first),
        cleanupRenderedFixtureCandidate(second),
      ]);
    }
  }, 60_000);
});
