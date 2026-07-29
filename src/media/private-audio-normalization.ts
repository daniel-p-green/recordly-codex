import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { resolveMediaExecutable } from "../encoder/ffmpeg.js";
import type { ImportedMedia } from "./private-media-library.js";

const MAX_LIBRARY_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 2048;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const MAX_DURATION_SECONDS = 300;
const MAX_VIDEO_WIDTH = 3840;
const MAX_VIDEO_HEIGHT = 2160;
const MAX_VIDEO_FPS = 60;
const MAX_INPUT_CHANNELS = 8;
const MAX_INPUT_SAMPLE_RATE = 192_000;
const NORMALIZED_SAMPLE_RATE = 48_000;
const NORMALIZED_CHANNELS = 2;
const MAX_NORMALIZED_BYTES = 64 * 1024 * 1024;

// This key is part of the output identity. Any codec, rate, channel, or filter-policy change
// must bump its version so previous normalized outputs are never silently reused.
export const normalizedAudioRecipeKey = "recordly-codex-normalized-audio-v1";

export const privateAudioLimits = {
  maximumDurationSeconds: MAX_DURATION_SECONDS,
  maximumInputChannels: MAX_INPUT_CHANNELS,
  maximumInputSampleRate: MAX_INPUT_SAMPLE_RATE,
  maximumNormalizedBytes: MAX_NORMALIZED_BYTES,
  maximumToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
  toolTimeoutMs: TOOL_TIMEOUT_MS,
} as const;

export type MediaCommandRunner = (input: {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maximumOutputBytes: number;
}) => Promise<{ stdout: string; stderr: string }>;

type MediaToolName = "ffmpeg" | "ffprobe";

export type PrivateAudioToolchain = {
  resolveExecutable?: (name: MediaToolName) => Promise<string>;
  commandRunner?: MediaCommandRunner;
};

export type PrivateAudioProbe = {
  codec: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
};

export type NormalizedAudio = {
  audioId: string;
  sha256: string;
  byteLength: number;
  durationSeconds: number;
  sampleRate: 48000;
  channels: 2;
};

export type PrivateAudioNormalizer = {
  probe(input: { media: ImportedMedia }): Promise<PrivateAudioProbe>;
  normalize(input: { media: ImportedMedia; outputRoot: string }): Promise<NormalizedAudio>;
};

type AudioExtension = "m4a" | "mp3" | "wav";

type StoredMediaMetadata = {
  schemaVersion: 1;
  sha256: string;
  byteLength: number;
  extension: AudioExtension;
  mediaKind: "audio";
};

type StoredNormalizedAudio = NormalizedAudio & {
  schemaVersion: 1;
  inputSha256: string;
};

type FfprobeStream = {
  codec_type?: unknown;
  codec_name?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
};

type FfprobeOutput = {
  streams?: unknown;
  format?: { duration?: unknown; format_name?: unknown };
};

function fail(message: string): never {
  throw new RangeError(`private audio normalization: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !value.startsWith("/");
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function canonicalPrivateDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink() || !status.isDirectory() || !privateMode(status.mode)) {
    fail(`${label} must be a private non-symlink directory`);
  }
  return realpath(path);
}

async function canonicalPrivateChild(root: string, name: string, label: string): Promise<string> {
  const path = resolve(root, name);
  if (!contained(root, path)) fail(`${label} escaped its root`);
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink() || !status.isDirectory() || !privateMode(status.mode)) {
    fail(`${label} must be a private non-symlink directory`);
  }
  const resolved = await realpath(path);
  if (!contained(root, resolved)) fail(`${label} escaped its root`);
  return resolved;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validByteLength(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= maximum;
}

function audioExtension(value: unknown): value is AudioExtension {
  return value === "m4a" || value === "mp3" || value === "wav";
}

function expectedMediaId(sha256: string): string {
  return `media_${createHash("sha256").update("recordly-codex-media-id-v1\\0").update(sha256).digest("hex").slice(0, 32)}`;
}

function expectedAudioId(inputSha256: string): string {
  return `audio_${createHash("sha256").update(`${normalizedAudioRecipeKey}\\0`).update(inputSha256).digest("hex").slice(0, 32)}`;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validateReference(media: ImportedMedia): void {
  if (
    !validDigest(media.sha256) ||
    !validByteLength(media.byteLength, MAX_LIBRARY_OBJECT_BYTES) ||
    !audioExtension(media.extension) ||
    media.mediaKind !== "audio" ||
    media.mediaId !== expectedMediaId(media.sha256)
  ) {
    fail("media reference is invalid or is not audio");
  }
}

async function hashRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<{
  sha256: string;
  byteLength: number;
}> {
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink() || !status.isFile()) fail(`${label} is not a regular file`);
  if (status.size > maximumBytes) fail(`${label} exceeds the size limit`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail(`${label} could not be opened safely`),
  );
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maximumBytes) fail(`${label} exceeds the size limit`);
      digest.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: digest.digest("hex"), byteLength: offset };
  } finally {
    await handle.close();
  }
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_METADATA_BYTES) {
    fail(`${label} is unsafe`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail(`${label} could not be opened safely`),
  );
  try {
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail(`${label} was truncated`);
      offset += bytesRead;
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail(`${label} is invalid`);
  } finally {
    await handle.close();
  }
}

function readStoredMediaMetadata(value: unknown): StoredMediaMetadata {
  if (
    value === null ||
    typeof value !== "object" ||
    !hasExactKeys(value, ["schemaVersion", "sha256", "byteLength", "extension", "mediaKind"]) ||
    (value as Partial<StoredMediaMetadata>).schemaVersion !== 1 ||
    !validDigest((value as Partial<StoredMediaMetadata>).sha256) ||
    !validByteLength(
      (value as Partial<StoredMediaMetadata>).byteLength,
      MAX_LIBRARY_OBJECT_BYTES,
    ) ||
    !audioExtension((value as Partial<StoredMediaMetadata>).extension) ||
    (value as Partial<StoredMediaMetadata>).mediaKind !== "audio"
  ) {
    fail("media metadata is invalid");
  }
  return value as StoredMediaMetadata;
}

async function storedAudio(
  objectsRoot: string,
  media: ImportedMedia,
): Promise<{ objectPath: string; metadata: StoredMediaMetadata }> {
  validateReference(media);
  const objectPath = resolve(objectsRoot, media.sha256);
  const metadataPath = resolve(objectsRoot, `${media.sha256}.json`);
  if (!contained(objectsRoot, objectPath) || !contained(objectsRoot, metadataPath)) {
    fail("media reference escaped the library");
  }
  const object = await hashRegularFile(objectPath, MAX_LIBRARY_OBJECT_BYTES, "media object");
  const metadata = readStoredMediaMetadata(await readJsonFile(metadataPath, "media metadata"));
  if (
    object.sha256 !== media.sha256 ||
    object.byteLength !== media.byteLength ||
    metadata.sha256 !== media.sha256 ||
    metadata.byteLength !== media.byteLength ||
    metadata.extension !== media.extension ||
    metadata.mediaKind !== media.mediaKind
  ) {
    fail("media reference and stored metadata disagree");
  }
  return { objectPath, metadata };
}

function numberValue(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = numberValue(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) fail(`${label} is invalid`);
  return parsed;
}

function parseFrameRate(value: unknown): number {
  if (typeof value !== "string") fail("video frame rate is invalid");
  const [numeratorText, denominatorText, extra] = value.split("/");
  if (extra !== undefined || numeratorText === undefined || denominatorText === undefined) {
    fail("video frame rate is invalid");
  }
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    fail("video frame rate is invalid");
  }
  return numerator / denominator;
}

function assertExtensionMatchesProbe(
  extension: AudioExtension,
  probe: FfprobeOutput,
  codec: string,
): void {
  const names =
    typeof probe.format?.format_name === "string" ? probe.format.format_name.split(",") : [];
  const formatMatches =
    (extension === "wav" && names.includes("wav") && codec.startsWith("pcm_")) ||
    (extension === "mp3" && names.includes("mp3") && codec === "mp3") ||
    (extension === "m4a" && names.includes("m4a") && (codec === "aac" || codec === "alac"));
  if (!formatMatches) fail("media extension and decoded audio disagree");
}

function inspectProbe(value: unknown, extension: AudioExtension): PrivateAudioProbe {
  if (value === null || typeof value !== "object") fail("ffprobe output is invalid");
  const probe = value as FfprobeOutput;
  if (!Array.isArray(probe.streams) || probe.streams.length !== 1) {
    fail("media must contain exactly one audio stream");
  }
  const stream = probe.streams[0] as FfprobeStream | undefined;
  if (
    stream === undefined ||
    stream.codec_type !== "audio" ||
    typeof stream.codec_name !== "string"
  ) {
    const video = stream as FfprobeStream | undefined;
    if (video?.codec_type === "video") {
      const width = positiveInteger(video.width, "video width", MAX_VIDEO_WIDTH);
      const height = positiveInteger(video.height, "video height", MAX_VIDEO_HEIGHT);
      if (
        parseFrameRate(video.avg_frame_rate) > MAX_VIDEO_FPS ||
        width > MAX_VIDEO_WIDTH ||
        height > MAX_VIDEO_HEIGHT
      ) {
        fail("video stream exceeds media limits");
      }
    }
    fail("media must contain exactly one audio stream");
  }
  const sampleRate = positiveInteger(
    stream.sample_rate,
    "audio sample rate",
    MAX_INPUT_SAMPLE_RATE,
  );
  const channels = positiveInteger(stream.channels, "audio channels", MAX_INPUT_CHANNELS);
  const durationSeconds = numberValue(probe.format?.duration, "media duration");
  if (durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS)
    fail("media duration exceeds limits");
  if (stream.duration !== undefined) {
    const streamDuration = numberValue(stream.duration, "audio stream duration");
    if (Math.abs(streamDuration - durationSeconds) > 0.05) fail("audio stream duration disagrees");
  }
  assertExtensionMatchesProbe(extension, probe, stream.codec_name);
  return {
    codec: stream.codec_name,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    sampleRate,
    channels,
  };
}

function defaultCommandRunner(input: {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maximumOutputBytes: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      input.executable,
      [...input.args],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "" },
        maxBuffer: input.maximumOutputBytes,
        shell: false,
        timeout: input.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) rejectCommand(error);
        else resolveCommand({ stdout, stderr });
      },
    );
  });
}

async function runTool(
  toolchain: Required<PrivateAudioToolchain>,
  name: MediaToolName,
  args: readonly string[],
): Promise<string> {
  const executable = await toolchain
    .resolveExecutable(name)
    .catch(() => fail(`${name} is unavailable`));
  if (!isAbsolute(executable)) fail(`${name} executable is unsafe`);
  const output = await toolchain
    .commandRunner({
      executable,
      args,
      timeoutMs: TOOL_TIMEOUT_MS,
      maximumOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    })
    .catch(() => fail(`${name} failed or timed out`));
  if (
    Buffer.byteLength(output.stdout, "utf8") > MAX_TOOL_OUTPUT_BYTES ||
    Buffer.byteLength(output.stderr, "utf8") > MAX_TOOL_OUTPUT_BYTES
  ) {
    fail(`${name} output exceeds limits`);
  }
  return output.stdout;
}

async function probeAudioPath(
  toolchain: Required<PrivateAudioToolchain>,
  inputPath: string,
  extension: AudioExtension,
): Promise<PrivateAudioProbe> {
  const stdout = await runTool(toolchain, "ffprobe", [
    "-hide_banner",
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-show_entries",
    "stream=codec_type,codec_name,sample_rate,channels,duration,width,height,avg_frame_rate:format=duration,format_name",
    "-of",
    "json",
    inputPath,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    fail("ffprobe output is invalid");
  }
  return inspectProbe(parsed, extension);
}

async function writeMetadataTemporary(path: string, value: StoredNormalizedAudio): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizedMetadata(value: unknown): StoredNormalizedAudio {
  if (
    value === null ||
    typeof value !== "object" ||
    !hasExactKeys(value, [
      "schemaVersion",
      "inputSha256",
      "audioId",
      "sha256",
      "byteLength",
      "durationSeconds",
      "sampleRate",
      "channels",
    ]) ||
    (value as Partial<StoredNormalizedAudio>).schemaVersion !== 1 ||
    !validDigest((value as Partial<StoredNormalizedAudio>).inputSha256) ||
    typeof (value as Partial<StoredNormalizedAudio>).audioId !== "string" ||
    !validDigest((value as Partial<StoredNormalizedAudio>).sha256) ||
    !validByteLength((value as Partial<StoredNormalizedAudio>).byteLength, MAX_NORMALIZED_BYTES) ||
    typeof (value as Partial<StoredNormalizedAudio>).durationSeconds !== "number" ||
    (value as Partial<StoredNormalizedAudio>).sampleRate !== NORMALIZED_SAMPLE_RATE ||
    (value as Partial<StoredNormalizedAudio>).channels !== NORMALIZED_CHANNELS
  ) {
    fail("normalized audio metadata is invalid");
  }
  return value as StoredNormalizedAudio;
}

async function maybeNormalizedMetadata(path: string): Promise<StoredNormalizedAudio | undefined> {
  const status = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    fail("normalized audio metadata is unavailable");
  });
  if (status === undefined) return undefined;
  return normalizedMetadata(await readJsonFile(path, "normalized audio metadata"));
}

async function verifyNormalizedAudio(input: {
  toolchain: Required<PrivateAudioToolchain>;
  outputPath: string;
  metadataPath: string;
  inputSha256: string;
}): Promise<NormalizedAudio> {
  const metadata = await maybeNormalizedMetadata(input.metadataPath);
  if (metadata === undefined) fail("normalized audio metadata is unavailable");
  const expectedId = expectedAudioId(input.inputSha256);
  if (metadata.inputSha256 !== input.inputSha256 || metadata.audioId !== expectedId) {
    fail("normalized audio key mismatch");
  }
  const output = await hashRegularFile(
    input.outputPath,
    MAX_NORMALIZED_BYTES,
    "normalized audio output",
  );
  if (output.sha256 !== metadata.sha256 || output.byteLength !== metadata.byteLength) {
    fail("normalized audio metadata disagrees with output");
  }
  const probe = await probeAudioPath(input.toolchain, input.outputPath, "wav");
  if (
    probe.codec !== "pcm_s16le" ||
    probe.durationSeconds !== metadata.durationSeconds ||
    probe.sampleRate !== NORMALIZED_SAMPLE_RATE ||
    probe.channels !== NORMALIZED_CHANNELS
  ) {
    fail("normalized audio output does not meet the WAV contract");
  }
  return {
    audioId: metadata.audioId,
    sha256: metadata.sha256,
    byteLength: metadata.byteLength,
    durationSeconds: metadata.durationSeconds,
    sampleRate: NORMALIZED_SAMPLE_RATE,
    channels: NORMALIZED_CHANNELS,
  };
}

async function removePublishedOutput(input: {
  outputPath: string;
  expected: { sha256: string; byteLength: number };
}): Promise<void> {
  const output = await hashRegularFile(
    input.outputPath,
    MAX_NORMALIZED_BYTES,
    "normalized audio output",
  );
  if (output.sha256 !== input.expected.sha256 || output.byteLength !== input.expected.byteLength) {
    fail("normalized audio output changed before rollback");
  }
  await unlink(input.outputPath);
}

export async function createPrivateAudioNormalizer(input: {
  libraryRoot: string;
  toolchain?: PrivateAudioToolchain;
}): Promise<PrivateAudioNormalizer> {
  const libraryRoot = await canonicalPrivateDirectory(input.libraryRoot, "libraryRoot");
  const objectsRoot = await canonicalPrivateChild(libraryRoot, "objects", "library objects");
  const toolchain: Required<PrivateAudioToolchain> = {
    resolveExecutable: input.toolchain?.resolveExecutable ?? resolveMediaExecutable,
    commandRunner: input.toolchain?.commandRunner ?? defaultCommandRunner,
  };

  return {
    async probe({ media }): Promise<PrivateAudioProbe> {
      const stored = await storedAudio(objectsRoot, media);
      return probeAudioPath(toolchain, stored.objectPath, stored.metadata.extension);
    },

    async normalize({ media, outputRoot }): Promise<NormalizedAudio> {
      const stored = await storedAudio(objectsRoot, media);
      await probeAudioPath(toolchain, stored.objectPath, stored.metadata.extension);
      const root = await canonicalPrivateDirectory(outputRoot, "outputRoot");
      const audioId = expectedAudioId(media.sha256);
      const outputPath = resolve(root, `${audioId}.wav`);
      const metadataPath = resolve(root, `${audioId}.json`);
      if (!contained(root, outputPath) || !contained(root, metadataPath)) {
        fail("normalized audio output escaped its root");
      }
      const existing = await maybeNormalizedMetadata(metadataPath);
      if (existing !== undefined) {
        return verifyNormalizedAudio({
          toolchain,
          outputPath,
          metadataPath,
          inputSha256: media.sha256,
        });
      }

      const temporaryPath = resolve(root, `.normalize-${randomUUID()}.wav`);
      const metadataTemporaryPath = resolve(root, `.normalize-${randomUUID()}.json`);
      if (!contained(root, temporaryPath) || !contained(root, metadataTemporaryPath)) {
        fail("normalized audio temporary output escaped its root");
      }
      let outputPublished = false;
      let metadataPublished = false;
      let candidate: { sha256: string; byteLength: number } | undefined;
      try {
        await runTool(toolchain, "ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "file",
          "-i",
          stored.objectPath,
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-ac",
          String(NORMALIZED_CHANNELS),
          "-ar",
          String(NORMALIZED_SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          "-y",
          temporaryPath,
        ]);
        candidate = await hashRegularFile(
          temporaryPath,
          MAX_NORMALIZED_BYTES,
          "normalized audio output",
        );
        const normalizedProbe = await probeAudioPath(toolchain, temporaryPath, "wav");
        if (
          normalizedProbe.codec !== "pcm_s16le" ||
          normalizedProbe.sampleRate !== NORMALIZED_SAMPLE_RATE ||
          normalizedProbe.channels !== NORMALIZED_CHANNELS
        ) {
          fail("ffmpeg output does not meet the WAV contract");
        }
        const metadata: StoredNormalizedAudio = {
          schemaVersion: 1,
          inputSha256: media.sha256,
          audioId,
          sha256: candidate.sha256,
          byteLength: candidate.byteLength,
          durationSeconds: normalizedProbe.durationSeconds,
          sampleRate: NORMALIZED_SAMPLE_RATE,
          channels: NORMALIZED_CHANNELS,
        };
        await link(temporaryPath, outputPath);
        outputPublished = true;
        await unlink(temporaryPath);
        await writeMetadataTemporary(metadataTemporaryPath, metadata);
        await link(metadataTemporaryPath, metadataPath);
        metadataPublished = true;
        await unlink(metadataTemporaryPath);
      } catch {
        await unlink(temporaryPath).catch(() => undefined);
        await unlink(metadataTemporaryPath).catch(() => undefined);
        if (outputPublished && !metadataPublished && candidate !== undefined) {
          try {
            return await verifyNormalizedAudio({
              toolchain,
              outputPath,
              metadataPath,
              inputSha256: media.sha256,
            });
          } catch {
            await removePublishedOutput({ outputPath, expected: candidate });
          }
        } else if (!outputPublished) {
          const concurrent = await maybeNormalizedMetadata(metadataPath);
          if (concurrent !== undefined) {
            return verifyNormalizedAudio({
              toolchain,
              outputPath,
              metadataPath,
              inputSha256: media.sha256,
            });
          }
        }
        fail("normalized audio publication failed");
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
        await unlink(metadataTemporaryPath).catch(() => undefined);
      }
      return verifyNormalizedAudio({
        toolchain,
        outputPath,
        metadataPath,
        inputSha256: media.sha256,
      });
    },
  };
}
