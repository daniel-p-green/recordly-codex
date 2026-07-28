// biome-ignore-all lint/complexity/useLiteralKeys: Compiler validates exact keys from untrusted recording evidence.
import { createHash } from "node:crypto";

import {
  validateRecordingRequest,
  validateSessionEvents,
  type RecordingRequest,
  type SessionEvent,
} from "../contracts/index.js";
import { canonicalJson } from "../manifest/index.js";
import { normalizeFrameGrid, selectZoomCandidates, type ZoomCandidate } from "../timeline/index.js";
import { CompilationError } from "./errors.js";
import type {
  CompiledRecording,
  CompilerProvenance,
  CompileRecordingInput,
  ImmutableFrameHash,
  QaPrecondition,
  QualityAssessment,
  RecordingManifest,
  RenderTimeline,
} from "./types.js";

const sha256Pattern = /^[a-f0-9]{64}$/iu;

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompilationError(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  location: string,
): void {
  if (
    Object.keys(object).length !== keys.length ||
    Object.keys(object).some((key) => !keys.includes(key))
  ) {
    throw new CompilationError(`${location} must contain exactly: ${keys.join(", ")}`);
  }
}

function text(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    throw new CompilationError(`${location} must be safe bounded text`);
  }
  return value;
}

function containedFramePath(value: unknown, location: string): string {
  const imagePath = text(value, location);
  const segments = imagePath.split("/");
  if (
    !imagePath.startsWith("frames/raw/") ||
    imagePath.startsWith("/") ||
    imagePath.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new CompilationError(`${location} must be a contained frames/raw artifact path`);
  }
  return imagePath;
}

function sha256(value: unknown, location: string): string {
  const hash = text(value, location);
  if (!sha256Pattern.test(hash)) throw new CompilationError(`${location} must be a SHA-256 hash`);
  return hash.toLowerCase();
}

function validateFrameHashes(values: readonly unknown[]): ImmutableFrameHash[] {
  const frameHashes = values.map((value, index) => {
    const frame = asObject(value, `frameHashes[${index}]`);
    assertExactKeys(frame, ["frameId", "imagePath", "sha256"], `frameHashes[${index}]`);
    if (!Number.isSafeInteger(frame["frameId"]) || (frame["frameId"] as number) < 1) {
      throw new CompilationError(`frameHashes[${index}].frameId must be a positive safe integer`);
    }
    return {
      frameId: frame["frameId"] as number,
      imagePath: containedFramePath(frame["imagePath"], `frameHashes[${index}].imagePath`),
      sha256: sha256(frame["sha256"], `frameHashes[${index}].sha256`),
    };
  });
  const ids = new Set<number>();
  const paths = new Set<string>();
  for (const frame of frameHashes) {
    if (ids.has(frame.frameId) || paths.has(frame.imagePath)) {
      throw new CompilationError("frame hashes must have unique frame IDs and artifact paths");
    }
    ids.add(frame.frameId);
    paths.add(frame.imagePath);
  }
  return frameHashes.sort(
    (left, right) => left.frameId - right.frameId || left.imagePath.localeCompare(right.imagePath),
  );
}

function validateProvenance(value: unknown): CompilerProvenance {
  const provenance = asObject(value, "provenance");
  assertExactKeys(provenance, ["environment", "renderer"], "provenance");
  const environment = asObject(provenance["environment"], "provenance.environment");
  assertExactKeys(
    environment,
    ["codexSurface", "browserProtocol", "runtime"],
    "provenance.environment",
  );
  if (environment["codexSurface"] !== "desktop-browser") {
    throw new CompilationError("provenance.environment.codexSurface must be desktop-browser");
  }
  const renderer = asObject(provenance["renderer"], "provenance.renderer");
  assertExactKeys(
    renderer,
    ["name", "version", "profile", "implementationSha256"],
    "provenance.renderer",
  );
  return {
    environment: {
      codexSurface: "desktop-browser",
      browserProtocol: text(
        environment["browserProtocol"],
        "provenance.environment.browserProtocol",
      ),
      runtime: text(environment["runtime"], "provenance.environment.runtime"),
    },
    renderer: {
      name: text(renderer["name"], "provenance.renderer.name"),
      version: text(renderer["version"], "provenance.renderer.version"),
      profile: text(renderer["profile"], "provenance.renderer.profile"),
      implementationSha256: sha256(
        renderer["implementationSha256"],
        "provenance.renderer.implementationSha256",
      ),
    },
  };
}

function target(request: RecordingRequest): { origin: string; path: string } {
  const parsed = new URL(request.url);
  return { origin: parsed.origin, path: parsed.pathname };
}

function verifyFrameEvidence(
  events: readonly SessionEvent[],
  frameHashes: readonly ImmutableFrameHash[],
): void {
  const expected = new Map(frameHashes.map((frame) => [frame.frameId, frame]));
  const seen = new Set<number>();
  for (const event of events) {
    if (event.type !== "frame") continue;
    const frameId = event.data["frameId"] as number;
    const frame = expected.get(frameId);
    if (frame === undefined)
      throw new CompilationError(`frame ${frameId} has no immutable hash evidence`);
    if (seen.has(frameId))
      throw new CompilationError(`frame ${frameId} is repeated in the event stream`);
    if (event.data["imagePath"] !== frame.imagePath || event.data["sha256"] !== frame.sha256) {
      throw new CompilationError(`frame ${frameId} does not match immutable hash evidence`);
    }
    seen.add(frameId);
  }
  if (seen.size !== frameHashes.length) {
    throw new CompilationError("every immutable frame hash must match exactly one frame event");
  }
}

function verifyNavigationOrigins(events: readonly SessionEvent[], request: RecordingRequest): void {
  for (const event of events) {
    if (event.type !== "navigation") continue;
    const origin = event.data["origin"] as string;
    if (!request.policy.allowedOrigins.includes(origin)) {
      throw new CompilationError(`navigation origin is not approved: ${origin}`);
    }
  }
}

function buildTracks(
  events: readonly SessionEvent[],
): Pick<RenderTimeline, "cursorTrack" | "clickTrack" | "zoomCandidates"> {
  const cursorTrack: RenderTimeline["cursorTrack"] = [];
  const clickTrack: RenderTimeline["clickTrack"] = [];
  const candidates: ZoomCandidate[] = [];
  let cursor: { x: number; y: number } | undefined;
  const markerIds = new Set<string>();
  for (const event of events) {
    if (event.type === "pointer") {
      const point = {
        tUs: event.tUs,
        x: event.data["x"] as number,
        y: event.data["y"] as number,
        buttons: event.data["buttons"] as number,
        source: event.data["source"] as "planned" | "observed",
      };
      cursorTrack.push(point);
      cursor = point;
      continue;
    }
    if (event.type === "click") {
      const click: RenderTimeline["clickTrack"][number] = {
        tUs: event.tUs,
        x: event.data["x"] as number,
        y: event.data["y"] as number,
        button: event.data["button"] as 0 | 1 | 2,
      };
      const targetLabel = event.data["targetLabel"];
      if (typeof targetLabel === "string") click.targetLabel = targetLabel;
      clickTrack.push(click);
      candidates.push({
        id: `click:${event.seq}`,
        tUs: event.tUs,
        kind: "click",
        x: click.x,
        y: click.y,
      });
      cursor = click;
      continue;
    }
    if (event.type === "scroll") {
      candidates.push({
        id: `scroll:${event.seq}`,
        tUs: event.tUs,
        kind: "scroll",
        x: event.data["x"] as number,
        y: event.data["y"] as number,
      });
      continue;
    }
    if (event.type === "marker" && cursor !== undefined) {
      const marker = event.data["id"] as string;
      const id = markerIds.has(marker) ? `marker:${marker}:${event.seq}` : `marker:${marker}`;
      markerIds.add(marker);
      candidates.push({ id, tUs: event.tUs, kind: "marker", x: cursor.x, y: cursor.y });
    }
  }
  return { cursorTrack, clickTrack, zoomCandidates: selectZoomCandidates(candidates) };
}

function qualityAssessment(
  events: readonly SessionEvent[],
  slots: RenderTimeline["cfrSlots"],
  cadenceGapCount: number,
): QualityAssessment {
  const preconditions: QaPrecondition[] = [];
  preconditions.push({
    id: "frame-coverage",
    status: slots.some((slot) => slot.sourceFrameId === undefined) ? "fail" : "pass",
    reason: slots.some((slot) => slot.sourceFrameId === undefined)
      ? "one or more constant-frame-rate slots have no captured source frame"
      : "every constant-frame-rate slot has captured evidence",
  });
  preconditions.push({
    id: "frame-cadence",
    status: cadenceGapCount > 0 ? "warn" : "pass",
    reason:
      cadenceGapCount > 0
        ? "capture cadence gaps exceed 500ms"
        : "capture cadence has no gaps above 500ms",
  });
  const health = events.filter((event) => event.type === "capture_health");
  const failedHealth = health.some(
    (event) =>
      (event.data["queueOccupancy"] as number) >= 1 ||
      (event.data["ackLatencyUs"] as number) > 1_000_000,
  );
  const warnedHealth =
    health.length === 0 ||
    health.some(
      (event) =>
        (event.data["queueOccupancy"] as number) >= 0.8 ||
        (event.data["ackLatencyUs"] as number) > 250_000,
    );
  preconditions.push({
    id: "capture-health",
    status: failedHealth ? "fail" : warnedHealth ? "warn" : "pass",
    reason: failedHealth
      ? "capture telemetry exceeded hard queue or acknowledgement limits"
      : warnedHealth
        ? "capture telemetry is missing or approaching limits"
        : "capture telemetry remained within limits",
  });
  preconditions.push({
    id: "navigation",
    status: "pass",
    reason: "all recorded navigations are on approved origins",
  });
  return {
    status: preconditions.some((precondition) => precondition.status === "fail")
      ? "blocked"
      : "ready",
    preconditions,
  };
}

function outputHash(value: unknown): { canonical: string; sha256: string } {
  const canonical = canonicalJson(value);
  return { canonical, sha256: createHash("sha256").update(canonical, "utf8").digest("hex") };
}

export function compileRecording(input: CompileRecordingInput): CompiledRecording {
  const request = validateRecordingRequest(input.request);
  const events = validateSessionEvents(input.events);
  if (events.length === 0)
    throw new CompilationError("a recording requires at least one session event");
  const frameHashes = validateFrameHashes(input.frameHashes);
  if (frameHashes.length === 0)
    throw new CompilationError("a recording requires immutable frame hashes");
  const provenance = validateProvenance(input.provenance);
  verifyFrameEvidence(events, frameHashes);
  verifyNavigationOrigins(events, request);

  const frames = events
    .filter((event) => event.type === "frame")
    .map((event) => ({ frameId: event.data["frameId"] as number, tUs: event.tUs }));
  const durationUs = (events.at(-1) as SessionEvent).tUs + 1;
  const grid = normalizeFrameGrid(frames, { fps: request.output.fps, durationUs });
  const tracks = buildTracks(events);
  const manifest: RecordingManifest = {
    schemaVersion: 1,
    request: {
      requestId: request.requestId,
      objective: request.objective,
      target: target(request),
    },
    sessionId: events[0]?.sessionId as string,
    provenance,
    redactions: { query: "omitted", fragment: "omitted", credentials: "omitted" },
    artifacts: frameHashes,
    events,
  };
  const timeline: RenderTimeline = {
    schemaVersion: 1,
    requestId: request.requestId,
    sessionId: events[0]?.sessionId as string,
    durationUs,
    fps: request.output.fps,
    cfrSlots: grid.slots,
    ...tracks,
    qa: qualityAssessment(events, grid.slots, grid.health.cadenceGaps.length),
  };
  const manifestOutput = outputHash(manifest);
  const timelineOutput = outputHash(timeline);
  return {
    manifest,
    timeline,
    canonical: { manifest: manifestOutput.canonical, timeline: timelineOutput.canonical },
    hashes: { manifestSha256: manifestOutput.sha256, timelineSha256: timelineOutput.sha256 },
  };
}
