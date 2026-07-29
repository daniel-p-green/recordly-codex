// biome-ignore-all lint/complexity/useLiteralKeys: sealed evidence is an untrusted persisted boundary.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { validateRecordingRequest, validateSessionEvents } from "../contracts/index.js";
import { resolveMediaExecutable } from "../encoder/ffmpeg.js";
import { probeRenderedVideo } from "../encoder/probe.js";
import { canonicalJson } from "../manifest/index.js";

const execFileAsync = promisify(execFile);
const FPS = 30;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const MAX_FRAMES = FPS * 300;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const FRAME_PATH_PATTERN = /^frames\/raw\/frame-\d{6}\.(?:jpe?g|png)$/u;

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
  sessionRoot: string,
  sessionId: string,
  expectedCount: number,
): Promise<CaptureFrame[]> {
  const eventsPath = join(sessionRoot, "capture-events.jsonl");
  await regularFile(eventsPath, "capture events");
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
    const absolutePath = resolve(sessionRoot, imagePath);
    if (!contained(sessionRoot, absolutePath)) {
      throw new SealedSessionRenderError("capture frame path escapes the sealed session");
    }
    await regularFile(absolutePath, `capture frame ${frameId}`);
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
  await execFileAsync(ffmpeg, [
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
    "-movflags",
    "+faststart",
    "-frames:v",
    String(slots.length),
    "-y",
    outputPath,
  ]);
  await chmod(outputPath, 0o600);
  return outputPath;
}

async function sampleFrame(
  videoPath: string,
  frameIndex: number,
  outputPath: string,
): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
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
  ]);
  await chmod(outputPath, 0o600);
  await regularFile(outputPath, "decoded QA sample");
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
  await ownedDirectory(artifactRoot, "artifact root");
  await ownedDirectory(sessionRoot, "session root");
  await readMetadata(sessionRoot, input.sessionId);
  const request = validateRecordingRequest(
    await jsonFile(join(sessionRoot, "request.sanitized.json"), "sanitized request"),
  );
  const origin = new URL(request.url).origin;
  const summary = await readSummary(sessionRoot, input.sessionId, origin);
  const frames = await readFrames(sessionRoot, input.sessionId, summary.acceptedFrames);
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
    const approved = timeline.mode === "broker-receipt-offsets" && !frozen;
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
      status: approved ? "approved" : frozen ? "blocked" : "candidate",
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
