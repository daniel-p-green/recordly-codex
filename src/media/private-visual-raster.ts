import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resolveMediaExecutable } from "../encoder/ffmpeg.js";
import type { LazyRasterSource, RasterFrame } from "../render/raster-compositor.js";
import { isContainedPath } from "../safe/path.js";
import type { ImportedMedia } from "./private-media-library.js";

const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 2048;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const MAX_DURATION_SECONDS = 300;
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 2160;
const MAX_FPS = 60;
const MAX_FRAMES = 18_000;
const MAX_DECODER_STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_RGB_FRAME_BYTES = MAX_WIDTH * MAX_HEIGHT * 3;

type VisualExtension = "gif" | "jpg" | "png" | "ppm" | "webp" | "mov" | "mp4" | "webm";
type VisualKind = "image" | "video";

/** A path-free handle to an object already owned by the private media library. */
export type PrivateVisualMediaReference = Pick<
  ImportedMedia,
  "mediaId" | "sha256" | "extension" | "mediaKind"
>;

/** Decoded facts, derived only from the private object rather than MCP input. */
export type InspectedVisualMedia = PrivateVisualMediaReference & {
  mediaKind: VisualKind;
  extension: VisualExtension;
  width: number;
  height: number;
  durationUs: number;
  fps?: number;
};

export type RegisteredVisualMedia = {
  mediaKind: VisualKind;
  extension: VisualExtension;
  width: number;
  height: number;
  fps?: number;
  durationSeconds?: number;
};

export type PrivateVisualRasterHandle = {
  source: LazyRasterSource;
  dispose(): Promise<void>;
  decoderSpawnCount(): number;
};

export type PrivateVisualRasterAdapter = {
  inspect(input: { media: PrivateVisualMediaReference }): Promise<InspectedVisualMedia>;
  open(input: {
    media: PrivateVisualMediaReference;
    expected: RegisteredVisualMedia;
  }): Promise<PrivateVisualRasterHandle>;
};

type StoredMetadata = {
  schemaVersion: 1;
  sha256: string;
  byteLength: number;
  extension: VisualExtension;
  mediaKind: VisualKind;
};

type ProbeStream = {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  duration?: unknown;
};

type ProbeOutput = { streams?: unknown; format?: { duration?: unknown; format_name?: unknown } };

export type RgbFrameAssemblyMetrics = {
  bytesCopied: number;
  framesCompleted: number;
  maximumPendingBytes: number;
  pendingBytes: number;
};

/**
 * Copies stream chunks directly into one frame allocation and retains only a
 * bounded remainder. This avoids repeatedly copying a growing Buffer.concat
 * accumulator while keeping enough bytes for the next RGB24 frame.
 */
export class BoundedRgbFrameAssembler {
  readonly #frameBytes: number;
  readonly #maximumChunkBytes: number;
  #pending: Array<{ chunk: Buffer; offset: number }> = [];
  #pendingBytes = 0;
  #maximumPendingBytes = 0;
  #current: Buffer | undefined;
  #currentOffset = 0;
  #bytesCopied = 0;
  #framesCompleted = 0;

  constructor(input: { frameBytes: number; maximumChunkBytes: number }) {
    if (
      !Number.isSafeInteger(input.frameBytes) ||
      input.frameBytes < 1 ||
      input.frameBytes > MAX_RGB_FRAME_BYTES ||
      !Number.isSafeInteger(input.maximumChunkBytes) ||
      input.maximumChunkBytes < 1 ||
      input.maximumChunkBytes > MAX_DECODER_STREAM_CHUNK_BYTES
    ) {
      throw new RangeError("private visual raster: RGB frame stream limits are invalid");
    }
    this.#frameBytes = input.frameBytes;
    this.#maximumChunkBytes = input.maximumChunkBytes;
  }

  get metrics(): RgbFrameAssemblyMetrics {
    return {
      bytesCopied: this.#bytesCopied,
      framesCompleted: this.#framesCompleted,
      maximumPendingBytes: this.#maximumPendingBytes,
      pendingBytes: this.#pendingBytes,
    };
  }

  push(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk) || chunk.length > this.#maximumChunkBytes) {
      throw new RangeError("private visual raster: decoder stream chunk exceeds limits");
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#current !== undefined && this.#currentOffset === this.#frameBytes) {
        this.#queue(chunk, offset);
        return;
      }
      if (this.#current === undefined) this.#current = Buffer.allocUnsafe(this.#frameBytes);
      const available = this.#frameBytes - this.#currentOffset;
      const copied = Math.min(available, chunk.length - offset);
      chunk.copy(this.#current, this.#currentOffset, offset, offset + copied);
      this.#currentOffset += copied;
      this.#bytesCopied += copied;
      offset += copied;
    }
  }

  take(): Buffer | undefined {
    while (true) {
      if (this.#current !== undefined && this.#currentOffset === this.#frameBytes) {
        const frame = this.#current;
        this.#current = undefined;
        this.#currentOffset = 0;
        this.#framesCompleted += 1;
        return frame;
      }
      const pending = this.#pending[0];
      if (pending === undefined) return undefined;
      if (this.#current === undefined) this.#current = Buffer.allocUnsafe(this.#frameBytes);
      const available = this.#frameBytes - this.#currentOffset;
      const copied = Math.min(available, pending.chunk.length - pending.offset);
      pending.chunk.copy(
        this.#current,
        this.#currentOffset,
        pending.offset,
        pending.offset + copied,
      );
      this.#currentOffset += copied;
      this.#bytesCopied += copied;
      pending.offset += copied;
      this.#pendingBytes -= copied;
      if (pending.offset === pending.chunk.length) this.#pending.shift();
    }
  }

  #queue(chunk: Buffer, offset: number): void {
    const remainder = chunk.subarray(offset);
    if (this.#pendingBytes + remainder.length > this.#maximumChunkBytes) {
      throw new RangeError("private visual raster: decoder stream remainder exceeds limits");
    }
    this.#pending.push({ chunk: remainder, offset: 0 });
    this.#pendingBytes += remainder.length;
    this.#maximumPendingBytes = Math.max(this.#maximumPendingBytes, this.#pendingBytes);
  }
}

function fail(message: string): never {
  throw new RangeError(`private visual raster: ${message}`);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function visualExtension(value: unknown): value is VisualExtension {
  return ["gif", "jpg", "png", "ppm", "webp", "mov", "mp4", "webm"].includes(value as string);
}

function visualKind(value: unknown): value is VisualKind {
  return value === "image" || value === "video";
}

function mediaId(sha256: string): string {
  return `media_${createHash("sha256").update("recordly-codex-media-id-v1\\0").update(sha256).digest("hex").slice(0, 32)}`;
}

async function privateDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink() || !status.isDirectory() || !privateMode(status.mode)) {
    fail(`${label} must be a private non-symlink directory`);
  }
  return realpath(path);
}

async function privateChild(root: string, name: string): Promise<string> {
  const path = resolve(root, name);
  if (!isContainedPath(root, path)) fail("library objects escaped the root");
  const status = await lstat(path).catch(() => fail("library objects are unavailable"));
  if (status.isSymbolicLink() || !status.isDirectory() || !privateMode(status.mode)) {
    fail("library objects must be a private non-symlink directory");
  }
  const resolved = await realpath(path);
  if (!isContainedPath(root, resolved)) fail("library objects escaped the root");
  return resolved;
}

async function hashFile(
  path: string,
  maximum: number,
  label: string,
): Promise<{ sha256: string; byteLength: number }> {
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink() || !status.isFile()) fail(`${label} is not a regular file`);
  if (status.size > maximum) fail(`${label} exceeds size limits`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail(`${label} is unsafe`),
  );
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maximum) fail(`${label} exceeds size limits`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: hash.digest("hex"), byteLength: offset };
  } finally {
    await handle.close();
  }
}

async function readMetadata(path: string): Promise<StoredMetadata> {
  const status = await lstat(path).catch(() => fail("media metadata is unavailable"));
  if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_METADATA_BYTES)
    fail("media metadata is unsafe");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail("media metadata is unsafe"),
  );
  try {
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail("media metadata was truncated");
      offset += bytesRead;
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      !exactKeys(value, ["schemaVersion", "sha256", "byteLength", "extension", "mediaKind"]) ||
      (value as Partial<StoredMetadata>).schemaVersion !== 1 ||
      !digest((value as Partial<StoredMetadata>).sha256) ||
      !Number.isSafeInteger((value as Partial<StoredMetadata>).byteLength) ||
      !visualExtension((value as Partial<StoredMetadata>).extension) ||
      !visualKind((value as Partial<StoredMetadata>).mediaKind)
    )
      fail("media metadata is invalid");
    return value as StoredMetadata;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    fail("media metadata is invalid");
  } finally {
    await handle.close();
  }
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    fail(`${label} exceeds limits`);
  return number;
}

function rate(value: unknown): number {
  if (typeof value !== "string") fail("video frame rate is invalid");
  const [numeratorText, denominatorText, extra] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (
    extra !== undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    fail("video frame rate is invalid");
  const result = numerator / denominator;
  if (result <= 0 || result > MAX_FPS) fail("video frame rate exceeds limits");
  return result;
}

function duration(value: unknown, requirePositive: boolean): number {
  if (value === undefined && !requirePositive) return 0;
  const result =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (
    !Number.isFinite(result) ||
    result < 0 ||
    (requirePositive && result <= 0) ||
    result > MAX_DURATION_SECONDS
  )
    fail("media duration exceeds limits");
  return Number(result.toFixed(6));
}

function extensionMatches(
  extension: VisualExtension,
  kind: VisualKind,
  codec: string,
  formatName: unknown,
): boolean {
  const formats = typeof formatName === "string" ? formatName.split(",") : [];
  if (kind === "image") {
    return (
      (extension === "png" && codec === "png") ||
      (extension === "ppm" && codec === "ppm") ||
      (extension === "jpg" && codec === "mjpeg") ||
      (extension === "gif" && codec === "gif") ||
      (extension === "webp" && codec === "webp")
    );
  }
  return (
    ((extension === "mp4" || extension === "mov") &&
      formats.some((name) => name === "mov" || name === "mp4")) ||
    (extension === "webm" && formats.includes("webm"))
  );
}

async function probe(path: string): Promise<{
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  codec: string;
  formatName: unknown;
}> {
  const ffprobe = await resolveMediaExecutable("ffprobe").catch(() =>
    fail("ffprobe is unavailable"),
  );
  const result = await new Promise<{ stdout: string }>((resolveResult, rejectResult) => {
    execFile(
      ffprobe,
      [
        "-hide_banner",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate,duration:format=duration,format_name",
        "-of",
        "json",
        path,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "" },
        maxBuffer: MAX_TOOL_OUTPUT_BYTES,
        shell: false,
        timeout: TOOL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) rejectResult(error);
        else resolveResult({ stdout });
      },
    );
  }).catch(() => fail("ffprobe failed or timed out"));
  let value: ProbeOutput;
  try {
    value = JSON.parse(result.stdout) as ProbeOutput;
  } catch {
    fail("ffprobe output is invalid");
  }
  if (!Array.isArray(value.streams) || value.streams.length !== 1)
    fail("media must contain exactly one visual stream");
  const stream = value.streams[0] as ProbeStream | undefined;
  if (stream?.codec_type !== "video" || typeof stream.codec_name !== "string")
    fail("media must contain exactly one visual stream");
  return {
    width: positiveInteger(stream.width, "media width", MAX_WIDTH),
    height: positiveInteger(stream.height, "media height", MAX_HEIGHT),
    fps: rate(stream.avg_frame_rate),
    durationSeconds: duration(value.format?.duration ?? stream.duration, false),
    codec: stream.codec_name,
    formatName: value.format?.format_name,
  };
}

type ClosableVisualChild = Pick<
  ReturnType<typeof spawn>,
  "exitCode" | "killed" | "kill" | "once" | "stdout" | "stderr"
>;

export function closePrivateVisualChild(child: ClosableVisualChild): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  child.stdout?.destroy();
  child.stderr?.destroy();
  let settled = false;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolveClose, rejectClose) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (error === undefined) resolveClose();
      else rejectClose(error);
    };
    child.once("close", () => finish());
    if (!child.killed) child.kill("SIGTERM");
    termTimer = setTimeout(() => {
      if (child.exitCode !== null) return finish();
      child.kill("SIGKILL");
      killTimer = setTimeout(
        () => finish(new Error("private visual raster: decoder did not close after SIGKILL")),
        250,
      );
    }, 250);
  });
}

function createDecoder(input: { path: string; width: number; height: number; still: boolean }): {
  read(): Promise<Buffer>;
  dispose(): Promise<void>;
} {
  const frameBytes = input.width * input.height * 3;
  let child: ReturnType<typeof spawn> | undefined;
  let iterator: AsyncIterator<Buffer> | undefined;
  let assembler = new BoundedRgbFrameAssembler({
    frameBytes,
    maximumChunkBytes: MAX_DECODER_STREAM_CHUNK_BYTES,
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  function resetWatchdog(): void {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => child?.kill("SIGTERM"), TOOL_TIMEOUT_MS);
  }
  async function start(): Promise<void> {
    const ffmpeg = await resolveMediaExecutable("ffmpeg").catch(() =>
      fail("ffmpeg is unavailable"),
    );
    const spawned = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file",
        "-i",
        input.path,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-pix_fmt",
        "rgb24",
        ...(input.still ? ["-frames:v", "1"] : []),
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { env: { LANG: "C", LC_ALL: "C", PATH: "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (spawned.stdout === null || spawned.stderr === null) fail("ffmpeg streams are unavailable");
    child = spawned;
    let stderrBytes = 0;
    spawned.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_TOOL_OUTPUT_BYTES) spawned.kill("SIGTERM");
    });
    spawned.stdout.on("data", resetWatchdog);
    resetWatchdog();
    iterator = spawned.stdout[Symbol.asyncIterator]();
  }
  async function disposeDecoder(): Promise<void> {
    if (watchdog !== undefined) clearTimeout(watchdog);
    if (child !== undefined) await closePrivateVisualChild(child);
    child = undefined;
    iterator = undefined;
    assembler = new BoundedRgbFrameAssembler({
      frameBytes,
      maximumChunkBytes: MAX_DECODER_STREAM_CHUNK_BYTES,
    });
  }
  return {
    async read(): Promise<Buffer> {
      try {
        if (child === undefined || iterator === undefined) await start();
        while (true) {
          const frame = assembler.take();
          if (frame !== undefined) return frame;
          const next = await (iterator as AsyncIterator<Buffer>).next();
          if (next.done) fail("ffmpeg output was truncated or timed out");
          assembler.push(next.value);
        }
      } catch (error) {
        await disposeDecoder();
        throw error;
      }
    },
    dispose: disposeDecoder,
  };
}

export async function createPrivateVisualRasterAdapter(input: {
  libraryRoot: string;
}): Promise<PrivateVisualRasterAdapter> {
  const libraryRoot = await privateDirectory(input.libraryRoot, "libraryRoot");
  const objectsRoot = await privateChild(libraryRoot, "objects");
  async function inspect(media: PrivateVisualMediaReference): Promise<{
    inspected: InspectedVisualMedia;
    objectPath: string;
    verifyStoredEvidence(): Promise<void>;
  }> {
    if (media === null || typeof media !== "object") fail("media reference is invalid");
    if (
      !digest(media.sha256) ||
      media.mediaId !== mediaId(media.sha256) ||
      !visualExtension(media.extension) ||
      !visualKind(media.mediaKind)
    ) {
      fail("media reference is invalid");
    }
    const objectPath = resolve(objectsRoot, media.sha256);
    const metadataPath = resolve(objectsRoot, `${media.sha256}.json`);
    if (!isContainedPath(objectsRoot, objectPath) || !isContainedPath(objectsRoot, metadataPath)) {
      fail("media reference escaped library");
    }
    async function verifyStoredEvidence(): Promise<void> {
      const object = await hashFile(objectPath, MAX_OBJECT_BYTES, "media object");
      const metadata = await readMetadata(metadataPath);
      if (
        object.sha256 !== media.sha256 ||
        metadata.sha256 !== media.sha256 ||
        object.byteLength !== metadata.byteLength ||
        metadata.extension !== media.extension ||
        metadata.mediaKind !== media.mediaKind
      ) {
        fail("media reference and metadata disagree");
      }
    }
    await verifyStoredEvidence();
    const decoded = await probe(objectPath);
    if (!extensionMatches(media.extension, media.mediaKind, decoded.codec, decoded.formatName)) {
      fail("media reference and decoded content disagree");
    }
    if (media.mediaKind === "video") {
      if (decoded.durationSeconds <= 0 || decoded.fps * decoded.durationSeconds > MAX_FRAMES) {
        fail("video duration exceeds limits");
      }
      return {
        objectPath,
        verifyStoredEvidence,
        inspected: {
          mediaId: media.mediaId,
          sha256: media.sha256,
          mediaKind: media.mediaKind,
          extension: media.extension,
          width: decoded.width,
          height: decoded.height,
          durationUs: Math.round(decoded.durationSeconds * 1_000_000),
          fps: decoded.fps,
        },
      };
    }
    return {
      objectPath,
      verifyStoredEvidence,
      inspected: {
        mediaId: media.mediaId,
        sha256: media.sha256,
        mediaKind: media.mediaKind,
        extension: media.extension,
        width: decoded.width,
        height: decoded.height,
        durationUs: 1,
      },
    };
  }
  return {
    async inspect({ media }): Promise<InspectedVisualMedia> {
      return (await inspect(media)).inspected;
    },
    async open({ media, expected }): Promise<PrivateVisualRasterHandle> {
      if (
        expected === null ||
        typeof expected !== "object" ||
        !exactKeys(
          expected,
          expected.mediaKind === "video"
            ? ["mediaKind", "extension", "width", "height", "fps", "durationSeconds"]
            : ["mediaKind", "extension", "width", "height"],
        )
      )
        fail("registered media metadata is invalid");
      if (
        media.extension !== expected.extension ||
        media.mediaKind !== expected.mediaKind ||
        !visualExtension(expected.extension) ||
        !visualKind(expected.mediaKind)
      )
        fail("registered media disagrees with reference");
      const { objectPath, inspected, verifyStoredEvidence } = await inspect(media);
      if (inspected.width !== expected.width || inspected.height !== expected.height)
        fail("registered media and decoded content disagree");
      if (
        !Number.isSafeInteger(expected.width) ||
        !Number.isSafeInteger(expected.height) ||
        expected.width < 2 ||
        expected.height < 2
      )
        fail("registered media geometry is invalid");
      if (expected.mediaKind === "video") {
        if (
          expected.fps === undefined ||
          expected.durationSeconds === undefined ||
          inspected.fps === undefined ||
          Math.abs(expected.fps - inspected.fps) > 0.000001 ||
          Math.abs(expected.durationSeconds - inspected.durationUs / 1_000_000) > 0.05
        )
          fail("registered video metadata disagrees with decoded content");
      } else if (expected.fps !== undefined || expected.durationSeconds !== undefined)
        fail("registered image metadata is invalid");
      const still = expected.mediaKind === "image";
      const rasterFps = inspected.fps ?? (still ? 1 : fail("registered video metadata is invalid"));
      let decoder = createDecoder({
        path: objectPath,
        width: inspected.width,
        height: inspected.height,
        still,
      });
      let decoderSpawns = 0;
      let disposed = false;
      let frameIndex = -1;
      let last: RasterFrame | undefined;
      async function restart(): Promise<void> {
        await decoder.dispose();
        decoder = createDecoder({
          path: objectPath,
          width: inspected.width,
          height: inspected.height,
          still: false,
        });
        frameIndex = -1;
        last = undefined;
        decoderSpawns += 1;
      }
      const source: LazyRasterSource = {
        id: media.mediaId,
        width: inspected.width,
        height: inspected.height,
        async frameAt(tUs: number): Promise<RasterFrame> {
          if (disposed || !Number.isSafeInteger(tUs) || tUs < 0)
            fail("raster source is unavailable");
          if (still) {
            if (last === undefined) {
              decoderSpawns += 1;
              last = { tUs: 0, pixels: await decoder.read() };
            }
            return last;
          }
          const target = Math.min(
            Math.max(0, Math.round((tUs / 1_000_000) * rasterFps)),
            Math.max(0, Math.ceil((inspected.durationUs / 1_000_000) * rasterFps) - 1),
          );
          if (target < frameIndex) await restart();
          if (frameIndex === -1 && decoderSpawns === 0) decoderSpawns = 1;
          while (frameIndex < target) {
            frameIndex += 1;
            last = {
              tUs: Math.round((frameIndex / rasterFps) * 1_000_000),
              pixels: await decoder.read(),
            };
          }
          if (last === undefined) fail("video decoder returned no frames");
          return last;
        },
      };
      return {
        source,
        async dispose(): Promise<void> {
          if (!disposed) {
            disposed = true;
            await decoder.dispose();
            await verifyStoredEvidence();
          }
        },
        decoderSpawnCount: () => decoderSpawns,
      };
    },
  };
}
