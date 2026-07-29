import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { validateOutputParityFixtureManifest } from "../../scripts/validate-output-parity-fixtures.mjs";
import { resolveMediaExecutable } from "../../src/encoder/ffmpeg.js";
import { migrateV1RecordingProject, validateRecordingProject } from "../../src/project/index.js";
import { renderRecordingProject } from "../../src/render/project-renderer.js";
import { parsePpm, ppmPixelAt, type Rgb } from "../support/ppm.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const sourceWidth = 160;
const sourceHeight = 90;
const firstTrimStartUs = 200_000;
const clipSourceDurationUs = 1_000_000;
const speed = 1.25;
const crossfadeUs = 200_000;

type Probe = { width: number; height: number; fps: number; frameCount: number; durationMs: number };
type ParsedP3 = { width: number; height: number; pixels: Rgb[] };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parseP3(bytes: Buffer): ParsedP3 {
  const tokens = bytes
    .toString("ascii")
    .replace(/#[^\r\n]*/gu, "")
    .trim()
    .split(/\s+/u);
  if (tokens[0] !== "P3") throw new Error("output-parity source asset must be P3 PPM");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || tokens[3] !== "255")
    throw new Error("output-parity source asset header is invalid");
  const values = tokens.slice(4).map(Number);
  if (values.length !== width * height * 3 || values.some((value) => !Number.isInteger(value)))
    throw new Error("output-parity source asset pixels are invalid");
  const pixels: Rgb[] = [];
  for (let index = 0; index < values.length; index += 3) {
    pixels.push({
      r: values[index] as number,
      g: values[index + 1] as number,
      b: values[index + 2] as number,
    });
  }
  return { width, height, pixels };
}

function fill(color: Rgb): Buffer {
  const pixels = Buffer.alloc(sourceWidth * sourceHeight * 3);
  for (let offset = 0; offset < pixels.length; offset += 3)
    pixels.set([color.r, color.g, color.b], offset);
  return pixels;
}

function checkerPixels(checker: ParsedP3, variant: 0 | 1): Buffer {
  const pixels = Buffer.alloc(sourceWidth * sourceHeight * 3);
  for (let y = 0; y < sourceHeight; y += 1)
    for (let x = 0; x < sourceWidth; x += 1) {
      const sourceX = Math.floor((x * checker.width) / sourceWidth);
      const sourceY = Math.floor((y * checker.height) / sourceHeight);
      const index = sourceY * checker.width + ((sourceX + variant) % checker.width);
      const color = checker.pixels[index] as Rgb;
      pixels.set([color.r, color.g, color.b], (y * sourceWidth + x) * 3);
    }
  return pixels;
}

function checkerPixel(checker: ParsedP3, sourceX: number, sourceY: number, variant: 0 | 1): Rgb {
  const x = Math.min(sourceWidth - 1, Math.max(0, Math.floor(sourceX)));
  const y = Math.min(sourceHeight - 1, Math.max(0, Math.floor(sourceY)));
  const checkerX = Math.floor((x * checker.width) / sourceWidth);
  const checkerY = Math.floor((y * checker.height) / sourceHeight);
  return checker.pixels[checkerY * checker.width + ((checkerX + variant) % checker.width)] as Rgb;
}

function captureOneFrame(checker: ParsedP3, sourceTimeUs: number): Buffer {
  // These clean-room time bands make trim and speed separately observable:
  // untrimmed opening is blue, correctly trimmed opening is red, and an
  // unsped 500 ms output sample stays green while the 1.25x sample reaches
  // the checker pattern.
  if (sourceTimeUs < firstTrimStartUs) return fill({ r: 37, g: 99, b: 235 });
  if (sourceTimeUs < 500_000) return fill({ r: 235, g: 63, b: 63 });
  if (sourceTimeUs < 800_000) return fill({ r: 34, g: 197, b: 94 });
  return checkerPixels(checker, 1);
}

function captureTwoFrame(): Buffer {
  return fill({ r: 37, g: 99, b: 235 });
}

function outputPoint(
  width: number,
  height: number,
  sourceX: number,
  sourceY: number,
  zoomScale: number,
): { x: number; y: number } {
  const padding = 30;
  const contentMaxWidth = Math.max(2, width - padding * 2);
  const contentMaxHeight = Math.max(2, height - padding * 2);
  const scale = Math.min(contentMaxWidth / sourceWidth, contentMaxHeight / sourceHeight);
  const contentWidth = Math.max(2, Math.floor(sourceWidth * scale));
  const contentHeight = Math.max(2, Math.floor(sourceHeight * scale));
  const contentX = Math.floor((width - contentWidth) / 2);
  const contentY = Math.floor((height - contentHeight) / 2);
  const focusX = sourceWidth * 0.25;
  const focusY = sourceHeight * 0.14;
  return {
    x: Math.floor(contentX + (focusX + (sourceX - focusX) * zoomScale) * scale),
    y: Math.floor(contentY + (focusY + (sourceY - focusY) * zoomScale) * scale),
  };
}

function hasColorInRegion(
  image: ReturnType<typeof parsePpm>,
  center: { x: number; y: number },
  radius: number,
  predicate: (pixel: Rgb) => boolean,
): boolean {
  const left = Math.max(0, center.x - radius);
  const right = Math.min(image.width - 1, center.x + radius);
  const top = Math.max(0, center.y - radius);
  const bottom = Math.min(image.height - 1, center.y + radius);
  for (let y = top; y <= bottom; y += 1)
    for (let x = left; x <= right; x += 1) if (predicate(ppmPixelAt(image, x, y))) return true;
  return false;
}

function expectCloseColor(actual: Rgb, expected: Rgb, tolerance: number): void {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance);
}

async function probe(path: string): Promise<Probe> {
  const ffprobe = await resolveMediaExecutable("ffprobe");
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_read_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    path,
  ]);
  const inspected = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      nb_read_frames?: string;
    }>;
    format?: { duration?: string };
  };
  const video = inspected.streams?.find((stream) => stream.codec_type === "video");
  const rateParts = (video?.r_frame_rate ?? "").split("/").map(Number);
  const numerator = rateParts[0];
  const denominator = rateParts[1];
  const fps =
    numerator === undefined || denominator === undefined ? Number.NaN : numerator / denominator;
  const frameCount = Number(video?.nb_read_frames);
  const durationMs = Number(inspected.format?.duration) * 1000;
  if (
    video?.width === undefined ||
    video.height === undefined ||
    !Number.isFinite(fps) ||
    !Number.isSafeInteger(frameCount) ||
    !Number.isFinite(durationMs)
  ) {
    throw new Error("ffprobe did not return exact decoded video facts");
  }
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-f", "null", "-"]);
  return { width: video.width, height: video.height, fps, frameCount, durationMs };
}

async function decodeFrame(path: string, frameIndex: number, destination: string) {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    path,
    "-vf",
    `select=eq(n\\,${frameIndex})`,
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-vcodec",
    "ppm",
    "-y",
    destination,
  ]);
  return parsePpm(await readFile(destination));
}

function fixtureProject(input: {
  id: string;
  profile: "landscape-1080p" | "square-1080" | "vertical-1080";
  width: 1920 | 1080;
  height: 1920 | 1080;
  format: "mp4" | "gif";
  preview: { status: "ready" | "rendered"; revision: number };
}) {
  const v1 = {
    schemaVersion: 1 as const,
    projectId: input.id,
    revision: 1,
    revisionPolicy: { automatedRevisionLimit: 2, automatedRevisionCount: 0 },
    captureSources: [
      {
        id: "capture-one",
        sessionId: "fixture-session-one",
        manifestSha256: "a".repeat(64),
        timelineSha256: "b".repeat(64),
        frameSetSha256: "c".repeat(64),
        sourceWidth,
        sourceHeight,
        durationUs: 1_200_000,
      },
      {
        id: "capture-two",
        sessionId: "fixture-session-two",
        manifestSha256: "d".repeat(64),
        timelineSha256: "e".repeat(64),
        frameSetSha256: "f".repeat(64),
        sourceWidth,
        sourceHeight,
        durationUs: 1_200_000,
      },
    ],
    output: {
      profile: input.profile,
      width: input.width,
      height: input.height,
      fps: 30 as const,
      format: input.format,
      quality: "draft" as const,
    },
    timeline: {
      clips: [
        {
          id: "first",
          sourceId: "capture-one",
          trim: { startUs: firstTrimStartUs, endUs: firstTrimStartUs + clipSourceDurationUs },
          speedRegions: [
            {
              startUs: firstTrimStartUs,
              endUs: firstTrimStartUs + clipSourceDurationUs,
              startRate: speed,
              endRate: speed,
            },
          ],
          zoomRegions: [],
          transitionAfter: { kind: "crossfade" as const, durationUs: crossfadeUs },
        },
        {
          id: "second",
          sourceId: "capture-two",
          trim: { startUs: 0, endUs: clipSourceDurationUs },
          speedRegions: [
            { startUs: 0, endUs: clipSourceDurationUs, startRate: speed, endRate: speed },
          ],
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
        motion: "source" as const,
        clickEffect: "ripple" as const,
      },
      frame: {
        background: { kind: "solid" as const, color: "#0f172a" },
        paddingPx: 30,
        radiusPx: 12,
        shadow: "none" as const,
      },
    },
    overlays: {
      captions: [
        {
          id: "caption",
          clipId: "first",
          timeDomain: "clip-source-relative" as const,
          startUs: 300_000,
          endUs: 900_000,
          text: {
            value: "CAPTION",
            provenance: "authored" as const,
            exportDisposition: "allow" as const,
          },
        },
      ],
      annotations: [
        {
          id: "annotation",
          clipId: "first",
          timeDomain: "clip-source-relative" as const,
          startUs: 300_000,
          endUs: 900_000,
          text: {
            value: "NOTE",
            provenance: "authored" as const,
            exportDisposition: "allow" as const,
          },
          position: "top" as const,
          style: "emphasis" as const,
        },
      ],
    },
    audioTracks: [],
    pipTracks: [],
    renderHooks: [],
    preview: input.preview,
  };
  const migrated = migrateV1RecordingProject(v1);
  return validateRecordingProject({
    ...migrated,
    output: v1.output,
    preview: input.preview,
    timelineTransitions: [
      { clipId: "first", family: "crossfade", durationUs: crossfadeUs, easing: "linear" },
      { clipId: "second", family: "cut", durationUs: 0, easing: "linear" },
    ],
    zoomProposals: [
      {
        id: "reviewed-zoom",
        clipId: "first",
        sourceRange: { startUs: firstTrimStartUs, endUs: firstTrimStartUs + clipSourceDurationUs },
        focus: { x: 0.25, y: 0.14 },
        scale: 2,
        easing: "linear",
        review: { status: "accepted", basis: "observed-input" },
      },
    ],
  });
}

describe("output-parity v1 executable acceptance", () => {
  it("renders and decodes every declared profile and format for both preview and final of one revision", async () => {
    await Promise.all([resolveMediaExecutable("ffmpeg"), resolveMediaExecutable("ffprobe")]);
    const manifest = await validateOutputParityFixtureManifest();
    const asset = manifest.assets[0];
    if (asset === undefined) throw new Error("output-parity manifest has no source asset");
    const checker = parseP3(
      await readFile(join(repositoryRoot, "fixtures/output-parity-v1", asset.path)),
    );

    for (const fixture of manifest.fixtures) {
      const root = await mkdtemp(join(tmpdir(), `recordly-output-parity-${fixture.id}-`));
      roots.push(root);
      const decoded = new Map<
        string,
        {
          opening: ReturnType<typeof parsePpm>;
          effect: ReturnType<typeof parsePpm>;
          final: ReturnType<typeof parsePpm>;
        }
      >();
      for (const mode of ["preview", "final"] as const) {
        const project = fixtureProject({
          id: fixture.id,
          profile: fixture.profile,
          width: fixture.output.width as 1920 | 1080,
          height: fixture.output.height as 1920 | 1080,
          format: fixture.output.format,
          preview:
            mode === "preview"
              ? { status: "rendered", revision: 1 }
              : { status: "ready", revision: 1 },
        });
        const outputPath = join(root, `${mode}.${fixture.output.format}`);
        const rendered = await renderRecordingProject({
          project,
          sources: [
            {
              id: "capture-one",
              width: sourceWidth,
              height: sourceHeight,
              frameAt: (tUs) => ({ tUs, pixels: captureOneFrame(checker, tUs) }),
            },
            {
              id: "capture-two",
              width: sourceWidth,
              height: sourceHeight,
              frameAt: (tUs) => ({ tUs, pixels: captureTwoFrame() }),
            },
          ],
          assetRoot: root,
          assets: {},
          outputPath,
          cursorTrack: [
            { sourceId: "capture-one", sourceTimeUs: 825_000, x: 100, y: 45, state: "pressed" },
          ],
          clickTrack: [{ sourceId: "capture-one", sourceTimeUs: 825_000, x: 100, y: 45 }],
        });
        const inspected = await probe(rendered.outputPath);
        expect(inspected.width).toBe(fixture.output.width);
        expect(inspected.height).toBe(fixture.output.height);
        expect(inspected.fps).toBeCloseTo(fixture.output.fps, 4);
        expect(
          Math.abs(inspected.durationMs - manifest.renderAcceptance.durationMs),
        ).toBeLessThanOrEqual(manifest.renderAcceptance.durationToleranceMs);
        expect(
          Math.abs(rendered.durationUs / 1000 - manifest.renderAcceptance.durationMs),
        ).toBeLessThanOrEqual(1);
        expect(rendered.frameCount).toBeGreaterThanOrEqual(
          Math.floor((manifest.renderAcceptance.durationMs * fixture.output.fps) / 1000) - 1,
        );

        const checkpoints = Object.fromEntries(
          await Promise.all(
            fixture.decodedCheckpoints.map(async (checkpoint) => {
              const frameIndex = Math.round((checkpoint.atOutputMs * inspected.fps) / 1000);
              expect(
                Math.abs((frameIndex * 1000) / inspected.fps - checkpoint.atOutputMs),
              ).toBeLessThanOrEqual(manifest.renderAcceptance.checkpointToleranceMs);
              return [
                checkpoint.kind,
                await decodeFrame(
                  rendered.outputPath,
                  frameIndex,
                  join(root, `${mode}-${checkpoint.kind}.ppm`),
                ),
              ] as const;
            }),
          ),
        ) as {
          opening: ReturnType<typeof parsePpm>;
          effect: ReturnType<typeof parsePpm>;
          final: ReturnType<typeof parsePpm>;
        };
        decoded.set(mode, checkpoints);

        const openingCenter = ppmPixelAt(
          checkpoints.opening,
          Math.floor(fixture.output.width / 2),
          Math.floor(fixture.output.height / 2),
        );
        expect(openingCenter.r).toBeGreaterThan(
          openingCenter.b + manifest.renderAcceptance.codec.minimumDominance,
        );
        const frameCorner = ppmPixelAt(checkpoints.opening, 2, 2);
        expect(frameCorner.r).toBeLessThan(90);
        expect(frameCorner.g).toBeLessThan(90);
        expect(frameCorner.b).toBeLessThan(100);

        const effectSourceTimeUs = firstTrimStartUs + Math.round(500_000 * speed);
        expect(effectSourceTimeUs).toBe(825_000);
        const zoomScale = 1 + (effectSourceTimeUs - firstTrimStartUs) / clipSourceDurationUs;
        const zoomProbe = outputPoint(
          fixture.output.width,
          fixture.output.height,
          90,
          40,
          zoomScale,
        );
        expectCloseColor(
          ppmPixelAt(checkpoints.effect, zoomProbe.x, zoomProbe.y),
          checkerPixel(checker, 90, 40, 1),
          manifest.renderAcceptance.codec.channelTolerance,
        );

        const pointer = outputPoint(
          fixture.output.width,
          fixture.output.height,
          100,
          45,
          zoomScale,
        );
        expect(
          hasColorInRegion(
            checkpoints.effect,
            pointer,
            38,
            (pixel) =>
              pixel.r > pixel.g + manifest.renderAcceptance.codec.minimumDominance &&
              pixel.r > pixel.b + 35,
          ),
        ).toBe(true);
        expect(
          hasColorInRegion(
            checkpoints.effect,
            pointer,
            34,
            (pixel) => pixel.r > 225 && pixel.g > 225 && pixel.b > 225,
          ),
        ).toBe(true);
        const annotation = outputPoint(
          fixture.output.width,
          fixture.output.height,
          80,
          sourceHeight * 0.14,
          zoomScale,
        );
        expect(
          hasColorInRegion(
            checkpoints.effect,
            annotation,
            30,
            (pixel) => pixel.r > pixel.g + manifest.renderAcceptance.codec.minimumDominance,
          ),
        ).toBe(true);
        expect(
          hasColorInRegion(
            checkpoints.effect,
            { x: Math.round(fixture.output.width * 0.08), y: fixture.output.height - 38 },
            50,
            (pixel) => pixel.r > 225 && pixel.g > 225 && pixel.b > 225,
          ),
        ).toBe(true);

        const finalCenter = ppmPixelAt(
          checkpoints.final,
          Math.floor(fixture.output.width / 2),
          Math.floor(fixture.output.height / 2),
        );
        expect(finalCenter.b).toBeGreaterThan(
          finalCenter.r + manifest.renderAcceptance.codec.minimumDominance,
        );
      }

      const preview = decoded.get("preview");
      const final = decoded.get("final");
      if (preview === undefined || final === undefined)
        throw new Error("preview/final render is missing");
      for (const checkpoint of ["opening", "effect", "final"] as const) {
        const previewCenter = ppmPixelAt(
          preview[checkpoint],
          Math.floor(fixture.output.width / 2),
          Math.floor(fixture.output.height / 2),
        );
        const finalCenter = ppmPixelAt(
          final[checkpoint],
          Math.floor(fixture.output.width / 2),
          Math.floor(fixture.output.height / 2),
        );
        expectCloseColor(
          previewCenter,
          finalCenter,
          manifest.renderAcceptance.codec.channelTolerance,
        );
      }
    }
  }, 600_000);
});
