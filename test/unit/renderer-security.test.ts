import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodePresentationFrames,
  encodingQualityProfile,
  stageVerifiedMediaAsset,
} from "../../src/encoder/presentation.js";
import { buildCompositionPlan } from "../../src/render/composition.js";
import { assertRasterSourceBounded } from "../../src/render/project-renderer.js";
import { buildClipSchedule, presentationTimeForSource } from "../../src/render/timeline-mapping.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("renderer production bounds", () => {
  it("maps absolute source time through trims, speed ramps, and crossfade overlap", () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      source: { width: 160, height: 90, fps: 30, durationUs: 2_000_000 },
      clips: [
        {
          id: "first",
          sourceId: "capture-a",
          startUs: 500_000,
          endUs: 1_500_000,
          speedRegions: [
            { startUs: 500_000, endUs: 1_000_000, startRate: 1, endRate: 2 },
            { startUs: 1_000_000, endUs: 1_500_000, startRate: 2, endRate: 1 },
          ],
          transitionAfter: { kind: "crossfade", durationUs: 100_000 },
        },
        {
          id: "second",
          sourceId: "capture-b",
          startUs: 200_000,
          endUs: 700_000,
        },
      ],
    });
    const schedule = buildClipSchedule(plan);
    const first = schedule[0];
    const second = schedule[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined)
      throw new Error("expected a two-clip schedule");

    expect(presentationTimeForSource(first, 1_000_000)).toBeCloseTo(346_574, -1);
    expect(second.presentationStartUs).toBeCloseTo(first.renderedDurationUs - 100_000, -1);
  });

  it("evaluates zoom regions in absolute source time for a trimmed clip", () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      source: { width: 160, height: 90, fps: 30, durationUs: 2_000_000 },
      clips: [{ id: "trimmed", startUs: 500_000, endUs: 1_500_000 }],
      zoomRegions: [
        {
          id: "absolute-zoom",
          clipId: "trimmed",
          tUs: 750_000,
          startUs: 600_000,
          endUs: 900_000,
          mode: "manual",
          easing: "linear",
          x: 80,
          y: 45,
          scale: 1.5,
        },
      ],
    });

    expect(plan.zoomAt(100_000, "trimmed", 750_000)?.scale).toBeCloseTo(1.25);
    expect(plan.zoomAt(100_000, "trimmed", 250_000)).toBeUndefined();
  });

  it("rejects a crossfade longer than either adjacent rendered clip", () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      source: { width: 160, height: 90, fps: 30, durationUs: 1_000_000 },
      clips: [
        {
          id: "first",
          startUs: 0,
          endUs: 500_000,
          transitionAfter: { kind: "crossfade", durationUs: 400_000 },
        },
        {
          id: "second",
          startUs: 0,
          endUs: 100_000,
        },
      ],
    });

    expect(() => buildClipSchedule(plan)).toThrow(/adjacent/u);
  });

  it("stream-hashes only capped, recognized media types", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-media-bound-"));
    roots.push(root);
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "staging"), { mode: 0o700 });
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
      Buffer.alloc(52),
    ]);
    await writeFile(join(root, "assets", "audio.wav"), wav);
    await writeFile(join(root, "assets", "oversize.wav"), Buffer.alloc(129));
    const sha256 = createHash("sha256").update(wav).digest("hex");

    const staged = await stageVerifiedMediaAsset({
      assetRoot: join(root, "assets"),
      relativePath: "audio.wav",
      sha256,
      mediaKind: "audio-wav",
      maximumBytes: 128,
      stagingRoot: join(root, "staging"),
      stagingName: "audio.wav",
    });
    expect(await readFile(staged)).toEqual(wav);
    expect((await stat(staged)).mode & 0o777).toBe(0o600);
    await expect(
      stageVerifiedMediaAsset({
        assetRoot: join(root, "assets"),
        relativePath: "oversize.wav",
        sha256: createHash("sha256").update(Buffer.alloc(129)).digest("hex"),
        mediaKind: "audio-wav",
        maximumBytes: 128,
        stagingRoot: join(root, "staging"),
        stagingName: "oversize.wav",
      }),
    ).rejects.toThrow(/size/u);
    await expect(
      stageVerifiedMediaAsset({
        assetRoot: join(root, "assets"),
        relativePath: "audio.wav",
        sha256,
        mediaKind: "pip-ppm",
        maximumBytes: 128,
        stagingRoot: join(root, "staging"),
        stagingName: "wrong-type.ppm",
      }),
    ).rejects.toThrow(/type/u);
    expect(await readdir(join(root, "staging"))).toEqual(["audio.wav"]);
  });

  it("consumes a private verified snapshot when the source pathname is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-media-race-"));
    roots.push(root);
    const assetRoot = join(root, "assets");
    const stagingRoot = join(root, "staging");
    await mkdir(assetRoot);
    await mkdir(stagingRoot, { mode: 0o700 });
    const original = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
      Buffer.from("trusted"),
    ]);
    const replacement = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
      Buffer.from("replaced"),
    ]);
    const sourcePath = join(assetRoot, "audio.wav");
    const originalPpm = Buffer.from("P6\n2 2\n255\nabcdefghijkl");
    const replacementPpm = Buffer.from("P6\n2 2\n255\nmnopqrstuvwx");
    const pipPath = join(assetRoot, "pip.ppm");
    await writeFile(sourcePath, original);
    await writeFile(pipPath, originalPpm);

    const stagedPath = await stageVerifiedMediaAsset({
      assetRoot,
      relativePath: "audio.wav",
      sha256: createHash("sha256").update(original).digest("hex"),
      mediaKind: "audio-wav",
      maximumBytes: 128,
      stagingRoot,
      stagingName: "audio.wav",
    });
    const stagedPipPath = await stageVerifiedMediaAsset({
      assetRoot,
      relativePath: "pip.ppm",
      sha256: createHash("sha256").update(originalPpm).digest("hex"),
      mediaKind: "pip-ppm",
      maximumBytes: 128,
      stagingRoot,
      stagingName: "pip.ppm",
    });
    await writeFile(sourcePath, replacement);
    await writeFile(pipPath, replacementPpm);

    expect(await readFile(stagedPath)).toEqual(original);
    expect(await readFile(sourcePath)).toEqual(replacement);
    expect(await readFile(stagedPipPath)).toEqual(originalPpm);
    expect(await readFile(pipPath)).toEqual(replacementPpm);
  });

  it("rejects oversized output frames before spawning ffmpeg", async () => {
    await expect(
      encodePresentationFrames({
        frames: [Buffer.alloc(1)],
        width: 4096,
        height: 4096,
        fps: 30,
        format: "mp4",
        quality: "standard",
        durationUs: 33_333,
        outputPath: "/tmp/recordly-should-not-exist.mp4",
      }),
    ).rejects.toThrow(/pixel|bytes/u);
  });

  it("rejects audio placement or trim extending beyond assembled output", async () => {
    const base = {
      frames: [Buffer.alloc(2 * 2 * 3)],
      width: 2,
      height: 2,
      fps: 30,
      format: "mp4" as const,
      quality: "standard" as const,
      durationUs: 100_000,
      outputPath: "/tmp/recordly-should-not-exist.mp4",
    };
    await expect(
      encodePresentationFrames({
        ...base,
        audioTracks: [
          {
            path: "/tmp/not-opened.wav",
            startUs: 100_000,
            trim: { startUs: 0, endUs: 1 },
            gainDb: 0,
          },
        ],
      }),
    ).rejects.toThrow(/audio timing/u);
    await expect(
      encodePresentationFrames({
        ...base,
        audioTracks: [
          {
            path: "/tmp/not-opened.wav",
            startUs: 75_000,
            trim: { startUs: 0, endUs: 50_000 },
            gainDb: 0,
          },
        ],
      }),
    ).rejects.toThrow(/audio timing/u);
  });

  it("rejects oversized decoded source geometry before composition", () => {
    expect(() => assertRasterSourceBounded({ width: 4096, height: 2161 })).toThrow(/pixel/u);
    expect(() => assertRasterSourceBounded({ width: 3840, height: 2160 })).not.toThrow();
  });

  it("uses deterministic encoding settings for every accepted quality", () => {
    expect(encodingQualityProfile("draft")).toEqual({
      x264Preset: "veryfast",
      x264Crf: 28,
      gifColors: 128,
    });
    expect(encodingQualityProfile("standard")).toEqual({
      x264Preset: "medium",
      x264Crf: 23,
      gifColors: 192,
    });
    expect(encodingQualityProfile("high")).toEqual({
      x264Preset: "slow",
      x264Crf: 18,
      gifColors: 256,
    });
  });
});
