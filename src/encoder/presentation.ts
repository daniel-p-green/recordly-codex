import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { resolveMediaExecutable } from "./ffmpeg.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_SOURCE_TIME_US = 24 * 60 * 60 * 1_000_000;

export function encodingQualityProfile(quality: "draft" | "standard" | "high"): {
  x264Preset: "veryfast" | "medium" | "slow";
  x264Crf: 28 | 23 | 18;
  gifColors: 128 | 192 | 256;
} {
  if (quality === "draft") return { x264Preset: "veryfast", x264Crf: 28, gifColors: 128 };
  if (quality === "standard") return { x264Preset: "medium", x264Crf: 23, gifColors: 192 };
  if (quality === "high") return { x264Preset: "slow", x264Crf: 18, gifColors: 256 };
  throw new RangeError("presentation quality is unsupported");
}

export type PresentationAudioTrack = {
  path: string;
  startUs: number;
  trim: { startUs: number; endUs: number };
  gainDb: number;
};

export function assertAudioTracksBounded(
  tracks: readonly PresentationAudioTrack[],
  durationUs: number,
): void {
  for (const track of tracks) {
    if (
      !Number.isSafeInteger(track.startUs) ||
      track.startUs < 0 ||
      !Number.isSafeInteger(track.trim.startUs) ||
      !Number.isSafeInteger(track.trim.endUs) ||
      track.trim.startUs < 0 ||
      track.trim.endUs <= track.trim.startUs ||
      track.trim.endUs > MAX_AUDIO_SOURCE_TIME_US ||
      track.startUs >= durationUs ||
      track.trim.endUs - track.trim.startUs > durationUs - track.startUs ||
      !Number.isFinite(track.gainDb)
    ) {
      throw new RangeError("presentation audio timing is invalid");
    }
  }
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = (): void => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !value.startsWith("/");
}

/**
 * Copies one opened, bounded source file into an exclusive private snapshot
 * while hashing the exact bytes copied. Consumers must use only the returned
 * snapshot path and keep its staging root private until cleanup.
 */
export async function stageVerifiedMediaAsset(input: {
  assetRoot: string;
  relativePath: string;
  sha256: string;
  mediaKind: "audio-wav" | "pip-ppm";
  maximumBytes: number;
  stagingRoot: string;
  stagingName: string;
}): Promise<string> {
  if (
    !/^[0-9a-f]{64}$/u.test(input.sha256) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 12 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.stagingName)
  ) {
    throw new RangeError("asset verification bounds are invalid");
  }
  const root = await realpath(input.assetRoot);
  const stagingRoot = await realpath(input.stagingRoot);
  const candidate = resolve(root, input.relativePath);
  if (!contained(root, candidate)) throw new RangeError("asset path escapes its root");
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink())
    throw new RangeError("asset must be a regular non-symlink file");
  const resolved = await realpath(candidate);
  if (!contained(root, resolved)) throw new RangeError("asset path escapes its root");
  const stagedPath = resolve(stagingRoot, input.stagingName);
  if (!contained(stagingRoot, stagedPath))
    throw new RangeError("asset staging path escapes its root");
  const source = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const opened = await source.stat();
    if (!opened.isFile() || opened.size > input.maximumBytes) {
      throw new RangeError("asset size exceeds its media byte cap");
    }
    destination = await open(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const digest = createHash("sha256");
    const signature = Buffer.alloc(12);
    const buffer = Buffer.alloc(Math.min(64 * 1024, input.maximumBytes + 1));
    let streamedBytes = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, streamedBytes);
      if (bytesRead === 0) break;
      streamedBytes += bytesRead;
      if (streamedBytes > input.maximumBytes)
        throw new RangeError("asset size exceeds its media byte cap");
      const bytes = buffer.subarray(0, bytesRead);
      const sourceOffset = streamedBytes - bytesRead;
      if (sourceOffset < signature.length) {
        bytes.copy(
          signature,
          sourceOffset,
          0,
          Math.min(bytesRead, signature.length - sourceOffset),
        );
      }
      digest.update(bytes);
      let written = 0;
      while (written < bytes.length) {
        const result = await destination.write(bytes, written, bytes.length - written);
        written += result.bytesWritten;
      }
    }
    const recognized =
      input.mediaKind === "pip-ppm"
        ? streamedBytes >= 3 &&
          signature[0] === 0x50 &&
          signature[1] === 0x36 &&
          /\s/u.test(String.fromCharCode(signature[2] as number))
        : streamedBytes >= 12 &&
          signature.subarray(0, 4).toString("ascii") === "RIFF" &&
          signature.subarray(8, 12).toString("ascii") === "WAVE";
    if (!recognized) throw new RangeError("asset type does not match its declared media use");
    if (digest.digest("hex") !== input.sha256) throw new RangeError("asset digest does not match");
    await destination.sync();
    await destination.close();
    destination = undefined;
    return stagedPath;
  } catch (error) {
    if (destination !== undefined) await destination.close().catch(() => undefined);
    await unlink(stagedPath).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
  }
}

/** Encodes compositor-owned RGB24 frames to MP4 or palette-based GIF. */
export async function encodePresentationFrames(input: {
  /** Frames are consumed once and streamed to ffmpeg; render output is never accumulated. */
  frames: Iterable<Buffer> | AsyncIterable<Buffer>;
  width: number;
  height: number;
  fps: number;
  format: "mp4" | "gif";
  quality: "draft" | "standard" | "high";
  durationUs: number;
  outputPath: string;
  audioTracks?: readonly PresentationAudioTrack[];
}): Promise<void> {
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    !Number.isFinite(input.fps) ||
    input.width < 2 ||
    input.height < 2 ||
    input.fps < 1 ||
    input.fps > 60 ||
    !Number.isSafeInteger(input.durationUs) ||
    input.durationUs < 1
  ) {
    throw new RangeError("presentation encoder input is invalid");
  }
  const frameBytes = input.width * input.height * 3;
  if (!Number.isSafeInteger(frameBytes) || frameBytes > MAX_FRAME_BYTES) {
    throw new RangeError("presentation output pixel bytes exceed the encoder cap");
  }
  const quality = encodingQualityProfile(input.quality);
  const maximumFrames = Math.ceil((input.durationUs * input.fps) / 1_000_000);
  const audioTracks = input.audioTracks ?? [];
  assertAudioTracksBounded(audioTracks, input.durationUs);
  if (input.format === "gif" && audioTracks.length > 0)
    throw new RangeError("GIF delivery cannot represent project audio");
  await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    `${input.width}x${input.height}`,
    "-framerate",
    String(input.fps),
    "-i",
    "pipe:0",
  ];
  for (const track of audioTracks) {
    args.push(
      "-ss",
      (track.trim.startUs / 1_000_000).toFixed(6),
      "-t",
      ((track.trim.endUs - track.trim.startUs) / 1_000_000).toFixed(6),
      "-i",
      track.path,
    );
  }
  if (input.format === "mp4") {
    const audioFilter =
      audioTracks.length === 0
        ? []
        : (() => {
            const filters = audioTracks.map(
              (track, index) =>
                `[${index + 1}:a]asetpts=PTS-STARTPTS,volume=${track.gainDb}dB,adelay=${Math.round(track.startUs / 1000)}:all=1[a${index}]`,
            );
            const inputs = audioTracks.map((_track, index) => `[a${index}]`).join("");
            return [
              "-filter_complex",
              `${filters.join(";")};${inputs}amix=inputs=${audioTracks.length}:normalize=0[a]`,
              "-map",
              "0:v:0",
              "-map",
              "[a]",
            ];
          })();
    args.push(
      ...audioFilter,
      ...(audioTracks.length === 0 ? ["-an"] : []),
      "-vf",
      "format=yuv420p,setrange=limited",
      "-c:v",
      "libx264",
      "-preset",
      quality.x264Preset,
      "-crf",
      String(quality.x264Crf),
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-bsf:v",
      "h264_metadata=video_full_range_flag=0",
      "-movflags",
      "+faststart",
      "-t",
      (input.durationUs / 1_000_000).toFixed(6),
      "-y",
      input.outputPath,
    );
  } else {
    args.push(
      "-filter_complex",
      `[0:v]fps=${input.fps},split[a][b];[a]palettegen=max_colors=${quality.gifColors}:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`,
      "-loop",
      "0",
      "-t",
      (input.durationUs / 1_000_000).toFixed(6),
      "-y",
      input.outputPath,
    );
  }
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`presentation encoder exited with code ${code}: ${stderr.trim()}`));
    });
  });
  let frameCount = 0;
  try {
    for await (const frame of input.frames) {
      if (frame.length !== frameBytes)
        throw new RangeError("presentation frames must be packed RGB24 buffers");
      if (frameCount >= maximumFrames)
        throw new RangeError("presentation frame stream exceeds assembled duration");
      if (!child.stdin.write(frame)) await waitForDrain(child.stdin);
      frameCount += 1;
    }
    if (frameCount === 0) throw new RangeError("presentation encoder requires at least one frame");
    child.stdin.end();
    await finished;
  } catch (error) {
    child.stdin.destroy();
    child.kill("SIGTERM");
    await finished.catch(() => undefined);
    throw error;
  }
}
