import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isContainedPath } from "../safe/path.js";

import { resolveMediaExecutable } from "./ffmpeg.js";
import { MEDIA_PROCESS_POLICY, runMediaProcess } from "./media-process.js";

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
  id?: string;
  role?: "primary" | "bed" | "effect";
  pan?: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  ducking?: "none" | "against-primary";
};

export const PRESENTATION_DUCKING = {
  threshold: 0.125,
  ratio: 8,
  attackMs: 20,
  releaseMs: 250,
} as const;
const PRESENTATION_LIMITER_CEILING = 0.6;

/** V1 recipe contract: retain this exact gain/delay/amix graph for legacy projects. */
export function compileLegacyPresentationAudioFilter(
  tracks: readonly Pick<PresentationAudioTrack, "gainDb" | "startUs">[],
): string {
  const filters = tracks.map(
    (track, index) =>
      `[${index + 1}:a]asetpts=PTS-STARTPTS,volume=${track.gainDb}dB,adelay=${Math.round(track.startUs / 1000)}:all=1[a${index}]`,
  );
  const inputs = tracks.map((_track, index) => `[a${index}]`).join("");
  return `${filters.join(";")};${inputs}amix=inputs=${tracks.length}:normalize=0[a]`;
}

function audioSeconds(valueUs: number): string {
  return (valueUs / 1_000_000).toFixed(6);
}

function equalPowerPan(pan: number): { left: string; right: string } {
  const angle = ((pan + 1) * Math.PI) / 4;
  return { left: Math.cos(angle).toFixed(6), right: Math.sin(angle).toFixed(6) };
}

function usesProfessionalMix(track: PresentationAudioTrack): boolean {
  return (
    track.role !== undefined ||
    track.pan !== undefined ||
    track.fadeInUs !== undefined ||
    track.fadeOutUs !== undefined ||
    track.ducking !== undefined
  );
}

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
  const professional = tracks.some(usesProfessionalMix);
  if (!professional) return;
  for (const track of tracks) {
    if (
      track.role === undefined ||
      track.pan === undefined ||
      track.fadeInUs === undefined ||
      track.fadeOutUs === undefined ||
      track.ducking === undefined ||
      !Number.isFinite(track.pan) ||
      track.pan < -1 ||
      track.pan > 1 ||
      !Number.isSafeInteger(track.fadeInUs) ||
      !Number.isSafeInteger(track.fadeOutUs) ||
      track.fadeInUs < 0 ||
      track.fadeOutUs < 0 ||
      track.fadeInUs + track.fadeOutUs > track.trim.endUs - track.trim.startUs
    ) {
      throw new RangeError("presentation professional audio mix is invalid");
    }
  }
  if (
    tracks.some((track) => track.ducking === "against-primary") &&
    !tracks.some((track) => track.role === "primary")
  ) {
    throw new RangeError("presentation ducking requires a primary track");
  }
}

/** Compiles the V2 deterministic audio mix without interpolating source paths into FFmpeg syntax. */
export function compileProfessionalAudioFilter(tracks: readonly PresentationAudioTrack[]): string {
  assertAudioTracksBounded(tracks, Number.MAX_SAFE_INTEGER);
  if (tracks.length === 0 || !tracks.every(usesProfessionalMix)) {
    throw new RangeError("presentation professional audio mix requires complete track controls");
  }
  const ducked = tracks.some((track) => track.ducking === "against-primary");
  const primaryIndexes = tracks.flatMap((track, index) =>
    track.role === "primary" ? [index] : [],
  );
  if (ducked && primaryIndexes.length === 0)
    throw new RangeError("presentation ducking requires a primary track");

  const filters: string[] = [];
  const outputLabels: string[] = [];
  for (const [index, track] of tracks.entries()) {
    const pan = equalPowerPan(track.pan as number);
    const trimDurationUs = track.trim.endUs - track.trim.startUs;
    const transforms = [
      "asetpts=PTS-STARTPTS",
      "aformat=sample_rates=48000:channel_layouts=stereo",
      `volume=${track.gainDb}dB`,
      `pan=stereo|c0=${pan.left}*c0|c1=${pan.right}*c1`,
    ];
    if ((track.fadeInUs as number) > 0)
      transforms.push(`afade=t=in:st=0:d=${audioSeconds(track.fadeInUs as number)}`);
    if ((track.fadeOutUs as number) > 0) {
      transforms.push(
        `afade=t=out:st=${audioSeconds(trimDurationUs - (track.fadeOutUs as number))}:d=${audioSeconds(track.fadeOutUs as number)}`,
      );
    }
    transforms.push(
      `adelay=${Math.round(track.startUs / 1000)}:all=1`,
      `apad=whole_dur=${audioSeconds(track.startUs + trimDurationUs)}`,
      "asetnsamples=n=1024:p=1",
    );
    if (ducked && track.role === "primary") {
      filters.push(`[${index + 1}:a]${transforms.join(",")},asplit=2[p${index}mix][p${index}out]`);
      outputLabels.push(`[p${index}out]`);
    } else {
      filters.push(`[${index + 1}:a]${transforms.join(",")}[t${index}]`);
      outputLabels.push(track.ducking === "against-primary" ? `[d${index}]` : `[t${index}]`);
    }
  }
  if (ducked) {
    const primaryInputs = primaryIndexes.map((index) => `[p${index}mix]`).join("");
    filters.push(
      primaryIndexes.length === 1
        ? `${primaryInputs}anull[primary]`
        : `${primaryInputs}amix=inputs=${primaryIndexes.length}:normalize=0[primary]`,
    );
    const duckedIndexes = tracks.flatMap((track, index) =>
      track.ducking === "against-primary" ? [index] : [],
    );
    filters.push(
      `[primary]asplit=${duckedIndexes.length}${duckedIndexes.map((index) => `[side${index}]`).join("")}`,
    );
    for (const index of duckedIndexes) {
      const track = tracks[index];
      if (track === undefined) throw new Error("professional audio track is unavailable");
      if (track.ducking === "against-primary") {
        filters.push(
          `[t${index}][side${index}]sidechaincompress=threshold=${PRESENTATION_DUCKING.threshold}:ratio=${PRESENTATION_DUCKING.ratio}:attack=${PRESENTATION_DUCKING.attackMs}:release=${PRESENTATION_DUCKING.releaseMs}[d${index}]`,
        );
      }
    }
  }
  filters.push(
    `${outputLabels.join("")}amix=inputs=${tracks.length}:normalize=0,alimiter=limit=${PRESENTATION_LIMITER_CEILING}:level=disabled:latency=enabled,aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp[a]`,
  );
  return filters.join(";");
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
  if (!isContainedPath(root, candidate)) throw new RangeError("asset path escapes its root");
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink())
    throw new RangeError("asset must be a regular non-symlink file");
  const resolved = await realpath(candidate);
  if (!isContainedPath(root, resolved)) throw new RangeError("asset path escapes its root");
  const stagedPath = resolve(stagingRoot, input.stagingName);
  if (!isContainedPath(stagingRoot, stagedPath))
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
  /** V2-only explicit export choices. Omitted preserves the legacy V1 recipe. */
  colorRange?: "limited";
  metadata?: "none" | "minimal";
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
  if (input.colorRange !== undefined && input.colorRange !== "limited")
    throw new RangeError("presentation color range must be limited");
  if (input.metadata !== undefined && input.metadata !== "none" && input.metadata !== "minimal")
    throw new RangeError("presentation metadata mode is invalid");
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
      audioSeconds(track.trim.startUs),
      "-t",
      audioSeconds(track.trim.endUs - track.trim.startUs),
      "-i",
      track.path,
    );
  }
  const metadataArgs =
    input.metadata === undefined
      ? []
      : [
          "-map_metadata",
          "-1",
          ...(input.metadata === "minimal"
            ? ["-metadata", "title=Recordly recording", "-metadata", "comment=Generated locally"]
            : []),
        ];
  if (input.format === "mp4") {
    const professionalAudio = audioTracks.some(usesProfessionalMix);
    const audioFilter =
      audioTracks.length === 0
        ? []
        : professionalAudio
          ? [
              "-filter_complex",
              compileProfessionalAudioFilter(audioTracks),
              "-map",
              "0:v:0",
              "-map",
              "[a]",
            ]
          : (() => {
              return [
                "-filter_complex",
                compileLegacyPresentationAudioFilter(audioTracks),
                "-map",
                "0:v:0",
                "-map",
                "[a]",
              ];
            })();
    args.push(
      ...audioFilter,
      ...(audioTracks.length === 0 ? ["-an"] : []),
      ...(professionalAudio ? ["-c:a", "aac", "-ar", "48000", "-ac", "2"] : []),
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
      ...metadataArgs,
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
      ...metadataArgs,
      "-t",
      (input.durationUs / 1_000_000).toFixed(6),
      "-y",
      input.outputPath,
    );
  }
  let frameCount = 0;
  await runMediaProcess({
    executable: ffmpeg,
    args,
    label: "presentation encoder",
    timeoutMs: MEDIA_PROCESS_POLICY.presentationEncodeDeadlineMs,
    writeInput: async (stdin) => {
      for await (const frame of input.frames) {
        if (frame.length !== frameBytes)
          throw new RangeError("presentation frames must be packed RGB24 buffers");
        if (frameCount >= maximumFrames)
          throw new RangeError("presentation frame stream exceeds assembled duration");
        if (!stdin.write(frame)) await waitForDrain(stdin);
        frameCount += 1;
      }
      if (frameCount === 0)
        throw new RangeError("presentation encoder requires at least one frame");
    },
  });
}
