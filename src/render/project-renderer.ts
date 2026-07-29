import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAudioTracksBounded,
  encodePresentationFrames,
  stageVerifiedMediaAsset,
} from "../encoder/presentation.js";
import {
  type RecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "../project/index.js";
import {
  buildCompositionPlanFromProject,
  type SourceClickSample,
  type SourceCursorSample,
} from "./composition.js";
import {
  type LazyRasterSource,
  type RasterSource,
  streamPresentationFrames,
} from "./raster-compositor.js";
import { assembledPresentationDurationUs } from "./timeline-mapping.js";

const MAX_SOURCE_PIXEL_AREA = 4096 * 2160;
const MAX_PIP_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_ASSET_BYTES = 256 * 1024 * 1024;

export function assertRasterSourceBounded(source: { width: number; height: number }): void {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 2 ||
    source.height < 2 ||
    source.width * source.height > MAX_SOURCE_PIXEL_AREA
  ) {
    throw new RangeError("raster source geometry exceeds renderer pixel bounds");
  }
}

/** Explicit, path-free mapping from project asset IDs to contained asset-root paths. */
export type ProjectRenderAssets = Readonly<Record<string, string>>;

/** Stable bounded renderer input. Source pixels are supplied lazily, never as a capture-wide frame array. */
export type RecordingProjectRenderInput = {
  project: RecordingProject;
  sources: readonly LazyRasterSource[];
  assetRoot: string;
  assets: ProjectRenderAssets;
  outputPath: string;
  cursorTrack?: readonly SourceCursorSample[];
  clickTrack?: readonly SourceClickSample[];
};

export type RecordingProjectRenderResult = {
  outputPath: string;
  frameCount: number;
  durationUs: number;
};

function parsePpm(value: Buffer): { width: number; height: number; pixels: Buffer } {
  const first = value.indexOf(0x0a);
  const second = value.indexOf(0x0a, first + 1);
  const third = value.indexOf(0x0a, second + 1);
  if (first < 0 || second < 0 || third < 0 || value.subarray(0, first).toString("ascii") !== "P6")
    throw new RangeError("PiP asset must be a binary PPM image");
  const [widthText, heightText] = value
    .subarray(first + 1, second)
    .toString("ascii")
    .trim()
    .split(/\s+/u);
  const width = Number(widthText);
  const height = Number(heightText);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 4096 ||
    height > 4096 ||
    value
      .subarray(second + 1, third)
      .toString("ascii")
      .trim() !== "255"
  )
    throw new RangeError("PiP PPM geometry is invalid");
  const pixels = value.subarray(third + 1);
  if (pixels.length !== width * height * 3) throw new RangeError("PiP PPM payload is invalid");
  return { width, height, pixels };
}

/**
 * Renders a validated, path-free project with only SHA-verified local media.
 * Capture rasters are supplied by the sealed-capture reader, never persisted in
 * the project. This function streams output frames directly to the encoder.
 */
export async function renderRecordingProject(
  input: RecordingProjectRenderInput,
): Promise<RecordingProjectRenderResult> {
  const project = validateRecordingProject(input.project);
  const plan = buildCompositionPlanFromProject(toProjectRenderInput(project), {
    ...(input.cursorTrack === undefined ? {} : { cursorTrack: input.cursorTrack }),
    ...(input.clickTrack === undefined ? {} : { clickTrack: input.clickTrack }),
  });
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  if (
    sourceById.size !== input.sources.length ||
    input.sources.length !== project.captureSources.length
  )
    throw new RangeError("project capture source identifiers must be unique");
  for (const capture of project.captureSources) {
    const source = sourceById.get(capture.id);
    if (source === undefined) throw new RangeError("project capture source is unavailable");
    assertRasterSourceBounded(source);
    if (source.width !== capture.sourceWidth || source.height !== capture.sourceHeight) {
      throw new RangeError("project capture source geometry exceeds renderer pixel bounds");
    }
  }
  if (project.output.format === "gif" && project.audioTracks.length > 0)
    throw new RangeError("GIF delivery cannot represent project audio");
  const durationUs = Math.round(assembledPresentationDurationUs(plan));
  assertAudioTracksBounded(
    project.audioTracks.map((track) => ({
      path: "",
      startUs: track.startUs,
      trim: track.trim,
      gainDb: track.gainDb,
    })),
    durationUs,
  );

  const stagingRoot = await mkdtemp(join(tmpdir(), "recordly-render-assets-"));
  try {
    await chmod(stagingRoot, 0o700);
    const resolvedPiP: RasterSource[] = [];
    for (const [index, track] of project.pipTracks.entries()) {
      const relativePath = input.assets[track.asset.assetId];
      if (relativePath === undefined) throw new RangeError("PiP asset mapping is unavailable");
      const path = await stageVerifiedMediaAsset({
        assetRoot: input.assetRoot,
        relativePath,
        sha256: track.asset.sha256,
        mediaKind: "pip-ppm",
        maximumBytes: MAX_PIP_ASSET_BYTES,
        stagingRoot,
        stagingName: `pip-${index}.ppm`,
      });
      const decoded = parsePpm(await readFile(path));
      assertRasterSourceBounded(decoded);
      resolvedPiP.push({
        id: track.asset.assetId,
        width: decoded.width,
        height: decoded.height,
        frames: [{ tUs: 0, pixels: decoded.pixels }],
      });
    }
    const audioTracks = await Promise.all(
      project.audioTracks.map(async (track, index) => {
        const relativePath = input.assets[track.asset.assetId];
        if (relativePath === undefined) throw new RangeError("audio asset mapping is unavailable");
        return {
          path: await stageVerifiedMediaAsset({
            assetRoot: input.assetRoot,
            relativePath,
            sha256: track.asset.sha256,
            mediaKind: "audio-wav",
            maximumBytes: MAX_AUDIO_ASSET_BYTES,
            stagingRoot,
            stagingName: `audio-${index}.wav`,
          }),
          startUs: track.startUs,
          trim: track.trim,
          gainDb: track.gainDb,
        };
      }),
    );
    let frameCount = 0;
    async function* counted(): AsyncGenerator<Buffer> {
      for await (const frame of streamPresentationFrames({
        plan,
        sources: [...input.sources, ...resolvedPiP],
      })) {
        frameCount += 1;
        yield frame;
      }
    }
    await encodePresentationFrames({
      frames: counted(),
      width: plan.output.width,
      height: plan.output.height,
      fps: plan.output.fps,
      format: plan.output.format,
      quality: plan.output.quality,
      durationUs,
      outputPath: input.outputPath,
      audioTracks,
    });
    return { outputPath: input.outputPath, frameCount, durationUs };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
