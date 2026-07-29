// biome-ignore-all lint/complexity/useLiteralKeys: sealed evidence is an untrusted persisted boundary.
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { validateRecordingRequest, validateSessionEvents } from "../contracts/index.js";
import { resolveMediaExecutable } from "../encoder/ffmpeg.js";
import { MEDIA_PROCESS_POLICY, runMediaProcess } from "../encoder/media-process.js";
import { probeRenderedVideo } from "../encoder/probe.js";
import { canonicalJson } from "../manifest/index.js";

const FPS = 30;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const MAX_FRAMES = FPS * 300;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const FRAME_PATH_PATTERN = /^frames\/raw\/frame-\d{6}\.(?:jpe?g|png)$/u;
const ACTION_PRE_WINDOW_US = 500_000;
const ACTION_RESULT_WINDOW_US = 2_000_000;
const FINAL_HOLD_MINIMUM_US = 300_000;
const VISIBLE_CHANGE_THRESHOLD = 0.02;
const EDGE_DELTA_THRESHOLD = 0.18;
const COMPOSITION_COLOR_THRESHOLD = 0.08;
const BORDER_PX = 12;

type JsonObject = Record<string, unknown>;

type CaptureFrame = {
  frameId: number;
  imagePath: string;
  absolutePath: string;
  sha256: string;
  width: number;
  height: number;
  receiptOffsetUs?: number;
};

type ObservedEvent =
  | {
      type: "click";
      seq: number;
      receiptOffsetUs: number;
      data: { x: number; y: number; button: 0 | 1 | 2 };
    }
  | {
      type: "scroll";
      seq: number;
      receiptOffsetUs: number;
      data: { x: number; y: number; deltaX: number; deltaY: number };
    }
  | {
      type: "pointer";
      seq: number;
      receiptOffsetUs: number;
      data: { x: number; y: number; buttons: number; cursor: "default" | "pressed" };
    };

type ObservedAction = Exclude<ObservedEvent, { type: "pointer" }>;

type PpmImage = { width: number; height: number; pixels: Buffer };

type CaptureSummary = {
  origin: string;
  acceptedFrames: number;
  ackedFrames: number;
  receivedFrames: number;
  rejectedFrames: number;
};

export type TimingMode = "broker-receipt-offsets" | "legacy_ordered_cfr";

export type RenderedSealedSession = {
  videoPath: string;
  manifestPath: string;
  qualityReportPath: string;
  artifactPaths: [string, string, string];
  timingMode: TimingMode;
  approved: boolean;
};

export class SealedSessionRenderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SealedSessionRenderError";
  }
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SealedSessionRenderError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SealedSessionRenderError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in value))) {
    throw new SealedSessionRenderError(`${label} fields are invalid`);
  }
}

async function regularFile(path: string, label: string): Promise<void> {
  const status = await lstat(path).catch(() => {
    throw new SealedSessionRenderError(`${label} is missing`);
  });
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new SealedSessionRenderError(`${label} must be a non-symlink regular file`);
  }
}

async function ownedDirectory(path: string, label: string): Promise<void> {
  const status = await lstat(path).catch(() => {
    throw new SealedSessionRenderError(`${label} is missing`);
  });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new SealedSessionRenderError(`${label} must be a non-symlink directory`);
  }
}

function contained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

type VerifiedSessionTree = { root: string; realRoot: string };

async function verifiedSessionTree(
  artifactRoot: string,
  sessionRoot: string,
): Promise<VerifiedSessionTree> {
  await ownedDirectory(artifactRoot, "artifact root");
  await ownedDirectory(sessionRoot, "session root");
  const [realArtifactRoot, realSessionRoot] = await Promise.all([
    realpath(artifactRoot),
    realpath(sessionRoot),
  ]);
  if (!contained(realArtifactRoot, realSessionRoot)) {
    throw new SealedSessionRenderError("resolved session path escapes the artifact root");
  }
  return { root: sessionRoot, realRoot: realSessionRoot };
}

async function regularSessionFile(
  tree: VerifiedSessionTree,
  path: string,
  label: string,
): Promise<void> {
  if (!contained(tree.root, path)) {
    throw new SealedSessionRenderError(`${label} escapes the sealed session`);
  }
  const segments = relative(tree.root, path).split("/");
  let ancestor = tree.root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = join(ancestor, segment);
    await ownedDirectory(ancestor, `${label} ancestor`);
  }
  await regularFile(path, label);
  const resolved = await realpath(path).catch(() => {
    throw new SealedSessionRenderError(`${label} is missing`);
  });
  if (!contained(tree.realRoot, resolved)) {
    throw new SealedSessionRenderError(`${label} resolved path escapes the verified session tree`);
  }
}

async function jsonFile(path: string, label: string): Promise<unknown> {
  await regularFile(path, label);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new SealedSessionRenderError(`${label} must contain valid JSON`);
  }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readMetadata(sessionRoot: string, sessionId: string): Promise<void> {
  const metadata = object(
    await jsonFile(join(sessionRoot, "session.json"), "session metadata"),
    "session metadata",
  );
  if (
    metadata["schemaVersion"] !== 1 ||
    metadata["sessionId"] !== sessionId ||
    metadata["state"] !== "sealed" ||
    !Number.isSafeInteger(metadata["sealedAtUs"])
  ) {
    throw new SealedSessionRenderError("session must have valid sealed metadata");
  }
}

async function readSummary(
  sessionRoot: string,
  sessionId: string,
  expectedOrigin: string,
): Promise<CaptureSummary> {
  const summary = object(
    await jsonFile(join(sessionRoot, "capture-summary.json"), "capture summary"),
    "capture summary",
  );
  if (
    summary["schemaVersion"] !== 1 ||
    summary["sessionId"] !== sessionId ||
    summary["origin"] !== expectedOrigin ||
    summary["status"] !== "stopped" ||
    summary["degradationRequested"] !== false ||
    summary["reason"] !== undefined
  ) {
    throw new SealedSessionRenderError("capture summary does not prove a successful capture");
  }
  const acceptedFrames = integer(summary["acceptedFrames"], "accepted frame count");
  const ackedFrames = integer(summary["ackedFrames"], "acknowledged frame count");
  const receivedFrames = integer(summary["receivedFrames"], "received frame count");
  const rejectedFrames = integer(summary["rejectedFrames"], "rejected frame count");
  if (
    acceptedFrames === 0 ||
    acceptedFrames !== ackedFrames ||
    acceptedFrames !== receivedFrames ||
    rejectedFrames !== 0
  ) {
    throw new SealedSessionRenderError("capture summary frame counts are incomplete");
  }
  return { origin: expectedOrigin, acceptedFrames, ackedFrames, receivedFrames, rejectedFrames };
}

async function readFrames(
  tree: VerifiedSessionTree,
  sessionId: string,
  expectedCount: number,
): Promise<CaptureFrame[]> {
  const eventsPath = join(tree.root, "capture-events.jsonl");
  await regularSessionFile(tree, eventsPath, "capture events");
  const content = await readFile(eventsPath, "utf8");
  if (!content.endsWith("\n")) {
    throw new SealedSessionRenderError("capture events must end with a newline");
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines.length !== expectedCount || lines.length > MAX_FRAMES) {
    throw new SealedSessionRenderError("capture event count does not match the bounded summary");
  }
  const frames: CaptureFrame[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new SealedSessionRenderError(`capture event ${index + 1} is invalid JSON`);
    }
    const event = object(parsed, `capture event ${index + 1}`);
    const hasReceipt = "receiptOffsetUs" in event;
    exactKeys(
      event,
      [
        "sessionId",
        "type",
        "frameId",
        "imagePath",
        "sha256",
        "width",
        "height",
        ...(hasReceipt ? ["receiptOffsetUs"] : []),
      ],
      `capture event ${index + 1}`,
    );
    const frameId = integer(event["frameId"], "frame ID");
    const imagePath = event["imagePath"];
    const hash = event["sha256"];
    const width = integer(event["width"], "frame width");
    const height = integer(event["height"], "frame height");
    if (
      event["sessionId"] !== sessionId ||
      event["type"] !== "frame" ||
      frameId !== index + 1 ||
      typeof imagePath !== "string" ||
      !FRAME_PATH_PATTERN.test(imagePath) ||
      typeof hash !== "string" ||
      !HASH_PATTERN.test(hash) ||
      width === 0 ||
      height === 0
    ) {
      throw new SealedSessionRenderError(`capture event ${index + 1} is invalid`);
    }
    const absolutePath = resolve(tree.root, imagePath);
    if (!contained(tree.root, absolutePath)) {
      throw new SealedSessionRenderError("capture frame path escapes the sealed session");
    }
    await regularSessionFile(tree, absolutePath, `capture frame ${frameId}`);
    if ((await digest(absolutePath)) !== hash) {
      throw new SealedSessionRenderError(`capture frame ${frameId} hash does not match evidence`);
    }
    const receiptOffsetUs = hasReceipt
      ? integer(event["receiptOffsetUs"], "receipt offset")
      : undefined;
    frames.push({
      frameId,
      imagePath,
      absolutePath,
      sha256: hash,
      width,
      height,
      ...(receiptOffsetUs === undefined ? {} : { receiptOffsetUs }),
    });
  }
  const first = frames[0] as CaptureFrame;
  if (frames.some((frame) => frame.width !== first.width || frame.height !== first.height)) {
    throw new SealedSessionRenderError("capture frame geometry must remain stable");
  }
  const receiptCount = frames.filter((frame) => frame.receiptOffsetUs !== undefined).length;
  if (receiptCount !== 0 && receiptCount !== frames.length) {
    throw new SealedSessionRenderError("receipt timing must be present on every capture frame");
  }
  if (receiptCount === frames.length) {
    if (first.receiptOffsetUs !== 0) {
      throw new SealedSessionRenderError("first receipt offset must be zero");
    }
    for (let index = 1; index < frames.length; index += 1) {
      if (
        ((frames[index] as CaptureFrame).receiptOffsetUs as number) <=
        ((frames[index - 1] as CaptureFrame).receiptOffsetUs as number)
      ) {
        throw new SealedSessionRenderError("receipt offsets must be strictly increasing");
      }
    }
  }
  return frames;
}

function finiteCoordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new SealedSessionRenderError(`${label} must be a finite bounded number`);
  }
  return value;
}

async function readObservedEvents(
  sessionRoot: string,
  sessionId: string,
): Promise<ObservedEvent[]> {
  const path = join(sessionRoot, "observed-events.jsonl");
  try {
    await regularFile(path, "observed events");
  } catch (error) {
    if (
      error instanceof SealedSessionRenderError &&
      error.message === "observed events is missing"
    ) {
      return [];
    }
    throw error;
  }
  const content = await readFile(path, "utf8");
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new SealedSessionRenderError("observed events must end with a newline");
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines.length > 10_000) {
    throw new SealedSessionRenderError("observed events exceed the broker persistence bound");
  }
  const events: ObservedEvent[] = [];
  let previousReceiptOffsetUs = -1;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new SealedSessionRenderError(`observed event ${index + 1} is invalid JSON`);
    }
    const event = object(parsed, `observed event ${index + 1}`);
    exactKeys(
      event,
      ["schemaVersion", "sessionId", "seq", "type", "receiptOffsetUs", "data"],
      `observed event ${index + 1}`,
    );
    const seq = integer(event["seq"], "observed event sequence");
    const receiptOffsetUs = integer(event["receiptOffsetUs"], "observed event receipt offset");
    if (
      event["schemaVersion"] !== 1 ||
      event["sessionId"] !== sessionId ||
      seq !== index + 1 ||
      receiptOffsetUs <= previousReceiptOffsetUs
    ) {
      throw new SealedSessionRenderError(`observed event ${index + 1} ordering is invalid`);
    }
    previousReceiptOffsetUs = receiptOffsetUs;
    const data = object(event["data"], `observed event ${index + 1} data`);
    if (event["type"] === "click") {
      exactKeys(data, ["x", "y", "button"], `observed event ${index + 1} click data`);
      const button = data["button"];
      if (button !== 0 && button !== 1 && button !== 2) {
        throw new SealedSessionRenderError("observed click button is invalid");
      }
      events.push({
        type: "click",
        seq,
        receiptOffsetUs,
        data: {
          x: finiteCoordinate(data["x"], "observed click x"),
          y: finiteCoordinate(data["y"], "observed click y"),
          button,
        },
      });
      continue;
    }
    if (event["type"] === "scroll") {
      exactKeys(data, ["x", "y", "deltaX", "deltaY"], `observed event ${index + 1} scroll data`);
      const deltaX = finiteCoordinate(data["deltaX"], "observed scroll deltaX");
      const deltaY = finiteCoordinate(data["deltaY"], "observed scroll deltaY");
      if (deltaX === 0 && deltaY === 0) {
        throw new SealedSessionRenderError("observed scroll delta must be nonzero");
      }
      events.push({
        type: "scroll",
        seq,
        receiptOffsetUs,
        data: {
          x: finiteCoordinate(data["x"], "observed scroll x"),
          y: finiteCoordinate(data["y"], "observed scroll y"),
          deltaX,
          deltaY,
        },
      });
      continue;
    }
    if (event["type"] === "pointer") {
      exactKeys(data, ["x", "y", "buttons", "cursor"], `observed event ${index + 1} pointer data`);
      const buttons = integer(data["buttons"], "observed pointer buttons");
      const cursor = data["cursor"];
      if (buttons > 31 || (cursor !== "default" && cursor !== "pressed")) {
        throw new SealedSessionRenderError("observed pointer state is invalid");
      }
      events.push({
        type: "pointer",
        seq,
        receiptOffsetUs,
        data: {
          x: finiteCoordinate(data["x"], "observed pointer x"),
          y: finiteCoordinate(data["y"], "observed pointer y"),
          buttons,
          cursor,
        },
      });
      continue;
    }
    throw new SealedSessionRenderError(`observed event ${index + 1} type is unsupported`);
  }
  return events;
}

function cfrFrames(frames: readonly CaptureFrame[]): {
  mode: TimingMode;
  slots: Array<{ outputFrame: number; tUs: number; sourceFrameId: number }>;
} {
  if (frames[0]?.receiptOffsetUs === undefined) {
    return {
      mode: "legacy_ordered_cfr",
      slots: frames.map((frame, outputFrame) => ({
        outputFrame,
        tUs: Math.round((outputFrame * 1_000_000) / FPS),
        sourceFrameId: frame.frameId,
      })),
    };
  }
  const finalOffset = (frames.at(-1) as CaptureFrame).receiptOffsetUs as number;
  const frameCount = Math.floor((finalOffset * FPS) / 1_000_000) + 1;
  if (frameCount <= 0 || frameCount > MAX_FRAMES) {
    throw new SealedSessionRenderError("receipt-timed output duration is outside bounds");
  }
  let sourceIndex = 0;
  const slots: Array<{ outputFrame: number; tUs: number; sourceFrameId: number }> = [];
  for (let outputFrame = 0; outputFrame < frameCount; outputFrame += 1) {
    const tUs = Math.round((outputFrame * 1_000_000) / FPS);
    while (sourceIndex + 1 < frames.length) {
      const current = frames[sourceIndex] as CaptureFrame;
      const next = frames[sourceIndex + 1] as CaptureFrame;
      if (
        Math.abs((next.receiptOffsetUs as number) - tUs) >=
        Math.abs((current.receiptOffsetUs as number) - tUs)
      ) {
        break;
      }
      sourceIndex += 1;
    }
    slots.push({ outputFrame, tUs, sourceFrameId: (frames[sourceIndex] as CaptureFrame).frameId });
  }
  const finalSourceFrameId = (frames.at(-1) as CaptureFrame).frameId;
  if (slots.at(-1)?.sourceFrameId !== finalSourceFrameId) {
    if (slots.length >= MAX_FRAMES) {
      throw new SealedSessionRenderError("receipt-timed output duration is outside bounds");
    }
    slots.push({
      outputFrame: slots.length,
      tUs: Math.round((slots.length * 1_000_000) / FPS),
      sourceFrameId: finalSourceFrameId,
    });
  }
  return { mode: "broker-receipt-offsets", slots };
}

function ffconcatPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

async function encode(
  frames: readonly CaptureFrame[],
  slots: readonly { sourceFrameId: number }[],
  workRoot: string,
): Promise<string> {
  const concatPath = join(workRoot, "timeline.ffconcat");
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const lines = ["ffconcat version 1.0"];
  for (const slot of slots) {
    const frame = byId.get(slot.sourceFrameId);
    if (frame === undefined) throw new SealedSessionRenderError("CFR slot has no source evidence");
    lines.push(`file ${ffconcatPath(frame.absolutePath)}`, "duration 0.033333333");
  }
  const final = byId.get((slots.at(-1) as { sourceFrameId: number }).sourceFrameId);
  lines.push(`file ${ffconcatPath((final as CaptureFrame).absolutePath)}`);
  await writeFile(concatPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const outputPath = join(workRoot, "recording.mp4");
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session encoder",
    timeoutMs: MEDIA_PROCESS_POLICY.sealedEncodeDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-an",
      "-vf",
      "fps=30,scale=1740:980:force_original_aspect_ratio=decrease:force_divisible_by=2:in_range=auto:out_range=limited,pad=iw+24:ih+24:12:12:color=0xf8fafc,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f172a,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-bsf:v",
      "h264_metadata=video_full_range_flag=0",
      "-movflags",
      "+faststart",
      "-frames:v",
      String(slots.length),
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  return outputPath;
}

async function sampleFrame(
  videoPath: string,
  frameIndex: number,
  outputPath: string,
): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session QA frame extraction",
    timeoutMs: MEDIA_PROCESS_POLICY.inspectionDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frameIndex})`,
      "-vsync",
      "0",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "ppm",
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  await regularFile(outputPath, "decoded QA sample");
}

async function sampleScaledFrame(
  videoPath: string,
  frameIndex: number,
  outputPath: string,
): Promise<PpmImage> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session QA scaled frame extraction",
    timeoutMs: MEDIA_PROCESS_POLICY.inspectionDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frameIndex}),scale=160:90`,
      "-vsync",
      "0",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "ppm",
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  return parsePpm(await readFile(outputPath));
}

async function decodeSourceFrame(
  inputPath: string,
  outputPath: string,
  width?: number,
  height?: number,
): Promise<PpmImage> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session source frame decode",
    timeoutMs: MEDIA_PROCESS_POLICY.inspectionDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      ...(width === undefined || height === undefined
        ? []
        : ["-vf", `scale=${width}:${height}:in_range=auto:out_range=limited`]),
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "ppm",
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  return parsePpm(await readFile(outputPath));
}

function parsePpm(buffer: Buffer): PpmImage {
  let offset = 0;
  const token = (): string => {
    while (offset < buffer.length) {
      const byte = buffer[offset] as number;
      if (byte === 35) {
        while (offset < buffer.length && buffer[offset] !== 10) offset += 1;
      } else if (byte <= 32) {
        offset += 1;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < buffer.length && (buffer[offset] as number) > 32) offset += 1;
    return buffer.subarray(start, offset).toString("ascii");
  };
  if (token() !== "P6") throw new SealedSessionRenderError("decoded QA frame must be binary PPM");
  const width = Number(token());
  const height = Number(token());
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || token() !== "255") {
    throw new SealedSessionRenderError("decoded QA frame has invalid PPM geometry");
  }
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) {
    offset += 2;
  } else if ((buffer[offset] as number) <= 32) {
    offset += 1;
  }
  const pixels = buffer.subarray(offset);
  if (pixels.length !== width * height * 3) {
    throw new SealedSessionRenderError("decoded QA frame has invalid PPM pixel data");
  }
  return { width, height, pixels };
}

function visibleChange(first: PpmImage, second: PpmImage): number {
  if (first.width !== second.width || first.height !== second.height) {
    throw new SealedSessionRenderError("decoded comparison frames must have matching geometry");
  }
  let delta = 0;
  for (let index = 0; index < first.pixels.length; index += 1) {
    delta += Math.abs((first.pixels[index] as number) - (second.pixels[index] as number));
  }
  return Number((delta / (first.pixels.length * 255)).toFixed(6));
}

function nearestSlotIndex(slots: readonly { tUs: number }[], receiptOffsetUs: number): number {
  let selected = 0;
  for (let index = 1; index < slots.length; index += 1) {
    if (
      Math.abs((slots[index] as { tUs: number }).tUs - receiptOffsetUs) <
      Math.abs((slots[selected] as { tUs: number }).tUs - receiptOffsetUs)
    ) {
      selected = index;
    }
  }
  return selected;
}

async function assessActionAlignment(input: {
  actions: readonly ObservedAction[];
  frames: readonly CaptureFrame[];
  slots: readonly { tUs: number; sourceFrameId: number }[];
  timingMode: TimingMode;
  videoPath: string;
  workRoot: string;
}): Promise<{
  status: "pass" | "fail";
  visibleChangeThreshold: number;
  preActionWindowUs: number;
  resultWindowUs: number;
  finalHoldMinimumUs: number;
  proofScope: string;
  events: Array<{
    type: "click" | "scroll";
    actionFrameIndex: number;
    preFrameIndex?: number;
    resultFrameIndex?: number;
    visibleChange?: number;
    finalHoldUs?: number;
    status: "pass" | "fail";
  }>;
}> {
  const report = {
    status: "fail" as "pass" | "fail",
    visibleChangeThreshold: VISIBLE_CHANGE_THRESHOLD,
    preActionWindowUs: ACTION_PRE_WINDOW_US,
    resultWindowUs: ACTION_RESULT_WINDOW_US,
    finalHoldMinimumUs: FINAL_HOLD_MINIMUM_US,
    proofScope: "temporal visible-result alignment; causal semantics are not asserted",
    events: [] as Array<{
      type: "click" | "scroll";
      actionFrameIndex: number;
      preFrameIndex?: number;
      resultFrameIndex?: number;
      visibleChange?: number;
      finalHoldUs?: number;
      status: "pass" | "fail";
    }>,
  };
  if (input.timingMode !== "broker-receipt-offsets" || input.actions.length === 0) return report;
  const byId = new Map(input.frames.map((frame) => [frame.frameId, frame]));
  const decoded = new Map<number, PpmImage>();
  const decode = async (frameIndex: number): Promise<PpmImage> => {
    const cached = decoded.get(frameIndex);
    if (cached !== undefined) return cached;
    const image = await sampleScaledFrame(
      input.videoPath,
      frameIndex,
      join(input.workRoot, `action-${frameIndex}.ppm`),
    );
    decoded.set(frameIndex, image);
    return image;
  };
  for (const action of input.actions) {
    const actionFrameIndex = nearestSlotIndex(input.slots, action.receiptOffsetUs);
    let preFrameIndex = -1;
    for (let index = 0; index < input.slots.length; index += 1) {
      const slot = input.slots[index] as { tUs: number };
      if (
        slot.tUs < action.receiptOffsetUs &&
        slot.tUs >= action.receiptOffsetUs - ACTION_PRE_WINDOW_US
      ) {
        preFrameIndex = index;
      }
    }
    if (preFrameIndex < 0) {
      report.events.push({ type: action.type, actionFrameIndex, status: "fail" });
      continue;
    }
    const pre = await decode(preFrameIndex);
    const preSource = byId.get(
      (input.slots[preFrameIndex] as { sourceFrameId: number }).sourceFrameId,
    );
    let resultFrameIndex: number | undefined;
    let change: number | undefined;
    for (let index = actionFrameIndex + 1; index < input.slots.length; index += 1) {
      const slot = input.slots[index] as { tUs: number; sourceFrameId: number };
      if (slot.tUs <= action.receiptOffsetUs) continue;
      if (slot.tUs > action.receiptOffsetUs + ACTION_RESULT_WINDOW_US) break;
      const candidateSource = byId.get(slot.sourceFrameId);
      if (candidateSource?.sha256 === preSource?.sha256) continue;
      const measured = visibleChange(pre, await decode(index));
      if (measured >= VISIBLE_CHANGE_THRESHOLD) {
        resultFrameIndex = index;
        change = measured;
        break;
      }
    }
    if (resultFrameIndex === undefined || change === undefined) {
      report.events.push({
        type: action.type,
        actionFrameIndex,
        preFrameIndex,
        status: "fail",
      });
      continue;
    }
    const finalHoldUs =
      (input.slots.at(-1) as { tUs: number }).tUs -
      (input.slots[resultFrameIndex] as { tUs: number }).tUs;
    report.events.push({
      type: action.type,
      actionFrameIndex,
      preFrameIndex,
      resultFrameIndex,
      visibleChange: change,
      finalHoldUs,
      status: finalHoldUs >= FINAL_HOLD_MINIMUM_US ? "pass" : "fail",
    });
  }
  report.status =
    report.events.length === input.actions.length &&
    report.events.every((event) => event.status === "pass")
      ? "pass"
      : "fail";
  return report;
}

type Rgb = { r: number; g: number; b: number };

function meanRegion(
  image: PpmImage,
  xValue: number,
  yValue: number,
  widthValue: number,
  heightValue: number,
): Rgb {
  const left = Math.max(0, Math.floor(xValue));
  const top = Math.max(0, Math.floor(yValue));
  const right = Math.min(image.width, Math.ceil(xValue + widthValue));
  const bottom = Math.min(image.height, Math.ceil(yValue + heightValue));
  if (left >= right || top >= bottom) {
    throw new SealedSessionRenderError("decoded clipping sample region is empty");
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 3;
      r += image.pixels[offset] as number;
      g += image.pixels[offset + 1] as number;
      b += image.pixels[offset + 2] as number;
      count += 1;
    }
  }
  return { r: r / count, g: g / count, b: b / count };
}

function colorDelta(first: Rgb, second: Rgb): number {
  return (
    (Math.abs(first.r - second.r) + Math.abs(first.g - second.g) + Math.abs(first.b - second.b)) /
    (3 * 255)
  );
}

function expectedContentRect(
  sourceWidth: number,
  sourceHeight: number,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  outerX: number;
  outerY: number;
  outerWidth: number;
  outerHeight: number;
} {
  const scale = Math.min(1740 / sourceWidth, 980 / sourceHeight);
  const nearestEven = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const width = nearestEven(sourceWidth * scale);
  const height = nearestEven(sourceHeight * scale);
  const outerWidth = width + BORDER_PX * 2;
  const outerHeight = height + BORDER_PX * 2;
  const outerX = Math.floor((OUTPUT_WIDTH - outerWidth) / 2);
  const outerY = Math.floor((OUTPUT_HEIGHT - outerHeight) / 2);
  return {
    x: outerX + BORDER_PX,
    y: outerY + BORDER_PX,
    width,
    height,
    outerX,
    outerY,
    outerWidth,
    outerHeight,
  };
}

function edgeMeans(
  image: PpmImage,
  rect: { x: number; y: number; width: number; height: number },
): Rgb[] {
  const stripe = Math.max(2, Math.min(4, Math.floor(Math.min(rect.width, rect.height) / 20)));
  return [
    meanRegion(image, rect.x + rect.width * 0.1, rect.y, rect.width * 0.8, stripe),
    meanRegion(
      image,
      rect.x + rect.width - stripe,
      rect.y + rect.height * 0.1,
      stripe,
      rect.height * 0.8,
    ),
    meanRegion(
      image,
      rect.x + rect.width * 0.1,
      rect.y + rect.height - stripe,
      rect.width * 0.8,
      stripe,
    ),
    meanRegion(image, rect.x, rect.y + rect.height * 0.1, stripe, rect.height * 0.8),
  ];
}

async function assessClipping(input: {
  frames: readonly CaptureFrame[];
  slots: readonly { sourceFrameId: number }[];
  samplePaths: { opening: string; midpoint: string; final: string };
  workRoot: string;
}): Promise<{
  status: "pass" | "fail";
  borderPx: number;
  expectedContentRect: { x: number; y: number; width: number; height: number };
  thresholds: {
    maxEdgeColorDelta: number;
    maxCompositionColorDelta: number;
    maxAspectError: number;
  };
  samples: Array<{
    frameIndex: number;
    sourceFrameId: number;
    edgesPresent: boolean;
    maxEdgeColorDelta: number;
    maxBorderColorDelta: number;
    maxMatteColorDelta: number;
    aspectError: number;
    status: "pass" | "fail";
  }>;
}> {
  const first = input.frames[0] as CaptureFrame;
  const rect = expectedContentRect(first.width, first.height);
  const frameIndices = [0, Math.floor((input.slots.length - 1) / 2), input.slots.length - 1];
  const outputPaths = [
    input.samplePaths.opening,
    input.samplePaths.midpoint,
    input.samplePaths.final,
  ];
  const byId = new Map(input.frames.map((frame) => [frame.frameId, frame]));
  const samples = [];
  for (let sampleIndex = 0; sampleIndex < frameIndices.length; sampleIndex += 1) {
    const frameIndex = frameIndices[sampleIndex] as number;
    const sourceFrameId = (input.slots[frameIndex] as { sourceFrameId: number }).sourceFrameId;
    const source = byId.get(sourceFrameId);
    if (source === undefined)
      throw new SealedSessionRenderError("clipping sample lacks source frame");
    const output = parsePpm(await readFile(outputPaths[sampleIndex] as string));
    const decodedSource = await decodeSourceFrame(
      source.absolutePath,
      join(input.workRoot, `clipping-source-${sampleIndex}.ppm`),
      rect.width,
      rect.height,
    );
    const sourceEdges = edgeMeans(decodedSource, {
      x: 0,
      y: 0,
      width: rect.width,
      height: rect.height,
    });
    const outputEdges = edgeMeans(output, rect);
    const maxEdgeColorDelta = Math.max(
      ...sourceEdges.map((edge, index) => colorDelta(edge, outputEdges[index] as Rgb)),
    );
    const lightBorder = { r: 248, g: 250, b: 252 };
    const darkMatte = { r: 15, g: 23, b: 42 };
    const borderColors = [
      meanRegion(output, rect.x + rect.width / 2 - 8, rect.y - 8, 16, 4),
      meanRegion(output, rect.x + rect.width + 4, rect.y + rect.height / 2 - 8, 4, 16),
      meanRegion(output, rect.x + rect.width / 2 - 8, rect.y + rect.height + 4, 16, 4),
      meanRegion(output, rect.x - 8, rect.y + rect.height / 2 - 8, 4, 16),
    ];
    const matteColors = [
      meanRegion(output, 8, 8, 12, 12),
      meanRegion(output, output.width - 20, 8, 12, 12),
      meanRegion(output, 8, output.height - 20, 12, 12),
      meanRegion(output, output.width - 20, output.height - 20, 12, 12),
    ];
    const maxBorderColorDelta = Math.max(
      ...borderColors.map((color) => colorDelta(color, lightBorder)),
    );
    const maxMatteColorDelta = Math.max(
      ...matteColors.map((color) => colorDelta(color, darkMatte)),
    );
    const aspectError =
      Math.abs(rect.width / rect.height - first.width / first.height) /
      (first.width / first.height);
    const pass =
      maxEdgeColorDelta <= EDGE_DELTA_THRESHOLD &&
      maxBorderColorDelta <= COMPOSITION_COLOR_THRESHOLD &&
      maxMatteColorDelta <= COMPOSITION_COLOR_THRESHOLD &&
      aspectError <= 0.005;
    samples.push({
      frameIndex,
      sourceFrameId,
      edgesPresent: pass,
      maxEdgeColorDelta: Number(maxEdgeColorDelta.toFixed(6)),
      maxBorderColorDelta: Number(maxBorderColorDelta.toFixed(6)),
      maxMatteColorDelta: Number(maxMatteColorDelta.toFixed(6)),
      aspectError: Number(aspectError.toFixed(6)),
      status: pass ? ("pass" as const) : ("fail" as const),
    });
  }
  return {
    status: samples.every((sample) => sample.status === "pass") ? "pass" : "fail",
    borderPx: BORDER_PX,
    expectedContentRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    thresholds: {
      maxEdgeColorDelta: EDGE_DELTA_THRESHOLD,
      maxCompositionColorDelta: COMPOSITION_COLOR_THRESHOLD,
      maxAspectError: 0.005,
    },
    samples,
  };
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, { mode: 0o600 });
}

export async function renderSealedSession(input: {
  artifactRoot: string;
  sessionId: string;
}): Promise<RenderedSealedSession> {
  if (
    !isAbsolute(input.artifactRoot) ||
    input.artifactRoot === "/" ||
    !SESSION_PATTERN.test(input.sessionId)
  ) {
    throw new SealedSessionRenderError("artifact root and session ID must be safe");
  }
  const artifactRoot = resolve(input.artifactRoot);
  const sessionRoot = resolve(artifactRoot, input.sessionId);
  if (!contained(artifactRoot, sessionRoot)) {
    throw new SealedSessionRenderError("session path escapes the artifact root");
  }
  const tree = await verifiedSessionTree(artifactRoot, sessionRoot);
  await readMetadata(sessionRoot, input.sessionId);
  const request = validateRecordingRequest(
    await jsonFile(join(sessionRoot, "request.sanitized.json"), "sanitized request"),
  );
  const origin = new URL(request.url).origin;
  const summary = await readSummary(sessionRoot, input.sessionId, origin);
  const frames = await readFrames(tree, input.sessionId, summary.acceptedFrames);
  const observedEvents = await readObservedEvents(sessionRoot, input.sessionId);
  const observedActions = observedEvents.filter(
    (event): event is Exclude<ObservedEvent, { type: "pointer" }> => event.type !== "pointer",
  );
  const observedPointers = observedEvents.filter(
    (event): event is Extract<ObservedEvent, { type: "pointer" }> => event.type === "pointer",
  );
  const telemetryPath = join(sessionRoot, "telemetry.ndjson");
  await regularFile(telemetryPath, "semantic telemetry");
  const telemetryText = await readFile(telemetryPath, "utf8");
  const semanticEvents =
    telemetryText.length === 0
      ? []
      : validateSessionEvents(
          telemetryText
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown),
        );
  const timeline = cfrFrames(frames);
  const workRoot = join(sessionRoot, `.render-${randomUUID()}`);
  await mkdir(workRoot, { mode: 0o700 });
  try {
    const videoPath = await encode(frames, timeline.slots, workRoot);
    const probe = await probeRenderedVideo(videoPath);
    const expectedDuration = timeline.slots.length / FPS;
    if (
      probe.width !== OUTPUT_WIDTH ||
      probe.height !== OUTPUT_HEIGHT ||
      probe.fps !== FPS ||
      probe.frameCount !== timeline.slots.length ||
      Math.abs(probe.durationSeconds - expectedDuration) > 0.001 ||
      probe.pixelFormat !== "yuv420p" ||
      probe.colorRange !== "tv" ||
      probe.hasAudio
    ) {
      throw new SealedSessionRenderError("encoded video does not meet the CFR delivery contract");
    }
    const qaRoot = join(workRoot, "qa");
    await mkdir(qaRoot, { mode: 0o700 });
    const samplePaths = {
      opening: join(qaRoot, "opening.ppm"),
      midpoint: join(qaRoot, "midpoint.ppm"),
      final: join(qaRoot, "final.ppm"),
    };
    const finalFrameIndex = timeline.slots.length - 1;
    await Promise.all([
      sampleFrame(videoPath, 0, samplePaths.opening),
      sampleFrame(videoPath, Math.floor(finalFrameIndex / 2), samplePaths.midpoint),
      sampleFrame(videoPath, finalFrameIndex, samplePaths.final),
    ]);
    const sampleHashes = {
      opening: await digest(samplePaths.opening),
      midpoint: await digest(samplePaths.midpoint),
      final: await digest(samplePaths.final),
    };
    const distinctSourceFrames = new Set(frames.map((frame) => frame.sha256)).size;
    const distinctSamples = new Set(Object.values(sampleHashes)).size;
    const frozen = distinctSourceFrames < 2 || distinctSamples < 2;
    const actionAlignment = await assessActionAlignment({
      actions: observedActions,
      frames,
      slots: timeline.slots,
      timingMode: timeline.mode,
      videoPath,
      workRoot,
    });
    const clipping = await assessClipping({
      frames,
      slots: timeline.slots,
      samplePaths,
      workRoot,
    });
    const approved =
      timeline.mode === "broker-receipt-offsets" &&
      !frozen &&
      actionAlignment.status === "pass" &&
      clipping.status === "pass";
    const videoSha256 = await digest(videoPath);
    const eventCounts = Object.fromEntries(
      [...new Set(semanticEvents.map((event) => event.type))]
        .sort()
        .map((type) => [type, semanticEvents.filter((event) => event.type === type).length]),
    );
    const manifest = {
      schemaVersion: 1,
      kind: "recordly-codex-delivery",
      sessionId: input.sessionId,
      requestId: request.requestId,
      objective: request.objective,
      target: { origin },
      privacy: {
        targetPath: "omitted",
        query: "omitted",
        fragment: "omitted",
        credentials: "omitted",
        rawFramesExposed: false,
      },
      source: {
        frameCount: frames.length,
        width: (frames[0] as CaptureFrame).width,
        height: (frames[0] as CaptureFrame).height,
        aggregateSha256: createHash("sha256")
          .update(frames.map((frame) => frame.sha256).join("\n"))
          .digest("hex"),
      },
      semanticTelemetry: {
        synchronized: false,
        reason: "semantic events lack a broker receipt offset",
        eventCounts,
      },
      observedActions: observedActions.map((action) =>
        action.type === "click"
          ? {
              type: action.type,
              x: action.data.x,
              y: action.data.y,
              cfrFrameIndex: nearestSlotIndex(timeline.slots, action.receiptOffsetUs),
            }
          : {
              type: action.type,
              x: action.data.x,
              y: action.data.y,
              deltaX: action.data.deltaX,
              deltaY: action.data.deltaY,
              cfrFrameIndex: nearestSlotIndex(timeline.slots, action.receiptOffsetUs),
            },
      ),
      cursorTrack: observedPointers.map((pointer) => ({
        x: pointer.data.x,
        y: pointer.data.y,
        state: pointer.data.cursor,
        cfrFrameIndex: nearestSlotIndex(timeline.slots, pointer.receiptOffsetUs),
      })),
      timeline: {
        schemaVersion: 1,
        fps: FPS,
        frameCount: timeline.slots.length,
        durationUs: Math.round((timeline.slots.length * 1_000_000) / FPS),
        timingMode: timeline.mode,
        slots: timeline.slots,
      },
      render: {
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        codec: "h264",
        pixelFormat: "yuv420p",
        colorRange: "tv",
        audio: false,
        aspectPolicy: "contain",
      },
      artifact: { file: "recording.mp4", sha256: videoSha256 },
    };
    const manifestPath = join(workRoot, "recording-manifest.json");
    await writeCanonical(manifestPath, manifest);
    const manifestSha256 = await digest(manifestPath);
    const quality = {
      schemaVersion: 1,
      kind: "recordly-codex-quality-report",
      status: approved
        ? "approved"
        : timeline.mode === "legacy_ordered_cfr"
          ? "candidate"
          : "blocked",
      timing: {
        mode: timeline.mode,
        eligibleForApproval: timeline.mode === "broker-receipt-offsets",
      },
      probe,
      decodeability: { status: "pass" },
      samples: {
        opening: { file: "qa/opening.ppm", sha256: sampleHashes.opening },
        midpoint: { file: "qa/midpoint.ppm", sha256: sampleHashes.midpoint },
        final: { file: "qa/final.ppm", sha256: sampleHashes.final },
      },
      frozenFrameDetection: {
        status: frozen ? "fail" : "pass",
        distinctSourceFrames,
        distinctSamples,
      },
      actionAlignment,
      clipping,
      finalState: {
        present: true,
        sourceFrameId: (timeline.slots.at(-1) as { sourceFrameId: number }).sourceFrameId,
      },
      artifactHashes: { videoSha256, manifestSha256 },
      privacy: {
        status: "pass",
        targetOriginOnly: true,
        rawFramesExposed: false,
      },
    };
    const qualityReportPath = join(workRoot, "quality-report.json");
    await writeCanonical(qualityReportPath, quality);

    const finalRoot = join(sessionRoot, "artifacts");
    const finalQaRoot = join(finalRoot, "qa");
    await mkdir(finalRoot, { mode: 0o700 });
    for (const path of [
      join(finalRoot, "recording.mp4"),
      join(finalRoot, "recording-manifest.json"),
      join(finalRoot, "quality-report.json"),
      finalQaRoot,
    ]) {
      try {
        await lstat(path);
        throw new SealedSessionRenderError("sealed session already has delivery artifacts");
      } catch (error) {
        if (error instanceof SealedSessionRenderError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const finalVideoPath = join(finalRoot, "recording.mp4");
    const finalManifestPath = join(finalRoot, "recording-manifest.json");
    const finalQualityPath = join(finalRoot, "quality-report.json");
    await rename(videoPath, finalVideoPath);
    await rename(manifestPath, finalManifestPath);
    await rename(qualityReportPath, finalQualityPath);
    await rename(qaRoot, finalQaRoot);
    return {
      videoPath: finalVideoPath,
      manifestPath: finalManifestPath,
      qualityReportPath: finalQualityPath,
      artifactPaths: [finalVideoPath, finalManifestPath, finalQualityPath],
      timingMode: timeline.mode,
      approved,
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
