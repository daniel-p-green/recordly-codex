import { access, readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { probeRenderedVideo } from "../../src/encoder/probe.js";
import {
  cleanupRenderedFixtureCandidate,
  renderSanitizedFixtureCandidate,
} from "../../src/render/sanitized-fixture.js";
import { averagePpmRegion, isRgbWithin, parsePpm, ppmPixelAt } from "../support/ppm.js";

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

      const opening = parsePpm(await readFile(candidate.firstFramePath));
      const click = parsePpm(await readFile(candidate.clickFramePath));
      expect(opening).toMatchObject({ width: 1920, height: 1080, maxValue: 255 });
      expect(click).toMatchObject({ width: 1920, height: 1080, maxValue: 255 });

      // These broad regions verify the dark output canvas, browser surface, and action button
      // after decode without relying on encoder-specific RGB bytes.
      expect(
        isRgbWithin(averagePpmRegion(opening, 20, 600, 40, 40), { r: 15, g: 23, b: 42 }, 20),
      ).toBe(true);
      expect(
        isRgbWithin(averagePpmRegion(opening, 400, 650, 40, 40), { r: 248, g: 250, b: 252 }, 20),
      ).toBe(true);
      expect(
        isRgbWithin(averagePpmRegion(opening, 600, 500, 40, 20), { r: 37, g: 99, b: 235 }, 25),
      ).toBe(true);

      const openingAtClick = ppmPixelAt(opening, 977, 484);
      const clickTreatment = ppmPixelAt(click, 977, 484);
      expect(clickTreatment.r).toBeGreaterThan(170);
      expect(clickTreatment.r - clickTreatment.g).toBeGreaterThan(50);
      expect(clickTreatment.b).toBeGreaterThan(90);
      expect(
        Math.abs(clickTreatment.r - openingAtClick.r) +
          Math.abs(clickTreatment.g - openingAtClick.g) +
          Math.abs(clickTreatment.b - openingAtClick.b),
      ).toBeGreaterThan(100);
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
