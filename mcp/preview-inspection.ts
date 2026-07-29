import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveMediaExecutable } from "../src/encoder/ffmpeg.js";
import { copyPrivateArtifact, readPrivateArtifact } from "./private-artifact.js";

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_BYTES = 512 * 1024 * 1024;
const MAX_CONTACT_SHEET_BYTES = 1_500_000;
const WATCHDOG_MS = 15_000;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;

type FfprobeOutput = {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    color_range?: string;
    avg_frame_rate?: string;
    nb_read_frames?: string;
  }>;
  format?: { duration?: string };
};

export type PreviewInspectionEvidence = {
  projectId: string;
  revision: number;
  projectSha256: string;
  previewArtifactSha256: string;
  previewByteLength: number;
  technicalQa: {
    decodeStatus: "passed";
    width: number;
    height: number;
    fps: number;
    frameCount: number;
    durationUs: number;
    pixelFormat: string;
    colorRange: string;
    hasAudio: boolean;
  };
  contactSheet: {
    sha256: string;
    byteLength: number;
    width: number;
    height: number;
    timestampsUs: readonly number[];
  };
};

export type PreviewInspection = {
  evidence: PreviewInspectionEvidence;
  image: { data: string; mimeType: "image/png" };
};

function parseRate(rate: string | undefined): number {
  const [numeratorText, denominatorText] = (rate ?? "").split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    throw new RangeError("preview ffprobe returned an invalid frame rate");
  }
  const value = numerator / denominator;
  if (!Number.isFinite(value) || value <= 0 || value > 240) {
    throw new RangeError("preview ffprobe frame rate exceeds inspection limits");
  }
  return value;
}

function representativeTimestamps(durationSeconds: number, fps: number): [number, number, number] {
  const last = Math.max(0, durationSeconds - 1 / fps);
  return [0, Math.round((durationSeconds / 2) * 1_000_000), Math.round(last * 1_000_000)];
}

async function bounded(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  const result = await execFileAsync(command, args, {
    timeout: WATCHDOG_MS,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    windowsHide: true,
  });
  return { stdout: result.stdout };
}

/** Decodes a bounded current preview copy into a contact sheet; never returns a video path or bytes. */
export async function inspectPrivatePreview(input: {
  artifactRoot: string;
  relativePath: string;
  projectId: string;
  revision: number;
  projectSha256: string;
  expectedPreviewArtifactSha256?: string;
}): Promise<PreviewInspection> {
  const staging = await mkdtemp(join(input.artifactRoot, ".preview-inspection-"));
  await chmod(staging, 0o700);
  const copiedPreview = join(staging, "preview.mp4");
  const contactSheet = join(staging, "contact-sheet.png");
  try {
    const copied = await copyPrivateArtifact({
      root: input.artifactRoot,
      relativePath: input.relativePath,
      maximumBytes: MAX_PREVIEW_BYTES,
      ...(input.expectedPreviewArtifactSha256 === undefined
        ? {}
        : { expectedSha256: input.expectedPreviewArtifactSha256 }),
      destinationPath: copiedPreview,
    });
    const ffprobe = await resolveMediaExecutable("ffprobe");
    const { stdout } = await bounded(ffprobe, [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_type,width,height,pix_fmt,color_range,avg_frame_rate,nb_read_frames",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      copiedPreview,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const durationSeconds = Number(parsed.format?.duration);
    const frameCount = Number(video?.nb_read_frames);
    const fps = parseRate(video?.avg_frame_rate);
    if (
      video?.width === undefined ||
      video.height === undefined ||
      video.pix_fmt === undefined ||
      video.color_range === undefined ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 300 ||
      !Number.isSafeInteger(frameCount) ||
      frameCount < 1 ||
      video.width < 2 ||
      video.height < 2
    ) {
      throw new RangeError("preview is outside bounded inspection contract");
    }
    const ffmpeg = await resolveMediaExecutable("ffmpeg");
    await bounded(ffmpeg, ["-v", "error", "-i", copiedPreview, "-map", "0:v:0", "-f", "null", "-"]);
    const timestampsUs = representativeTimestamps(durationSeconds, fps);
    const scaleHeight = Math.max(2, Math.round((320 * video.height) / video.width / 2) * 2);
    await bounded(ffmpeg, [
      "-v",
      "error",
      "-ss",
      (timestampsUs[0] / 1_000_000).toFixed(6),
      "-i",
      copiedPreview,
      "-ss",
      (timestampsUs[1] / 1_000_000).toFixed(6),
      "-i",
      copiedPreview,
      "-ss",
      (timestampsUs[2] / 1_000_000).toFixed(6),
      "-i",
      copiedPreview,
      "-filter_complex",
      "[0:v]scale=320:-2[a];[1:v]scale=320:-2[b];[2:v]scale=320:-2[c];[a][b][c]hstack=inputs=3",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "png",
      "-y",
      contactSheet,
    ]);
    await chmod(contactSheet, 0o600);
    const image = await readPrivateArtifact({
      root: staging,
      relativePath: "contact-sheet.png",
      maximumBytes: MAX_CONTACT_SHEET_BYTES,
    });
    return {
      evidence: {
        projectId: input.projectId,
        revision: input.revision,
        projectSha256: input.projectSha256,
        previewArtifactSha256: copied.sha256,
        previewByteLength: copied.byteLength,
        technicalQa: {
          decodeStatus: "passed",
          width: video.width,
          height: video.height,
          fps: Number(fps.toFixed(6)),
          frameCount,
          durationUs: Math.round(durationSeconds * 1_000_000),
          pixelFormat: video.pix_fmt,
          colorRange: video.color_range,
          hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
        },
        contactSheet: {
          sha256: image.sha256,
          byteLength: image.byteLength,
          width: 960,
          height: scaleHeight,
          timestampsUs,
        },
      },
      image: { data: image.bytes.toString("base64"), mimeType: "image/png" },
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
