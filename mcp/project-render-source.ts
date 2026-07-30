import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type ActivityAnalysisResult, analyzeDeadTime } from "../src/analysis/index.js";
import { resolveMediaExecutable } from "../src/encoder/ffmpeg.js";
import { canonicalJson } from "../src/manifest/index.js";
import { assertCaptureSourceGeometryBounded } from "../src/project/capture-geometry.js";
import type { ProjectCaptureSource } from "../src/project/index.js";
import type { CursorSample } from "../src/render/composition.js";
import type { LazyRasterSource, RasterFrame } from "../src/render/raster-compositor.js";
import { isContainedPath } from "../src/safe/path.js";

const execFileAsync = promisify(execFile);
const framePath = /^frames\/raw\/frame-\d{6}\.(?:jpe?g|png)$/u;
const digest = /^[a-f0-9]{64}$/u;
const MAX_CAPTURE_FRAMES = 18_000;
const MAX_CAPTURE_FRAME_BYTES = 64 * 1024 * 1024;

type CaptureFrame = { frameId: number; tUs: number; path: string; sha256: string };
type JsonObject = Record<string, unknown> & {
  sessionId?: unknown;
  type?: unknown;
  frameId?: unknown;
  imagePath?: unknown;
  sha256?: unknown;
  width?: unknown;
  height?: unknown;
  receiptOffsetUs?: unknown;
  source?: unknown;
  timeline?: unknown;
  schemaVersion?: unknown;
  kind?: unknown;
  aggregateSha256?: unknown;
  durationUs?: unknown;
  slots?: unknown;
  tUs?: unknown;
  outputFrame?: unknown;
  sourceFrameId?: unknown;
  cursorTrack?: unknown;
  observedActions?: unknown;
  x?: unknown;
  y?: unknown;
  state?: unknown;
  cfrFrameIndex?: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
};

export type CapturePresentationEvidence = {
  cursorTrack: CursorSample[];
  clickTrack: Array<{ tUs: number; x: number; y: number }>;
};

export type SourceKeyedCapturePresentationEvidence = {
  cursorTrack: Array<{
    sourceId: string;
    sourceTimeUs: number;
    x: number;
    y: number;
    state: "default" | "pressed";
  }>;
  clickTrack: Array<{
    sourceId: string;
    sourceTimeUs: number;
    x: number;
    y: number;
  }>;
};

export type VerifiedCaptureEditorialEvidence = {
  observedEvents: Array<{
    id: string;
    source: "observed";
    sourceId: string;
    tUs: number;
    kind: "click" | "scroll";
    x: number;
    y: number;
  }>;
  deadTime: ActivityAnalysisResult;
};

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

async function privateRegular(
  path: string,
  root: string,
  label: string,
  allowLegacyModeTightening = false,
): Promise<string> {
  if (!isContainedPath(root, path)) throw new RangeError(`${label} escapes its session`);
  let ancestor = root;
  for (const segment of relative(root, path).split("/").slice(0, -1)) {
    ancestor = join(ancestor, segment);
    const directory = await lstat(ancestor);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new RangeError(`${label} has an unsafe ancestor`);
    }
  }
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new RangeError(`${label} must be a private regular file`);
  }
  const resolved = await realpath(path);
  if (!isContainedPath(await realpath(root), resolved))
    throw new RangeError(`${label} resolves outside session`);
  if ((status.mode & 0o077) !== 0 && allowLegacyModeTightening) {
    await chmod(resolved, 0o600);
  }
  const privateStatus = await lstat(resolved);
  if (
    !privateStatus.isFile() ||
    privateStatus.isSymbolicLink() ||
    (privateStatus.mode & 0o077) !== 0
  ) {
    throw new RangeError(`${label} must be a private regular file`);
  }
  return resolved;
}

async function privateDirectory(path: string, root: string, label: string): Promise<string> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError(`${label} must be a private non-symlink directory`);
  }
  const resolved = await realpath(path);
  if (!isContainedPath(await realpath(root), resolved)) {
    throw new RangeError(`${label} resolves outside artifact root`);
  }
  return resolved;
}

function validImageSignature(path: string, bytes: Buffer): boolean {
  if (path.endsWith(".png")) {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function writeAll(
  destination: Awaited<ReturnType<typeof open>>,
  value: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await destination.write(value.subarray(offset));
    if (bytesWritten <= 0) throw new RangeError("capture snapshot write failed");
    offset += bytesWritten;
  }
}

async function stageVerifiedCaptureFrame(input: {
  frame: CaptureFrame;
  sessionRoot: string;
  stagingRoot: string;
}): Promise<string> {
  const sourceStatus = await lstat(input.frame.path);
  if (
    !sourceStatus.isFile() ||
    sourceStatus.isSymbolicLink() ||
    (sourceStatus.mode & 0o077) !== 0
  ) {
    throw new RangeError("capture frame must remain a private regular file");
  }
  const sourceResolved = await realpath(input.frame.path);
  if (!isContainedPath(await realpath(input.sessionRoot), sourceResolved)) {
    throw new RangeError("capture frame resolves outside its session");
  }
  if (sourceStatus.size < 1 || sourceStatus.size > MAX_CAPTURE_FRAME_BYTES) {
    throw new RangeError("capture frame exceeds bounded byte size");
  }
  const suffix = input.frame.path.endsWith(".png") ? ".png" : ".jpg";
  const snapshot = join(input.stagingRoot, `${input.frame.sha256}.${randomUUID()}${suffix}`);
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    source = await open(input.frame.path, "r");
    const opened = await source.stat();
    if (
      !opened.isFile() ||
      opened.dev !== sourceStatus.dev ||
      opened.ino !== sourceStatus.ino ||
      opened.size !== sourceStatus.size
    ) {
      throw new RangeError("capture frame changed before private snapshot");
    }
    destination = await open(snapshot, "wx", 0o600);
    const digestState = createHash("sha256");
    const signature = Buffer.alloc(8);
    let signatureLength = 0;
    let offset = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (offset < opened.size) {
      const { bytesRead } = await source.read(
        chunk,
        0,
        Math.min(chunk.length, opened.size - offset),
        offset,
      );
      if (bytesRead <= 0) throw new RangeError("capture frame changed while snapshotting");
      const value = chunk.subarray(0, bytesRead);
      if (signatureLength < signature.length) {
        const count = Math.min(signature.length - signatureLength, value.length);
        value.copy(signature, signatureLength, 0, count);
        signatureLength += count;
      }
      digestState.update(value);
      await writeAll(destination, value);
      offset += bytesRead;
    }
    if (
      digestState.digest("hex") !== input.frame.sha256 ||
      !validImageSignature(input.frame.path, signature)
    ) {
      throw new RangeError("capture frame snapshot does not match sealed evidence");
    }
    await destination.close();
    destination = undefined;
    await privateRegular(snapshot, input.stagingRoot, "capture frame snapshot");
    return snapshot;
  } catch (error) {
    await unlink(snapshot).catch(() => undefined);
    throw error;
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

async function parseFrames(input: {
  sessionRoot: string;
  source: ProjectCaptureSource;
}): Promise<CaptureFrame[]> {
  const eventsPath = join(input.sessionRoot, "capture-events.jsonl");
  const content = await readFile(
    await privateRegular(eventsPath, input.sessionRoot, "capture events", true),
    "utf8",
  );
  if (!content.endsWith("\n")) throw new RangeError("capture events must end with a newline");
  const lines = content.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > MAX_CAPTURE_FRAMES) {
    throw new RangeError("capture frame count is invalid");
  }
  const frames: CaptureFrame[] = [];
  for (const [index, line] of lines.entries()) {
    const event = object(JSON.parse(line) as unknown, `capture event ${index + 1}`);
    const expectedKeys = [
      "sessionId",
      "type",
      "frameId",
      "receiptOffsetUs",
      "imagePath",
      "sha256",
      "width",
      "height",
    ];
    if (
      Object.keys(event).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(event, key)) ||
      event.sessionId !== input.source.sessionId ||
      event.type !== "frame" ||
      integer(event.frameId, "frame ID") !== index + 1 ||
      typeof event.imagePath !== "string" ||
      !framePath.test(event.imagePath) ||
      typeof event.sha256 !== "string" ||
      !digest.test(event.sha256) ||
      integer(event.width, "frame width") !== input.source.sourceWidth ||
      integer(event.height, "frame height") !== input.source.sourceHeight ||
      integer(event.receiptOffsetUs, "frame receipt offset") <= (frames.at(-1)?.tUs ?? -1)
    ) {
      throw new RangeError("capture evidence does not match its project source");
    }
    const path = resolve(input.sessionRoot, event.imagePath);
    const resolved = await privateRegular(path, input.sessionRoot, `capture frame ${index + 1}`);
    const size = (await lstat(resolved)).size;
    if (size < 1 || size > MAX_CAPTURE_FRAME_BYTES) {
      throw new RangeError("capture frame exceeds bounded byte size");
    }
    if (hash(await readFile(resolved)) !== event.sha256.toLowerCase()) {
      throw new RangeError("capture frame digest does not match evidence");
    }
    frames.push({
      frameId: event.frameId as number,
      tUs: event.receiptOffsetUs as number,
      path: resolved,
      sha256: event.sha256.toLowerCase(),
    });
  }
  const aggregate = hash(frames.map((frame) => frame.sha256).join("\n"));
  if (aggregate !== input.source.frameSetSha256)
    throw new RangeError("capture frame set digest does not match");
  return frames;
}

function boundedFrameSamples(
  frames: readonly CaptureFrame[],
  slots: readonly { tUs: number; sourceFrameId: number }[],
): Array<{ tUs: number; sha256: string }> {
  const maximum = 10_000;
  if (slots.length === 0 || frames.length === 0)
    throw new RangeError("delivery timeline does not match capture frames");
  const framesById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const indexes =
    slots.length <= maximum
      ? Array.from({ length: slots.length }, (_, index) => index)
      : Array.from({ length: maximum }, (_, index) =>
          Math.floor((index * (slots.length - 1)) / (maximum - 1)),
        );
  return indexes.map((index) => {
    const slot = slots[index] as { tUs: number; sourceFrameId: number };
    const frame = framesById.get(slot.sourceFrameId);
    if (frame === undefined) throw new RangeError("delivery timeline slot has no capture frame");
    return { tUs: slot.tUs, sha256: frame.sha256 };
  });
}

/**
 * Reads only bounded, hash-verified source-time evidence from a sealed capture.
 * No raw paths or frame bytes leave this boundary.
 */
export async function readVerifiedCaptureEditorialEvidence(input: {
  artifactRoot: string;
  source: ProjectCaptureSource;
}): Promise<VerifiedCaptureEditorialEvidence> {
  if (!isAbsolute(input.artifactRoot)) throw new RangeError("artifact root must be absolute");
  const artifactStatus = await lstat(input.artifactRoot);
  if (
    !artifactStatus.isDirectory() ||
    artifactStatus.isSymbolicLink() ||
    (artifactStatus.mode & 0o077) !== 0
  ) {
    throw new RangeError("artifact root must be a private non-symlink directory");
  }
  const artifactRoot = await realpath(input.artifactRoot);
  const sessionRoot = await privateDirectory(
    resolve(artifactRoot, input.source.sessionId),
    artifactRoot,
    "capture session",
  );
  const manifestPath = await privateRegular(
    join(sessionRoot, "artifacts", "recording-manifest.json"),
    sessionRoot,
    "delivery manifest",
  );
  const manifestText = await readFile(manifestPath, "utf8");
  if (hash(manifestText) !== input.source.manifestSha256)
    throw new RangeError("delivery manifest digest does not match");
  const manifest = object(JSON.parse(manifestText) as unknown, "delivery manifest");
  const source = object(manifest.source, "delivery manifest source");
  if (
    source.width !== input.source.sourceWidth ||
    source.height !== input.source.sourceHeight ||
    source.aggregateSha256 !== input.source.frameSetSha256
  ) {
    throw new RangeError("delivery source does not match project capture source");
  }
  const timeline = object(manifest.timeline, "delivery manifest timeline");
  const slotsValue = timeline.slots;
  if (timeline.durationUs !== input.source.durationUs || !Array.isArray(slotsValue)) {
    throw new RangeError("delivery timeline does not match project capture source");
  }
  if (slotsValue.length === 0 || slotsValue.length > MAX_CAPTURE_FRAMES) {
    throw new RangeError("delivery timeline slots are invalid");
  }
  const slots = slotsValue.map((value, index) => {
    const slot = object(value, `delivery timeline slot ${index + 1}`);
    const tUs = integer(slot.tUs, "delivery timeline slot time");
    if (
      Object.getOwnPropertyNames(slot).sort().join(",") !== "outputFrame,sourceFrameId,tUs" ||
      integer(slot.outputFrame, "delivery timeline slot output frame") !== index ||
      !Number.isSafeInteger(slot.sourceFrameId) ||
      (slot.sourceFrameId as number) < 1 ||
      tUs > input.source.durationUs ||
      (index > 0 && tUs <= (slotsValue[index - 1] as { tUs: number }).tUs)
    )
      throw new RangeError("delivery timeline slot timing is invalid");
    return { tUs, sourceFrameId: slot.sourceFrameId as number };
  });
  const frames = await parseFrames({ sessionRoot, source: input.source });
  const frameIds = new Set(frames.map((frame) => frame.frameId));
  if (slots.some((slot) => !frameIds.has(slot.sourceFrameId))) {
    throw new RangeError("delivery timeline slot has no capture frame");
  }
  const actionValues = manifest.observedActions;
  if (!Array.isArray(actionValues) || actionValues.length > 2_048) {
    throw new RangeError("delivery action evidence is invalid");
  }
  const observedEvents = actionValues.map((value, index) => {
    const action = object(value, `delivery action ${index + 1}`);
    const cfrFrameIndex = action.cfrFrameIndex;
    if (
      !Number.isSafeInteger(cfrFrameIndex) ||
      (cfrFrameIndex as number) < 0 ||
      (cfrFrameIndex as number) >= slots.length ||
      (action.type !== "click" && action.type !== "scroll") ||
      typeof action.x !== "number" ||
      !Number.isFinite(action.x) ||
      typeof action.y !== "number" ||
      !Number.isFinite(action.y) ||
      action.x < 0 ||
      action.x > input.source.sourceWidth ||
      action.y < 0 ||
      action.y > input.source.sourceHeight ||
      (action.type === "click" &&
        Object.getOwnPropertyNames(action).sort().join(",") !== "cfrFrameIndex,type,x,y") ||
      (action.type === "scroll" &&
        (typeof action.deltaX !== "number" ||
          !Number.isFinite(action.deltaX) ||
          typeof action.deltaY !== "number" ||
          !Number.isFinite(action.deltaY) ||
          (action.deltaX === 0 && action.deltaY === 0) ||
          Object.getOwnPropertyNames(action).sort().join(",") !==
            "cfrFrameIndex,deltaX,deltaY,type,x,y"))
    ) {
      throw new RangeError("delivery action evidence is invalid");
    }
    return {
      id: `evt-${hash(input.source.id).slice(0, 16)}-${index}`,
      source: "observed" as const,
      sourceId: input.source.id,
      tUs: (slots[cfrFrameIndex as number] as { tUs: number; sourceFrameId: number }).tUs,
      kind: action.type as "click" | "scroll",
      x: action.x,
      y: action.y,
    };
  });
  const frameSamples = boundedFrameSamples(frames, slots);
  return {
    observedEvents,
    deadTime: analyzeDeadTime({
      schemaVersion: 1,
      captureDurationUs: input.source.durationUs,
      frameSamples,
      actionSamples: observedEvents.map((event) => ({ tUs: event.tUs, kind: event.kind })),
    }),
  };
}

/** Builds a bounded lazy decoder from hash-verified sealed capture evidence. */
export async function createVerifiedCaptureSource(input: {
  artifactRoot: string;
  source: ProjectCaptureSource;
  stagingRoot: string;
}): Promise<LazyRasterSource> {
  if (!isAbsolute(input.artifactRoot)) throw new RangeError("artifact root must be absolute");
  assertCaptureSourceGeometryBounded({
    width: input.source.sourceWidth,
    height: input.source.sourceHeight,
  });
  const artifactStatus = await lstat(input.artifactRoot);
  if (!artifactStatus.isDirectory() || artifactStatus.isSymbolicLink()) {
    throw new RangeError("artifact root must be a non-symlink directory");
  }
  const artifactRoot = await realpath(input.artifactRoot);
  const stagingRoot = await privateDirectory(
    resolve(input.stagingRoot),
    artifactRoot,
    "render staging directory",
  );
  const sessionRoot = resolve(artifactRoot, input.source.sessionId);
  if (!isContainedPath(artifactRoot, sessionRoot))
    throw new RangeError("capture session escapes artifact root");
  const manifestPath = join(sessionRoot, "artifacts", "recording-manifest.json");
  const manifestContent = await readFile(
    await privateRegular(manifestPath, sessionRoot, "delivery manifest"),
    "utf8",
  );
  if (hash(manifestContent) !== input.source.manifestSha256) {
    throw new RangeError("delivery manifest digest does not match");
  }
  const manifest = object(JSON.parse(manifestContent) as unknown, "delivery manifest");
  const source = object(manifest.source, "delivery manifest source");
  const timeline = object(manifest.timeline, "delivery manifest timeline");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "recordly-codex-delivery" ||
    manifest.sessionId !== input.source.sessionId ||
    integer(source.width, "delivery source width") !== input.source.sourceWidth ||
    integer(source.height, "delivery source height") !== input.source.sourceHeight ||
    source.aggregateSha256 !== input.source.frameSetSha256 ||
    integer(timeline.durationUs, "delivery duration") !== input.source.durationUs ||
    hash(canonicalJson(timeline)) !== input.source.timelineSha256
  ) {
    throw new RangeError("delivery manifest does not match its project source");
  }
  const frames = await parseFrames({ sessionRoot, source: input.source });
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  let cached: RasterFrame | undefined;
  const decode = async (frame: CaptureFrame): Promise<RasterFrame> => {
    if (cached?.tUs === frame.tUs) return cached;
    const snapshot = await stageVerifiedCaptureFrame({
      frame,
      sessionRoot,
      stagingRoot,
    });
    const { stdout: geometry } = await execFileAsync(
      await resolveMediaExecutable("ffprobe"),
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        snapshot,
      ],
      { encoding: "utf8" },
    );
    const [rawWidth, rawHeight] = String(geometry)
      .trim()
      .split(",")
      .map((value) => Number(value));
    if (
      !Number.isSafeInteger(rawWidth) ||
      !Number.isSafeInteger(rawHeight) ||
      (rawWidth as number) < 1 ||
      (rawHeight as number) < 1 ||
      Math.abs(
        (rawWidth as number) * input.source.sourceHeight -
          (rawHeight as number) * input.source.sourceWidth,
      ) > Math.max(input.source.sourceWidth, input.source.sourceHeight)
    ) {
      throw new RangeError("capture frame geometry is incompatible with sealed source geometry");
    }
    const { stdout } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        snapshot,
        "-vf",
        `scale=${input.source.sourceWidth}:${input.source.sourceHeight}:flags=lanczos`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      {
        encoding: "buffer",
        maxBuffer: input.source.sourceWidth * input.source.sourceHeight * 3 + 1_048_576,
      },
    );
    const pixels = Buffer.from(stdout);
    if (pixels.length !== input.source.sourceWidth * input.source.sourceHeight * 3) {
      throw new RangeError("capture frame decoder returned invalid RGB24 data");
    }
    cached = { tUs: frame.tUs, pixels };
    return cached;
  };
  return {
    id: input.source.id,
    width: input.source.sourceWidth,
    height: input.source.sourceHeight,
    frameAt: async (tUs) => {
      let nearest = frames[0] as CaptureFrame;
      for (const frame of frames)
        if (Math.abs(frame.tUs - tUs) < Math.abs(nearest.tUs - tUs)) nearest = frame;
      return decode(nearest);
    },
  };
}

/** Reads only sanitized, receipt-timed cursor and click evidence from a verified delivery manifest. */
export async function readVerifiedCapturePresentationEvidence(input: {
  artifactRoot: string;
  source: ProjectCaptureSource;
}): Promise<CapturePresentationEvidence> {
  const artifactRoot = await realpath(input.artifactRoot);
  const sessionRoot = resolve(artifactRoot, input.source.sessionId);
  if (!isContainedPath(artifactRoot, sessionRoot))
    throw new RangeError("capture session escapes artifact root");
  const content = await readFile(
    await privateRegular(
      join(sessionRoot, "artifacts", "recording-manifest.json"),
      sessionRoot,
      "delivery manifest",
    ),
    "utf8",
  );
  if (hash(content) !== input.source.manifestSha256)
    throw new RangeError("delivery manifest digest does not match");
  const manifest = object(JSON.parse(content) as unknown, "delivery manifest");
  const timeline = object(manifest.timeline, "delivery manifest timeline");
  const slots = timeline.slots;
  if (!Array.isArray(slots) || slots.length === 0)
    throw new RangeError("delivery timeline slots are invalid");
  const slotTime = (index: unknown): number => {
    if (
      !Number.isSafeInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= slots.length
    ) {
      throw new RangeError("delivery event frame index is invalid");
    }
    return integer(
      object(slots[index as number], "delivery timeline slot").tUs,
      "delivery slot time",
    );
  };
  const cursorValues = manifest.cursorTrack ?? [];
  const actionValues = manifest.observedActions;
  if (!Array.isArray(cursorValues) || !Array.isArray(actionValues)) {
    throw new RangeError("delivery presentation evidence is invalid");
  }
  const cursorTrack = cursorValues.map((value) => {
    const event = object(value, "delivery cursor event");
    if (
      typeof event.x !== "number" ||
      !Number.isFinite(event.x) ||
      typeof event.y !== "number" ||
      !Number.isFinite(event.y) ||
      (event.state !== "default" && event.state !== "pressed")
    ) {
      throw new RangeError("delivery cursor event is invalid");
    }
    return {
      x: event.x,
      y: event.y,
      state: event.state as "default" | "pressed",
      tUs: slotTime(event.cfrFrameIndex),
    };
  });
  for (let index = 1; index < cursorTrack.length; index += 1) {
    if ((cursorTrack[index] as CursorSample).tUs <= (cursorTrack[index - 1] as CursorSample).tUs) {
      throw new RangeError("delivery cursor event timing is invalid");
    }
  }
  const clickTrack = actionValues.flatMap((value) => {
    const event = object(value, "delivery action event");
    if (event.type !== "click") return [];
    if (
      typeof event.x !== "number" ||
      !Number.isFinite(event.x) ||
      typeof event.y !== "number" ||
      !Number.isFinite(event.y)
    ) {
      throw new RangeError("delivery click event is invalid");
    }
    return [{ x: event.x, y: event.y, tUs: slotTime(event.cfrFrameIndex) }];
  });
  return { cursorTrack, clickTrack };
}

/** Converts one sealed capture's CFR-indexed evidence into absolute source-time keyed samples. */
export async function readSourceKeyedCapturePresentationEvidence(input: {
  artifactRoot: string;
  source: ProjectCaptureSource;
}): Promise<SourceKeyedCapturePresentationEvidence> {
  const evidence = await readVerifiedCapturePresentationEvidence(input);
  return sourceKeyedPresentationEvidence(input.source.id, evidence);
}

/** Pure mapping used by the verified reader and exercised without filesystem fixtures. */
export function sourceKeyedPresentationEvidence(
  sourceId: string,
  evidence: CapturePresentationEvidence,
): SourceKeyedCapturePresentationEvidence {
  return {
    cursorTrack: evidence.cursorTrack.map((sample) => ({
      sourceId,
      sourceTimeUs: sample.tUs,
      x: sample.x,
      y: sample.y,
      state: sample.state,
    })),
    clickTrack: evidence.clickTrack.map((sample) => ({
      sourceId,
      sourceTimeUs: sample.tUs,
      x: sample.x,
      y: sample.y,
    })),
  };
}
