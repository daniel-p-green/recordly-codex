import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupFixtureArtifacts,
  createFixtureArtifactPaths,
  resolveMediaExecutable,
} from "../../src/encoder/ffmpeg.js";
import { encodePresentationFrames } from "../../src/encoder/presentation.js";
import { extractFixtureSampleFrames, probeRenderedVideo } from "../../src/encoder/probe.js";
import {
  migrateV1RecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "../../src/project/index.js";
import {
  buildCompositionPlan,
  buildCompositionPlanFromProject,
  type VisualTrack,
} from "../../src/render/composition.js";
import { renderRecordingProject } from "../../src/render/project-renderer.js";
import {
  composePresentationFrames,
  type RasterSource,
  streamPresentationFrames,
} from "../../src/render/raster-compositor.js";
import { parsePpm, ppmPixelAt } from "../support/ppm.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

function sourceFrame(color: { r: number; g: number; b: number }): Buffer {
  const pixels = Buffer.alloc(160 * 90 * 3);
  for (let y = 0; y < 90; y += 1) {
    for (let x = 0; x < 160; x += 1) {
      const offset = (y * 160 + x) * 3;
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
      if (x > 90 && x < 130 && y > 30 && y < 60) {
        pixels[offset] = 37;
        pixels[offset + 1] = 99;
        pixels[offset + 2] = 235;
      }
    }
  }
  return pixels;
}

function flatSourceFrame(color: { r: number; g: number; b: number }): Buffer {
  const pixels = Buffer.alloc(160 * 90 * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = color.r;
    pixels[offset + 1] = color.g;
    pixels[offset + 2] = color.b;
  }
  return pixels;
}

function solidRaster(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3)
    pixels.set([color.r, color.g, color.b], offset);
  return pixels;
}

function splitSourceFrame(): Buffer {
  const pixels = Buffer.alloc(160 * 90 * 3);
  for (let y = 0; y < 90; y += 1)
    for (let x = 0; x < 160; x += 1) {
      const offset = (y * 160 + x) * 3;
      if (x < 80) pixels.set([240, 20, 20], offset);
      else pixels.set([20, 20, 240], offset);
    }
  return pixels;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ppm(pixels: Buffer, width: number, height: number): Buffer {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"), pixels]);
}

function wav(): Buffer {
  const samples = Buffer.alloc(800 * 2);
  for (let index = 0; index < 800; index += 1)
    samples.writeInt16LE(Math.round(Math.sin(index / 8) * 4000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

function hasRedPixelInRegion(
  image: ReturnType<typeof parsePpm>,
  left: number,
  top: number,
  width: number,
  height: number,
): boolean {
  for (let y = top; y < top + height; y += 1)
    for (let x = left; x < left + width; x += 1) {
      const pixel = ppmPixelAt(image, x, y);
      if (pixel.r > pixel.g + 60 && pixel.r > pixel.b + 60) return true;
    }
  return false;
}

async function extractPpm(
  inputPath: string,
  timestampSeconds: number,
  outputPath: string,
): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-ss",
    timestampSeconds.toFixed(6),
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-vcodec",
    "ppm",
    "-y",
    outputPath,
  ]);
}

async function extractPpmFrame(
  inputPath: string,
  frameIndex: number,
  outputPath: string,
): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vf",
    `select=eq(n\\,${frameIndex})`,
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-vcodec",
    "ppm",
    "-y",
    outputPath,
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("presentation compositor", () => {
  it("renders every V2 cursor and frame control while leaving the V1 plan recipe unchanged", async () => {
    const base = {
      schemaVersion: 1 as const,
      preset: "minimal",
      source: { width: 160, height: 40, fps: 30, durationUs: 100_000 },
      clips: [{ id: "capture", sourceId: "capture", startUs: 0, endUs: 100_000 }],
      cursorTrack: [
        { tUs: 0, x: 20, y: 20, state: "default" as const },
        { tUs: 66_667, x: 120, y: 20, state: "pressed" as const },
      ],
    };
    const source: RasterSource = {
      id: "capture",
      width: 160,
      height: 40,
      frames: [{ tUs: 0, pixels: solidRaster(160, 40, { r: 230, g: 80, b: 40 }) }],
    };
    const framesFor = async (
      presentationControls?: Parameters<typeof buildCompositionPlan>[0]["presentationControls"],
    ): Promise<Buffer[]> =>
      composePresentationFrames({
        plan: buildCompositionPlan({
          ...base,
          ...(presentationControls === undefined ? {} : { presentationControls }),
        }),
        sources: [source],
      });

    const legacy = await framesFor();
    const baseline = await framesFor({
      cursor: { emphasis: "none", trailDurationUs: 0 },
      frame: { fit: "contain", border: "none" },
      export: { audio: "include", colorRange: "limited", metadata: "minimal" },
    });
    const spotlight = await framesFor({
      cursor: { emphasis: "spotlight", trailDurationUs: 0 },
      frame: { fit: "contain", border: "none" },
      export: { audio: "include", colorRange: "limited", metadata: "minimal" },
    });
    const trail = await framesFor({
      cursor: { emphasis: "trail", trailDurationUs: 80_000 },
      frame: { fit: "contain", border: "none" },
      export: { audio: "include", colorRange: "limited", metadata: "minimal" },
    });
    const covered = await framesFor({
      cursor: { emphasis: "none", trailDurationUs: 0 },
      frame: { fit: "cover", border: "none" },
      export: { audio: "include", colorRange: "limited", metadata: "minimal" },
    });
    const bordered = await framesFor({
      cursor: { emphasis: "none", trailDurationUs: 0 },
      frame: { fit: "contain", border: "strong" },
      export: { audio: "include", colorRange: "limited", metadata: "minimal" },
    });

    expect(Buffer.concat(legacy).equals(Buffer.concat(baseline))).toBe(true);
    expect(Buffer.concat(spotlight).equals(Buffer.concat(baseline))).toBe(false);
    expect(Buffer.concat(trail).equals(Buffer.concat(baseline))).toBe(false);
    expect(Buffer.concat(covered).equals(Buffer.concat(baseline))).toBe(false);
    expect(Buffer.concat(bordered).equals(Buffer.concat(baseline))).toBe(false);
  }, 30_000);

  it("renders every speed region and blends crossfade frames while keeping output bounded", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 200_000 },
      clips: [
        {
          id: "red",
          sourceId: "red",
          startUs: 0,
          endUs: 100_000,
          speedRegions: [
            { startUs: 0, endUs: 50_000, startRate: 1, endRate: 2 },
            { startUs: 50_000, endUs: 100_000, startRate: 2, endRate: 1 },
          ],
          transitionAfter: { kind: "crossfade", durationUs: 66_667 },
        },
        {
          id: "blue",
          sourceId: "blue",
          startUs: 0,
          endUs: 100_000,
          speedRegions: [],
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
      ],
    });
    const frames: Buffer[] = [];
    for await (const frame of streamPresentationFrames({
      plan,
      sources: [
        {
          id: "red",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: sourceFrame({ r: 240, g: 20, b: 20 }) }],
        },
        {
          id: "blue",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: sourceFrame({ r: 20, g: 20, b: 240 }) }],
        },
      ],
    }))
      frames.push(frame);
    expect(frames).toHaveLength(3);
    const crossfadePixel = (frames[1] as Buffer)[(540 * 1920 + 960) * 3] as number;
    expect(crossfadePixel).toBeGreaterThan(20);
    expect(crossfadePixel).toBeLessThan(240);
    const root = await mkdtemp(join(tmpdir(), "recordly-crossfade-decode-"));
    roots.push(root);
    const outputPath = join(root, "crossfade.mp4");
    await encodePresentationFrames({
      frames,
      width: 1920,
      height: 1080,
      fps: 30,
      format: "mp4",
      quality: "standard",
      durationUs: 100_000,
      outputPath,
    });
    const decodedPath = join(root, "crossfade.ppm");
    await extractPpmFrame(outputPath, 1, decodedPath);
    const decoded = parsePpm(await readFile(decodedPath));
    const decodedTransition = ppmPixelAt(decoded, 960, 540);
    expect(decodedTransition.r).toBeGreaterThan(50);
    expect(decodedTransition.b).toBeGreaterThan(50);
  });

  it("composes a reviewed V2 wipe at the complete scene boundary", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [
        {
          id: "red",
          sourceId: "red",
          startUs: 0,
          endUs: 100_000,
          transitionAfter: { kind: "crossfade", durationUs: 66_667 },
        },
        {
          id: "blue",
          sourceId: "blue",
          startUs: 0,
          endUs: 100_000,
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
      ],
    });
    plan.reviewedTransitions = [
      {
        clipId: "red",
        family: "wipe-left",
        durationUs: 66_667,
        easing: "linear",
      },
    ];

    const frames = await composePresentationFrames({
      plan,
      sources: [
        {
          id: "red",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 240, g: 20, b: 20 }) }],
        },
        {
          id: "blue",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 20, g: 20, b: 240 }) }],
        },
      ],
    });

    const middle = frames[2] as Buffer;
    const left = (540 * 1920 + 480) * 3;
    const right = (540 * 1920 + 1000) * 3;
    expect(middle[left]).toBeLessThan(80);
    expect(middle[left + 2]).toBeGreaterThan(180);
    expect(middle[right]).toBeGreaterThan(180);
    expect(middle[right + 2]).toBeLessThan(80);

    const root = await mkdtemp(join(tmpdir(), "recordly-v2-wipe-decode-"));
    roots.push(root);
    const outputPath = join(root, "wipe.mp4");
    await encodePresentationFrames({
      frames,
      width: 1920,
      height: 1080,
      fps: 30,
      format: "mp4",
      quality: "standard",
      durationUs: Math.round((frames.length * 1_000_000) / 30),
      outputPath,
    });
    const decodedPath = join(root, "wipe.ppm");
    await extractPpmFrame(outputPath, 2, decodedPath);
    const decoded = parsePpm(await readFile(decodedPath));
    const decodedLeft = ppmPixelAt(decoded, 480, 540);
    const decodedRight = ppmPixelAt(decoded, 1000, 540);
    expect(decodedLeft.b).toBeGreaterThan(decodedLeft.r + 80);
    expect(decodedRight.r).toBeGreaterThan(decodedRight.b + 80);
  }, 30_000);

  it("executes every reviewed V2 transition family deterministically", async () => {
    const expected = [
      { family: "crossfade", easing: "ease-in-out", left: "mixed", right: "mixed" },
      { family: "dip-to-color", easing: "linear", left: "dark", right: "dark" },
      { family: "wipe-left", easing: "ease-out", left: "blue", right: "blue" },
      { family: "wipe-right", easing: "ease-in-out", left: "red", right: "blue" },
      { family: "slide-left", easing: "linear", left: "red", right: "blue" },
      { family: "slide-right", easing: "linear", left: "blue", right: "red" },
      { family: "cut", easing: "linear", left: "red", right: "red" },
    ] as const;
    for (const transition of expected) {
      const durationUs = transition.family === "cut" ? 0 : 66_667;
      const plan = buildCompositionPlan({
        schemaVersion: 1,
        preset: "minimal",
        source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
        clips: [
          {
            id: "red",
            sourceId: "red",
            startUs: 0,
            endUs: 100_000,
            transitionAfter: {
              kind: transition.family === "cut" ? "cut" : "crossfade",
              durationUs,
            },
          },
          {
            id: "blue",
            sourceId: "blue",
            startUs: 0,
            endUs: 100_000,
            transitionAfter: { kind: "cut", durationUs: 0 },
          },
        ],
      });
      plan.reviewedTransitions = [
        {
          clipId: "red",
          family: transition.family,
          durationUs,
          easing: transition.easing,
          ...(transition.family === "dip-to-color" ? { color: "#000000" } : {}),
        },
      ];
      const input = {
        plan,
        sources: [
          {
            id: "red",
            width: 160,
            height: 90,
            frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 240, g: 20, b: 20 }) }],
          },
          {
            id: "blue",
            width: 160,
            height: 90,
            frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 20, g: 20, b: 240 }) }],
          },
        ],
      };
      const first = await composePresentationFrames(input);
      const second = await composePresentationFrames(input);
      expect(Buffer.concat(first).equals(Buffer.concat(second))).toBe(true);
      const checkpoint = first[transition.family === "cut" ? 0 : 2] as Buffer;
      const left = checkpoint[(540 * 1920 + 480) * 3] as number;
      const leftBlue = checkpoint[(540 * 1920 + 480) * 3 + 2] as number;
      const rightX = transition.family.startsWith("slide") ? 1400 : 1000;
      const right = checkpoint[(540 * 1920 + rightX) * 3] as number;
      const rightBlue = checkpoint[(540 * 1920 + rightX) * 3 + 2] as number;
      const assertColor = (value: "mixed" | "dark" | "red" | "blue", red: number, blue: number) => {
        if (value === "mixed") {
          expect(red).toBeGreaterThan(70);
          expect(blue).toBeGreaterThan(70);
        } else if (value === "dark") {
          expect(red).toBeLessThan(20);
          expect(blue).toBeLessThan(20);
        } else if (value === "red") {
          expect(red).toBeGreaterThan(180);
          expect(blue).toBeLessThan(80);
        } else {
          expect(red, `${transition.family} should reveal blue`).toBeLessThan(80);
          expect(blue, `${transition.family} should reveal blue`).toBeGreaterThan(180);
        }
      };
      assertColor(transition.left, left, leftBlue);
      assertColor(transition.right, right, rightBlue);
    }
  }, 60_000);

  it("includes the incoming V2 scene PiP before a reviewed crossfade", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [
        {
          id: "red",
          sourceId: "red",
          startUs: 0,
          endUs: 100_000,
          transitionAfter: { kind: "crossfade", durationUs: 66_667 },
        },
        {
          id: "blue",
          sourceId: "blue",
          startUs: 0,
          endUs: 100_000,
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
      ],
      pipTracks: [
        {
          assetId: "next-pip",
          sha256: "f".repeat(64),
          clipId: "blue",
          startUs: 0,
          endUs: 100_000,
          corner: "top-right",
          scale: 0.25,
        },
      ],
    });
    plan.reviewedTransitions = [
      { clipId: "red", family: "crossfade", durationUs: 66_667, easing: "linear" },
    ];
    plan.visualTracks = [
      {
        id: "next-visual",
        mediaId: "next-visual",
        media: { kind: "image", durationUs: 1 },
        clipId: "blue",
        startUs: 0,
        endUs: 100_000,
        mediaTrim: { startUs: 0, endUs: 1 },
        sync: "output-time",
        layout: {
          position: "top-left",
          scale: 0.2,
          fit: "cover",
          crop: "none",
          opacity: 1,
          radiusPx: 0,
          border: "none",
        },
        motion: { preset: "none", durationUs: 0 },
      },
    ];
    const frames = await composePresentationFrames({
      plan,
      sources: [
        {
          id: "red",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 240, g: 20, b: 20 }) }],
        },
        {
          id: "blue",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 20, g: 20, b: 240 }) }],
        },
        {
          id: "next-pip",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 20, g: 240, b: 20 }) }],
        },
        {
          id: "next-visual",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 240, g: 240, b: 20 }) }],
        },
      ],
    });
    const pixel = (frames[2] as Buffer).subarray(
      (180 * 1920 + 1600) * 3,
      (180 * 1920 + 1600) * 3 + 3,
    );
    expect(pixel[1]).toBeGreaterThan((pixel[2] as number) + 60);
    const visualPixel = (frames[2] as Buffer).subarray(
      (132 * 1920 + 216) * 3,
      (132 * 1920 + 216) * 3 + 3,
    );
    expect(visualPixel[1]).toBeGreaterThan((visualPixel[2] as number) + 80);
  });

  it("renders only accepted V2 zoom proposals while preserving V1 zoom pixels", async () => {
    const v1 = {
      schemaVersion: 1,
      projectId: "reviewed-zoom-render",
      revision: 0,
      revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
      captureSources: [
        {
          id: "capture",
          sessionId: "session",
          manifestSha256: "a".repeat(64),
          timelineSha256: "b".repeat(64),
          frameSetSha256: "c".repeat(64),
          sourceWidth: 160,
          sourceHeight: 90,
          durationUs: 100_000,
        },
      ],
      output: {
        profile: "landscape-1080p",
        width: 1920,
        height: 1080,
        fps: 30,
        format: "mp4",
        quality: "standard",
      },
      timeline: {
        clips: [
          {
            id: "clip",
            sourceId: "capture",
            trim: { startUs: 0, endUs: 100_000 },
            speedRegions: [],
            zoomRegions: [
              {
                id: "legacy-zoom",
                startUs: 0,
                endUs: 100_000,
                mode: "manual",
                focus: { x: 0.25, y: 0.5 },
                scale: 2,
                easing: "linear",
              },
            ],
            transitionAfter: { kind: "cut", durationUs: 0 },
          },
        ],
      },
      presentation: {
        cursor: {
          visible: false,
          preset: "system",
          sizePx: 24,
          motion: "source",
          clickEffect: "none",
        },
        frame: {
          background: { kind: "solid", color: "#000000" },
          paddingPx: 0,
          radiusPx: 0,
          shadow: "none",
        },
      },
      overlays: { annotations: [], captions: [] },
      audioTracks: [],
      pipTracks: [],
      renderHooks: [],
      preview: { status: "not-requested" },
    };
    const source = {
      id: "capture",
      width: 160,
      height: 90,
      frames: [{ tUs: 0, pixels: splitSourceFrame() }],
    };
    const renderProjectFrames = async (project: unknown): Promise<Buffer[]> =>
      composePresentationFrames({
        plan: buildCompositionPlanFromProject(toProjectRenderInput(project)),
        sources: [source],
      });
    const pixelAtCheckpoint = (frames: readonly Buffer[]): { r: number; b: number } => {
      const offset = (540 * 1920 + 1200) * 3;
      const frame = frames[2] as Buffer;
      return { r: frame[offset] as number, b: frame[offset + 2] as number };
    };

    const v1Frames = await renderProjectFrames(v1);
    const migrated = migrateV1RecordingProject(v1);
    const v2Project = (status: "accepted" | "proposed" | "rejected") =>
      validateRecordingProject({
        ...migrated,
        zoomProposals: [
          {
            id: "reviewed-zoom",
            clipId: "clip",
            sourceRange: { startUs: 0, endUs: 100_000 },
            focus: { x: 0.25, y: 0.5 },
            scale: 2,
            easing: "linear",
            review: { status, basis: "observed-input" },
          },
        ],
      });
    const accepted = await renderProjectFrames(v2Project("accepted"));
    const acceptedRepeat = await renderProjectFrames(v2Project("accepted"));
    const proposed = await renderProjectFrames(v2Project("proposed"));
    const rejected = await renderProjectFrames(v2Project("rejected"));

    expect(pixelAtCheckpoint(v1Frames).r).toBeGreaterThan(pixelAtCheckpoint(v1Frames).b + 100);
    expect(pixelAtCheckpoint(accepted).r).toBeGreaterThan(pixelAtCheckpoint(accepted).b + 100);
    expect(pixelAtCheckpoint(proposed).b).toBeGreaterThan(pixelAtCheckpoint(proposed).r + 100);
    expect(pixelAtCheckpoint(rejected).b).toBeGreaterThan(pixelAtCheckpoint(rejected).r + 100);
    expect(Buffer.concat(accepted).equals(Buffer.concat(acceptedRepeat))).toBe(true);
  }, 30_000);

  it("renders a validated V2 visual image track from a resolved media-ID raster source", async () => {
    const migrated = migrateV1RecordingProject({
      schemaVersion: 1,
      projectId: "visual-image-render",
      revision: 0,
      revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
      captureSources: [
        {
          id: "capture",
          sessionId: "session",
          manifestSha256: "a".repeat(64),
          timelineSha256: "b".repeat(64),
          frameSetSha256: "c".repeat(64),
          sourceWidth: 160,
          sourceHeight: 90,
          durationUs: 100_000,
        },
      ],
      output: {
        profile: "landscape-1080p",
        width: 1920,
        height: 1080,
        fps: 30,
        format: "mp4",
        quality: "standard",
      },
      timeline: {
        clips: [
          {
            id: "clip",
            sourceId: "capture",
            trim: { startUs: 0, endUs: 100_000 },
            speedRegions: [],
            zoomRegions: [],
            transitionAfter: { kind: "cut", durationUs: 0 },
          },
        ],
      },
      presentation: {
        cursor: {
          visible: false,
          preset: "system",
          sizePx: 24,
          motion: "source",
          clickEffect: "none",
        },
        frame: {
          background: { kind: "solid", color: "#000000" },
          paddingPx: 0,
          radiusPx: 0,
          shadow: "none",
        },
      },
      overlays: { annotations: [], captions: [] },
      audioTracks: [],
      pipTracks: [],
      renderHooks: [],
      preview: { status: "not-requested" },
    });
    const project = validateRecordingProject({
      ...migrated,
      media: {
        assets: [
          ...migrated.media.assets,
          {
            id: "still",
            sha256: "d".repeat(64),
            kind: "image",
            provenance: "explicit-local-import",
            durationUs: 1,
          },
          {
            id: "video",
            sha256: "e".repeat(64),
            kind: "video",
            provenance: "explicit-local-import",
            durationUs: 100_000,
            width: 80,
            height: 80,
            fps: 30,
          },
        ],
      },
      visualTracks: [
        {
          id: "still-track",
          mediaId: "still",
          clipId: "clip",
          timeDomain: "clip-source-relative",
          startUs: 0,
          endUs: 100_000,
          mediaTrim: { startUs: 0, endUs: 1 },
          sync: "output-time",
          layout: {
            position: "top-right",
            scale: 0.2,
            fit: "contain",
            crop: "none",
            opacity: 1,
            radiusPx: 0,
            border: "none",
          },
          motion: { preset: "none", durationUs: 0 },
        },
        {
          id: "video-track",
          mediaId: "video",
          clipId: "clip",
          timeDomain: "clip-source-relative",
          startUs: 0,
          endUs: 100_000,
          mediaTrim: { startUs: 0, endUs: 100_000 },
          sync: "source-time",
          layout: {
            position: "bottom-left",
            scale: 0.2,
            fit: "contain",
            crop: "none",
            opacity: 1,
            radiusPx: 0,
            border: "none",
          },
          motion: { preset: "none", durationUs: 0 },
        },
      ],
    });
    const plan = buildCompositionPlanFromProject(toProjectRenderInput(project));
    const frames = await composePresentationFrames({
      plan,
      sources: [
        {
          id: "capture",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 40, g: 40, b: 40 }) }],
        },
        {
          id: "still",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 20, g: 230, b: 40 }) }],
        },
        {
          id: "video",
          width: 80,
          height: 80,
          frameAt: (tUs: number) => ({
            tUs,
            pixels: solidRaster(80, 80, { r: 20, g: 40, b: 230 }),
          }),
        },
      ],
    });

    const pixel = (frames[1] as Buffer).subarray(
      (120 * 1920 + 1700) * 3,
      (120 * 1920 + 1700) * 3 + 3,
    );
    expect(pixel[1]).toBeGreaterThan((pixel[0] as number) + 100);
    const videoPixel = (frames[1] as Buffer).subarray(
      (948 * 1920 + 216) * 3,
      (948 * 1920 + 216) * 3 + 3,
    );
    expect(videoPixel[2]).toBeGreaterThan((videoPixel[0] as number) + 100);
  });

  it("composes lazy V2 video and image tracks with temporal sync, fit, crop, motion, and borders", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 200_000 },
      clips: [
        {
          id: "clip",
          sourceId: "capture",
          startUs: 0,
          endUs: 200_000,
          speedRegions: [{ startUs: 0, endUs: 200_000, startRate: 2, endRate: 2 }],
        },
      ],
    });
    plan.visualTracks = [
      {
        id: "source-video",
        mediaId: "source-video",
        media: { kind: "video", durationUs: 200_000, width: 80, height: 80 },
        clipId: "clip",
        startUs: 0,
        endUs: 200_000,
        mediaTrim: { startUs: 0, endUs: 200_000 },
        sync: "source-time",
        layout: {
          position: "bottom-left",
          scale: 0.2,
          fit: "contain",
          crop: "none",
          opacity: 1,
          radiusPx: 0,
          border: "strong",
        },
        motion: { preset: "pop", durationUs: 50_000 },
      },
      {
        id: "output-video",
        mediaId: "output-video",
        media: { kind: "video", durationUs: 100_000, width: 80, height: 80 },
        clipId: "clip",
        startUs: 0,
        endUs: 200_000,
        mediaTrim: { startUs: 0, endUs: 100_000 },
        sync: "output-time",
        layout: {
          position: "top-left",
          scale: 0.2,
          fit: "contain",
          crop: "none",
          opacity: 0.8,
          radiusPx: 20,
          border: "light",
        },
        motion: { preset: "fade", durationUs: 50_000 },
      },
      {
        id: "still-image",
        mediaId: "still-image",
        media: { kind: "image", durationUs: 1 },
        clipId: "clip",
        startUs: 0,
        endUs: 200_000,
        mediaTrim: { startUs: 0, endUs: 1 },
        sync: "output-time",
        layout: {
          position: "top-right",
          scale: 0.2,
          fit: "cover",
          crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
          opacity: 1,
          radiusPx: 0,
          border: "none",
        },
        motion: { preset: "none", durationUs: 0 },
      },
    ] satisfies VisualTrack[];
    const sourceVideoTimes: number[] = [];
    const outputVideoTimes: number[] = [];
    const imageTimes: number[] = [];
    const still = solidRaster(160, 90, { r: 240, g: 220, b: 20 });
    for (let y = 0; y < 90; y += 1)
      for (let x = 0; x < 80; x += 1) still.set([220, 20, 20], (y * 160 + x) * 3);
    const input = {
      plan,
      sources: [
        {
          id: "capture",
          width: 160,
          height: 90,
          frameAt: (tUs: number) => ({ tUs, pixels: flatSourceFrame({ r: 40, g: 40, b: 40 }) }),
        },
        {
          id: "source-video",
          width: 80,
          height: 80,
          frameAt: (tUs: number) => {
            sourceVideoTimes.push(tUs);
            return {
              tUs,
              pixels: solidRaster(
                80,
                80,
                tUs < 50_000
                  ? { r: 220, g: 20, b: 20 }
                  : tUs < 100_000
                    ? { r: 20, g: 220, b: 20 }
                    : { r: 20, g: 20, b: 220 },
              ),
            };
          },
        },
        {
          id: "output-video",
          width: 80,
          height: 80,
          frameAt: (tUs: number) => {
            outputVideoTimes.push(tUs);
            return {
              tUs,
              pixels: solidRaster(
                80,
                80,
                tUs < 50_000 ? { r: 220, g: 220, b: 20 } : { r: 20, g: 220, b: 20 },
              ),
            };
          },
        },
        {
          id: "still-image",
          width: 160,
          height: 90,
          frameAt: (tUs: number) => {
            imageTimes.push(tUs);
            return { tUs, pixels: still };
          },
        },
      ],
    };
    const first = await composePresentationFrames(input);
    const repeat = await composePresentationFrames(input);
    const pixel = (frame: Buffer, x: number, y: number) => {
      const offset = (y * 1920 + x) * 3;
      return {
        r: frame[offset] as number,
        g: frame[offset + 1] as number,
        b: frame[offset + 2] as number,
      };
    };

    expect(first).toHaveLength(3);
    expect(pixel(first[0] as Buffer, 216, 132).r).toBeLessThan(80);
    expect(pixel(first[1] as Buffer, 216, 132).r).toBeGreaterThan(100);
    expect(pixel(first[2] as Buffer, 216, 132).g).toBeGreaterThan(150);
    expect(pixel(first[2] as Buffer, 50, 132).r).toBeGreaterThan(200);
    expect(pixel(first[2] as Buffer, 216, 24).r).toBeGreaterThan(180);
    expect(pixel(first[0] as Buffer, 216, 948).b).toBeLessThan(80);
    expect(pixel(first[2] as Buffer, 216, 948).b).toBeGreaterThan(150);
    expect(pixel(first[2] as Buffer, 216, 840).r).toBeLessThan(60);
    expect(pixel(first[0] as Buffer, 1704, 132)).toEqual(pixel(first[2] as Buffer, 1704, 132));
    expect(pixel(first[2] as Buffer, 1704, 132).r).toBeGreaterThan(200);
    expect(pixel(first[2] as Buffer, 1704, 132).b).toBeLessThan(80);
    expect(sourceVideoTimes.some((time) => time >= 130_000)).toBe(true);
    expect(outputVideoTimes.some((time) => time >= 60_000 && time <= 70_000)).toBe(true);
    expect(imageTimes.every((time) => time === 0)).toBe(true);
    expect(Buffer.concat(first).equals(Buffer.concat(repeat))).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "recordly-visual-track-decode-"));
    roots.push(root);
    const outputPath = join(root, "visual-track.mp4");
    await encodePresentationFrames({
      frames: first,
      width: 1920,
      height: 1080,
      fps: 30,
      format: "mp4",
      quality: "standard",
      durationUs: 100_000,
      outputPath,
    });
    const decodedPath = join(root, "visual-track.ppm");
    await extractPpmFrame(outputPath, 2, decodedPath);
    const decoded = parsePpm(await readFile(decodedPath));
    const decodedVideo = ppmPixelAt(decoded, 216, 948);
    const decodedImage = ppmPixelAt(decoded, 1704, 132);
    expect(decodedVideo.b).toBeGreaterThan(decodedVideo.r + 80);
    expect(decodedImage.r).toBeGreaterThan(decodedImage.b + 80);
  }, 30_000);

  it("fails closed when a V2 visual source is missing, mismatched, outside trim, or unsupported", async () => {
    const visualPlan = (mediaTrim = { startUs: 0, endUs: 100_000 }) => {
      const plan = buildCompositionPlan({
        schemaVersion: 1,
        preset: "minimal",
        source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
        clips: [{ id: "clip", sourceId: "capture", startUs: 0, endUs: 100_000 }],
      });
      plan.visualTracks = [
        {
          id: "visual",
          mediaId: "visual",
          media: { kind: "video", durationUs: 100_000, width: 80, height: 80 },
          clipId: "clip",
          startUs: 0,
          endUs: 100_000,
          mediaTrim,
          sync: "output-time",
          layout: {
            position: "top-left",
            scale: 0.2,
            fit: "contain",
            crop: "none",
            opacity: 1,
            radiusPx: 0,
            border: "none",
          },
          motion: { preset: "none", durationUs: 0 },
        },
      ];
      return plan;
    };
    const capture = {
      id: "capture",
      width: 160,
      height: 90,
      frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 40, g: 40, b: 40 }) }],
    };
    const video = {
      id: "visual",
      width: 80,
      height: 80,
      frames: [{ tUs: 0, pixels: solidRaster(80, 80, { r: 20, g: 220, b: 20 }) }],
    };

    await expect(
      composePresentationFrames({ plan: visualPlan(), sources: [capture] }),
    ).rejects.toThrow(/visual source is unavailable/u);
    await expect(
      composePresentationFrames({
        plan: visualPlan(),
        sources: [{ ...video, width: 81 }, capture],
      }),
    ).rejects.toThrow(/geometry/u);
    await expect(
      composePresentationFrames({
        plan: visualPlan({ startUs: 0, endUs: 1 }),
        sources: [capture, video],
      }),
    ).rejects.toThrow(/media trim/u);
    const unsupported = visualPlan();
    const track = unsupported.visualTracks?.[0] as VisualTrack;
    unsupported.visualTracks = [{ ...track, media: { ...track.media, kind: "audio" as never } }];
    await expect(
      composePresentationFrames({ plan: unsupported, sources: [capture, video] }),
    ).rejects.toThrow(/unsupported media kind/u);
  });

  it("clips cover crop rounding and strong borders to the visible layout box", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [{ id: "clip", sourceId: "capture", startUs: 0, endUs: 100_000 }],
    });
    plan.visualTracks = [
      {
        id: "portrait-cover",
        mediaId: "portrait-cover",
        media: { kind: "image", durationUs: 1 },
        clipId: "clip",
        startUs: 0,
        endUs: 100_000,
        mediaTrim: { startUs: 0, endUs: 1 },
        sync: "output-time",
        layout: {
          position: "top-left",
          scale: 0.2,
          fit: "cover",
          crop: "none",
          opacity: 1,
          radiusPx: 20,
          border: "strong",
        },
        motion: { preset: "none", durationUs: 0 },
      },
    ];
    const frames = await composePresentationFrames({
      plan,
      sources: [
        {
          id: "capture",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 40, g: 40, b: 40 }) }],
        },
        {
          id: "portrait-cover",
          width: 80,
          height: 160,
          frames: [{ tUs: 0, pixels: solidRaster(80, 160, { r: 20, g: 220, b: 20 }) }],
        },
      ],
    });
    const frame = frames[1] as Buffer;
    const pixel = (x: number, y: number) => {
      const offset = (y * 1920 + x) * 3;
      return {
        r: frame[offset] as number,
        g: frame[offset + 1] as number,
        b: frame[offset + 2] as number,
      };
    };

    expect(pixel(24, 24).r).toBeGreaterThan(200);
    expect(pixel(216, 24).r).toBeLessThan(60);
    expect(pixel(216, 120).g).toBeGreaterThan(150);
  });

  it("uses presentation time for visual fade motion under a speed-ramped clip", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 400_000 },
      clips: [
        {
          id: "clip",
          sourceId: "capture",
          startUs: 0,
          endUs: 400_000,
          speedRegions: [{ startUs: 0, endUs: 400_000, startRate: 2, endRate: 2 }],
        },
      ],
    });
    plan.visualTracks = [
      {
        id: "fading-video",
        mediaId: "fading-video",
        media: { kind: "video", durationUs: 400_000, width: 80, height: 80 },
        clipId: "clip",
        startUs: 0,
        endUs: 400_000,
        mediaTrim: { startUs: 0, endUs: 400_000 },
        sync: "source-time",
        layout: {
          position: "top-left",
          scale: 0.2,
          fit: "contain",
          crop: "none",
          opacity: 1,
          radiusPx: 0,
          border: "none",
        },
        motion: { preset: "fade", durationUs: 100_000 },
      },
    ];
    const frames = await composePresentationFrames({
      plan,
      sources: [
        {
          id: "capture",
          width: 160,
          height: 90,
          frames: [{ tUs: 0, pixels: flatSourceFrame({ r: 40, g: 40, b: 40 }) }],
        },
        {
          id: "fading-video",
          width: 80,
          height: 80,
          frameAt: (tUs: number) => ({
            tUs,
            pixels: solidRaster(80, 80, { r: 20, g: 220, b: 20 }),
          }),
        },
      ],
    });
    const greenAt = (frame: Buffer) => frame[(132 * 1920 + 216) * 3 + 1] as number;

    expect(frames).toHaveLength(6);
    expect(greenAt(frames[2] as Buffer)).toBeLessThan(200);
    expect(greenAt(frames[3] as Buffer)).toBeGreaterThan(200);
  });

  it("consumes a lazy frame provider one frame at a time without a decoded frame array", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [{ id: "lazy", sourceId: "lazy", startUs: 0, endUs: 100_000 }],
    });
    let calls = 0;
    let active = 0;
    let peakActive = 0;
    const source = {
      id: "lazy",
      width: 160,
      height: 90,
      async frameAt(tUs: number) {
        calls += 1;
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active -= 1;
        return { tUs, pixels: sourceFrame({ r: 20, g: 120, b: 220 }) };
      },
    };
    let emitted = 0;
    for await (const _frame of streamPresentationFrames({ plan, sources: [source] })) emitted += 1;
    expect("frames" in source).toBe(false);
    expect({ emitted, calls, peakActive }).toEqual({ emitted: 3, calls: 3, peakActive: 1 });
  });

  it("fails a declared crossfade that cannot create a visible transition", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [
        {
          id: "last",
          sourceId: "source",
          startUs: 0,
          endUs: 100_000,
          transitionAfter: { kind: "crossfade", durationUs: 33_334 },
        },
      ],
    });
    const source = {
      id: "source",
      width: 160,
      height: 90,
      frames: [{ tUs: 0, pixels: sourceFrame({ r: 1, g: 2, b: 3 }) }],
    };
    await expect(async () => {
      for await (const _frame of streamPresentationFrames({ plan, sources: [source] })) {
        // The stream must throw before emitting an untransitioned clip.
      }
    }).rejects.toThrow(/crossfade/u);
  });

  it("streams a valid project through verified PiP and trimmed mixed audio into decoded MP4 and GIF", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-project-render-"));
    roots.push(root);
    const assetRoot = join(root, "assets");
    await mkdir(assetRoot);
    const pip = sourceFrame({ r: 220, g: 38, b: 38 });
    const pipAsset = ppm(pip, 160, 90);
    const audio = wav();
    await writeFile(join(assetRoot, "pip.ppm"), pipAsset);
    await writeFile(join(assetRoot, "audio.wav"), audio);
    const base = {
      projectId: "project-render-1",
      revision: 0,
      revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
      captureSources: [
        {
          id: "capture",
          sessionId: "session",
          manifestSha256: "a".repeat(64),
          timelineSha256: "b".repeat(64),
          frameSetSha256: "c".repeat(64),
          sourceWidth: 160,
          sourceHeight: 90,
          durationUs: 200_000,
        },
      ],
      output: {
        profile: "landscape-1080p" as const,
        width: 1920 as const,
        height: 1080 as const,
        fps: 30 as const,
        format: "mp4" as const,
        quality: "draft" as const,
      },
      timeline: {
        clips: [
          {
            id: "one",
            sourceId: "capture",
            trim: { startUs: 0, endUs: 100_000 },
            speedRegions: [
              { startUs: 0, endUs: 50_000, startRate: 1, endRate: 2 },
              { startUs: 50_000, endUs: 100_000, startRate: 2, endRate: 1 },
            ],
            zoomRegions: [
              {
                id: "zoom",
                startUs: 0,
                endUs: 100_000,
                mode: "manual" as const,
                focus: { x: 0.75, y: 0.5 },
                scale: 1.4,
                easing: "ease-out" as const,
              },
            ],
            transitionAfter: { kind: "crossfade" as const, durationUs: 66_667 },
          },
          {
            id: "two",
            sourceId: "capture",
            trim: { startUs: 0, endUs: 100_000 },
            speedRegions: [],
            zoomRegions: [],
            transitionAfter: { kind: "cut" as const, durationUs: 0 },
          },
        ],
      },
      presentation: {
        cursor: {
          visible: true,
          preset: "large" as const,
          sizePx: 32,
          motion: "smoothed" as const,
          clickEffect: "bounce" as const,
        },
        frame: {
          background: { kind: "solid" as const, color: "#ffffff" },
          paddingPx: 16,
          radiusPx: 4,
          shadow: "none" as const,
        },
      },
      overlays: {
        annotations: [
          {
            id: "note",
            clipId: "one",
            timeDomain: "clip-source-relative" as const,
            startUs: 0,
            endUs: 66_667,
            text: {
              value: "Review",
              provenance: "authored" as const,
              exportDisposition: "allow" as const,
            },
            position: "top" as const,
            style: "emphasis" as const,
          },
        ],
        captions: [
          {
            id: "caption",
            clipId: "two",
            timeDomain: "clip-source-relative" as const,
            startUs: 0,
            endUs: 33_334,
            text: {
              value: "Next",
              provenance: "authored" as const,
              exportDisposition: "allow" as const,
            },
          },
        ],
      },
      audioTracks: [
        {
          id: "audio",
          asset: { assetId: "audio", sha256: digest(audio) },
          timeDomain: "project-output-relative" as const,
          startUs: 0,
          trim: { startUs: 0, endUs: 50_000 },
          gainDb: -3,
        },
        {
          id: "audio-2",
          asset: { assetId: "audio-2", sha256: digest(audio) },
          timeDomain: "project-output-relative" as const,
          startUs: 25_000,
          trim: { startUs: 0, endUs: 50_000 },
          gainDb: -6,
        },
      ],
      pipTracks: [
        {
          id: "pip",
          asset: { assetId: "pip", sha256: digest(pipAsset) },
          clipId: "one",
          timeDomain: "clip-source-relative" as const,
          startUs: 0,
          endUs: 100_000,
          position: "top-right" as const,
          scale: 0.2,
        },
      ],
      renderHooks: [
        {
          id: "watermark",
          kind: "watermark" as const,
          permission: "explicit-local-render-hook" as const,
          status: "declared" as const,
        },
      ],
    };
    const captureFrames = [
      { tUs: 0, pixels: sourceFrame({ r: 22, g: 163, b: 74 }) },
      { tUs: 33_333, pixels: sourceFrame({ r: 37, g: 99, b: 235 }) },
      { tUs: 66_667, pixels: sourceFrame({ r: 226, g: 232, b: 240 }) },
    ];
    const sources = [
      {
        id: "capture",
        width: 160,
        height: 90,
        frameAt: (tUs: number) =>
          captureFrames.reduce((closest, frame) =>
            Math.abs(frame.tUs - tUs) < Math.abs(closest.tUs - tUs) ? frame : closest,
          ),
      },
    ];
    const renderEvidence = {
      cursorTrack: [
        { sourceId: "capture", sourceTimeUs: 0, x: 40, y: 40, state: "default" as const },
        { sourceId: "capture", sourceTimeUs: 66_667, x: 110, y: 45, state: "pressed" as const },
      ],
      clickTrack: [{ sourceId: "capture", sourceTimeUs: 33_333, x: 80, y: 45 }],
    };
    const mp4 = await renderRecordingProject({
      project: { schemaVersion: 1, ...base, preview: { status: "not-requested" as const } },
      sources,
      assetRoot,
      assets: { pip: "pip.ppm", audio: "audio.wav", "audio-2": "audio.wav" },
      outputPath: join(root, "project.mp4"),
      ...renderEvidence,
    });
    const mp4Probe = await probeRenderedVideo(mp4.outputPath);
    expect(mp4Probe).toMatchObject({
      width: 1920,
      height: 1080,
      pixelFormat: "yuv420p",
      hasAudio: true,
    });
    expect(mp4.durationUs).toBeGreaterThan(100_000);
    expect(mp4.durationUs).toBeLessThan(110_000);
    expect(mp4Probe.durationSeconds).toBeLessThanOrEqual(mp4.durationUs / 1_000_000);
    const decodedArtifacts = await createFixtureArtifactPaths();
    try {
      await extractFixtureSampleFrames(mp4.outputPath, decodedArtifacts);
      const decoded = parsePpm(await readFile(decodedArtifacts.firstFramePath));
      const pipPixel = ppmPixelAt(decoded, 1600, 100);
      expect(pipPixel.r).toBeGreaterThan(pipPixel.g + 60);
      expect(hasRedPixelInRegion(decoded, 940, 145, 120, 60)).toBe(true);
      expect(ppmPixelAt(decoded, 0, 0).b).toBeGreaterThan(120);
      await extractPpm(mp4.outputPath, 0.034, decodedArtifacts.clickFramePath);
      const click = parsePpm(await readFile(decodedArtifacts.clickFramePath));
      expect(hasRedPixelInRegion(click, 700, 470, 320, 140)).toBe(true);
    } finally {
      await cleanupFixtureArtifacts(decodedArtifacts);
    }
    const gif = await renderRecordingProject({
      project: {
        schemaVersion: 1,
        ...base,
        output: { ...base.output, format: "gif" as const },
        audioTracks: [],
        preview: { status: "not-requested" as const },
      },
      sources,
      assetRoot,
      assets: { pip: "pip.ppm" },
      outputPath: join(root, "project.gif"),
      ...renderEvidence,
    });
    expect((await readFile(gif.outputPath)).subarray(0, 6).toString("ascii")).toMatch(
      /^GIF8[79]a$/u,
    );
    const mutedProject = validateRecordingProject({
      ...migrateV1RecordingProject({
        schemaVersion: 1,
        ...base,
        pipTracks: [],
        preview: { status: "not-requested" as const },
      }),
      presentationControls: {
        cursor: { emphasis: "none", trailDurationUs: 0 },
        frame: { fit: "contain", border: "none" },
        export: { audio: "mute", colorRange: "limited", metadata: "none" },
      },
    });
    const muted = await renderRecordingProject({
      project: mutedProject,
      sources,
      assetRoot,
      assets: {},
      outputPath: join(root, "project-muted.mp4"),
      ...renderEvidence,
    });
    expect(await probeRenderedVideo(muted.outputPath)).toMatchObject({
      hasAudio: false,
      colorRange: "tv",
    });
  }, 90_000);
  it("applies clip trims and speed regions before selecting the visible source frame", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "minimal",
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [
        {
          id: "trimmed",
          sourceId: "capture",
          startUs: 33_333,
          endUs: 100_000,
          speedRegions: [{ startUs: 33_333, endUs: 100_000, startRate: 2, endRate: 2 }],
        },
      ],
    });
    const frames = await composePresentationFrames({
      plan,
      sources: [
        {
          id: "capture",
          width: 160,
          height: 90,
          frames: [
            { tUs: 0, pixels: sourceFrame({ r: 220, g: 38, b: 38 }) },
            { tUs: 33_333, pixels: sourceFrame({ r: 22, g: 163, b: 74 }) },
            { tUs: 66_667, pixels: sourceFrame({ r: 37, g: 99, b: 235 }) },
          ],
        },
      ],
    });
    expect(frames).toHaveLength(1);
    const first = frames[0] as Buffer;
    const offset = (540 * 1920 + 400) * 3;
    expect(first[offset + 1]).toBeGreaterThan(first[offset] as number);
  });

  it("renders style, zoom, cursor, click effect, caption and annotation pixels into MP4 and GIF", async () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "studio",
      source: { width: 160, height: 90, fps: 30, durationUs: 100_000 },
      clips: [{ id: "clip-1", sourceId: "capture", startUs: 0, endUs: 100_000 }],
      cursorTrack: [
        { tUs: 0, x: 40, y: 40, state: "default" },
        { tUs: 66_667, x: 110, y: 45, state: "pressed" },
      ],
      clickTrack: [{ tUs: 66_667, x: 110, y: 45, button: 0 }],
      zoomRegions: [{ id: "zoom-1", tUs: 66_667, x: 110, y: 45, scale: 1.2 }],
      captions: [{ id: "caption-1", startUs: 0, endUs: 100_000, text: "Open" }],
      annotations: [
        { id: "note-1", startUs: 0, endUs: 100_000, kind: "label", text: "Review", x: 20, y: 20 },
      ],
    });
    const source: RasterSource = {
      id: "capture",
      width: 160,
      height: 90,
      frames: [
        { tUs: 0, pixels: sourceFrame({ r: 248, g: 250, b: 252 }) },
        { tUs: 66_667, pixels: sourceFrame({ r: 226, g: 232, b: 240 }) },
      ],
    };
    const frames = await composePresentationFrames({ plan, sources: [source] });
    expect(frames).toHaveLength(3);
    const clickFrame = frames[2] as Buffer;
    const outputWidth = plan.output.width;
    const captionOffset =
      ((plan.output.height - 42) * outputWidth + Math.round(outputWidth * 0.08)) * 3;
    expect(clickFrame[captionOffset]).toBe(255);
    const root = await mkdtemp(join(tmpdir(), "recordly-presentation-"));
    roots.push(root);
    const mp4 = join(root, "candidate.mp4");
    await encodePresentationFrames({
      frames,
      width: plan.output.width,
      height: plan.output.height,
      fps: plan.output.fps,
      format: "mp4",
      quality: "standard",
      durationUs: 100_000,
      outputPath: mp4,
    });
    const probe = await probeRenderedVideo(mp4);
    expect(probe).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 3,
      pixelFormat: "yuv420p",
      colorRange: "tv",
      hasAudio: false,
    });
    const artifacts = await createFixtureArtifactPaths();
    try {
      await extractFixtureSampleFrames(mp4, artifacts);
      const decoded = parsePpm(await readFile(artifacts.firstFramePath));
      expect(ppmPixelAt(decoded, 10, 10).b).toBeGreaterThan(30);
      expect(ppmPixelAt(decoded, 960, 540).b).toBeGreaterThan(150);
    } finally {
      await cleanupFixtureArtifacts(artifacts);
    }
    const gif = join(root, "candidate.gif");
    await encodePresentationFrames({
      frames,
      width: plan.output.width,
      height: plan.output.height,
      fps: plan.output.fps,
      format: "gif",
      quality: "standard",
      durationUs: 100_000,
      outputPath: gif,
    });
    expect((await stat(gif)).size).toBeGreaterThan(1000);
    expect((await readFile(gif)).subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/u);
  }, 90_000);
});
