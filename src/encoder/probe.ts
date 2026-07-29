import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  assertOwnedFixtureArtifactPaths,
  type FixtureArtifactPaths,
  fixtureVideoContract,
  resolveMediaExecutable,
} from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

type FfprobeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  nb_read_frames?: string;
};

type FfprobeOutput = {
  streams?: FfprobeStream[];
  format?: { duration?: string };
};

function parseRate(rate: string | undefined): number {
  if (rate === undefined) throw new Error("ffprobe did not report a frame rate");
  const [numeratorText, denominatorText] = rate.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error(`invalid frame rate returned by ffprobe: ${rate}`);
  }
  return numerator / denominator;
}

export type RenderedVideoProbe = {
  width: number;
  height: number;
  pixelFormat: string;
  fps: number;
  frameCount: number;
  durationSeconds: number;
  hasAudio: boolean;
};

export async function probeRenderedVideo(inputPath: string): Promise<RenderedVideoProbe> {
  const ffprobe = await resolveMediaExecutable("ffprobe");
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,width,height,pix_fmt,avg_frame_rate,nb_read_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    inputPath,
  ]);
  const inspected = JSON.parse(stdout) as FfprobeOutput;
  const video = inspected.streams?.find((stream) => stream.codec_type === "video");
  if (
    video === undefined ||
    video.width === undefined ||
    video.height === undefined ||
    video.pix_fmt === undefined
  ) {
    throw new Error("ffprobe did not find a video stream");
  }
  const durationSeconds = Number(inspected.format?.duration);
  const frameCount = Number(video.nb_read_frames);
  if (!Number.isFinite(durationSeconds) || !Number.isSafeInteger(frameCount)) {
    throw new Error("ffprobe did not report a finite duration and exact decoded frame count");
  }
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, ["-v", "error", "-i", inputPath, "-map", "0:v:0", "-f", "null", "-"]);
  return {
    width: video.width,
    height: video.height,
    pixelFormat: video.pix_fmt,
    fps: parseRate(video.avg_frame_rate),
    frameCount,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    hasAudio: inspected.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

async function extractPpmFrame(
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

export async function extractFixtureSampleFrames(
  inputPath: string,
  artifactPaths: FixtureArtifactPaths,
): Promise<void> {
  assertOwnedFixtureArtifactPaths(artifactPaths);
  await extractPpmFrame(inputPath, 0, artifactPaths.firstFramePath);
  await extractPpmFrame(inputPath, 0.5, artifactPaths.clickFramePath);
}

export function assertFixtureContract(probe: RenderedVideoProbe): void {
  if (
    probe.width !== fixtureVideoContract.width ||
    probe.height !== fixtureVideoContract.height ||
    probe.pixelFormat !== "yuv420p" ||
    probe.fps !== fixtureVideoContract.fps ||
    probe.frameCount !== fixtureVideoContract.frameCount ||
    probe.durationSeconds !== 1 ||
    probe.hasAudio
  ) {
    throw new Error(
      `rendered fixture does not meet its delivery contract: ${JSON.stringify(probe)}`,
    );
  }
}
