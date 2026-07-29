// biome-ignore-all lint/complexity/useLiteralKeys: Persisted session evidence is untrusted dictionary data.
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type RecordingRequest,
  type SessionEvent,
  validateRecordingRequest,
  validateSessionEvent,
  validateSessionEvents,
} from "../contracts/index.js";
import { canonicalJson } from "../manifest/index.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type SessionState = "active" | "sealed";

export type SessionPaths = {
  root: string;
  metadata: string;
  request: string;
  captureConfig: string;
  rawCaptureEvents: string;
  telemetry: string;
  startWrapper: string;
  stopWrapper: string;
  captureSummary: string;
};

export type SessionInspection = {
  sessionId: string;
  state: SessionState;
  eventCount: number;
  frameCount: number;
  /** Whether raw capture frames carry broker-owned timing suitable for production rendering. */
  rawCaptureTiming: "absent" | "legacy" | "broker-receipt-offsets";
  paths: SessionPaths;
};

/**
 * The broker-owned raw-frame evidence schema. `receiptOffsetUs` is sampled by
 * the local broker, relative to the first accepted frame, never by the page.
 */
export type BrokerCaptureFrameEvent = {
  sessionId: string;
  type: "frame";
  frameId: number;
  receiptOffsetUs: number;
  imagePath: string;
  sha256: string;
  width: number;
  height: number;
};

export type RawCaptureTiming = SessionInspection["rawCaptureTiming"];

export type FileStat = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export interface SessionFileSystem {
  mkdir(path: string, options: { recursive?: boolean; mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, options: { mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  lstat(path: string): Promise<FileStat>;
  rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export type SessionStoreOptions = {
  root: string;
  browserHelperRoot: string;
  ownerToken: string;
  runtimeModulePath: string;
  clockUs: () => number;
  idSource: () => string;
  fileSystem: SessionFileSystem;
};

type PersistedSession = {
  schemaVersion: 1;
  sessionId: string;
  ownerToken: string;
  state: SessionState;
  createdAtUs: number;
  sealedAtUs?: number;
};

type BrowserCaptureSummary = {
  schemaVersion: 1;
  sessionId: string;
  origin: string;
  status: "stopped" | "failed";
  receivedFrames: number;
  acceptedFrames: number;
  ackedFrames: number;
  rejectedFrames: number;
  degradationRequested: boolean;
  reason?: string;
};

export class SessionStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionStoreError";
  }
}

function safeText(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    throw new SessionStoreError(`${field} must be safe bounded text`);
  }
  return value;
}

function assertSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId)) throw new SessionStoreError("session ID must be safe");
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionStoreError(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asSafeInteger(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SessionStoreError(`${location} must be a non-negative safe integer`);
  }
  return value as number;
}

/** Non-throwing reader guard so legacy raw evidence remains inspectable. */
export function isBrokerCaptureFrameEvent(value: unknown): value is BrokerCaptureFrameEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const expected = [
    "sessionId",
    "type",
    "frameId",
    "receiptOffsetUs",
    "imagePath",
    "sha256",
    "width",
    "height",
  ];
  if (Object.keys(event).length !== expected.length || expected.some((key) => !(key in event))) {
    return false;
  }
  if (typeof event["sessionId"] !== "string" || !sessionIdPattern.test(event["sessionId"])) {
    return false;
  }
  if (event["type"] !== "frame") return false;
  if (
    !Number.isSafeInteger(event["frameId"]) ||
    (event["frameId"] as number) < 1 ||
    !Number.isSafeInteger(event["receiptOffsetUs"]) ||
    (event["receiptOffsetUs"] as number) < 0 ||
    !Number.isSafeInteger(event["width"]) ||
    (event["width"] as number) < 1 ||
    !Number.isSafeInteger(event["height"]) ||
    (event["height"] as number) < 1
  ) {
    return false;
  }
  const imagePath = event["imagePath"];
  const sha256 = event["sha256"];
  return (
    typeof imagePath === "string" &&
    imagePath.startsWith("frames/raw/") &&
    !imagePath.includes("..") &&
    !imagePath.startsWith("/") &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/iu.test(sha256)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function runtimeSpecifier(value: string): string {
  safeText(value, "runtime module path");
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") return parsed.href;
  } catch {
    // Absolute filesystem paths are made deterministic file URLs below.
  }
  if (!isAbsolute(value)) {
    throw new SessionStoreError("runtime module path must be a file URL or absolute path");
  }
  return pathToFileURL(resolve(value)).href;
}

/**
 * A filesystem-only session boundary. The caller supplies all machine-specific
 * dependencies so browser, MCP, and runtime wiring remain outside this module.
 */
export class SessionStore {
  private readonly root: string;
  private readonly browserHelperRoot: string;
  private readonly runtimeModuleSpecifier: string;
  private writeSequence = 0;

  public constructor(private readonly options: SessionStoreOptions) {
    if (!isAbsolute(options.root)) throw new SessionStoreError("session root must be absolute");
    this.root = resolve(options.root);
    if (!isAbsolute(options.browserHelperRoot)) {
      throw new SessionStoreError("browser helper root must be absolute");
    }
    this.browserHelperRoot = resolve(options.browserHelperRoot);
    if (this.browserHelperRoot === this.root) {
      throw new SessionStoreError("browser helper root must be separate from session root");
    }
    safeText(options.ownerToken, "owner token");
    this.runtimeModuleSpecifier = runtimeSpecifier(options.runtimeModulePath);
  }

  public async createSession(requestInput: unknown): Promise<SessionInspection> {
    const request = validateRecordingRequest(requestInput);
    await this.ensureRoot();
    await this.ensureBrowserHelperRoot();
    const sessionId = this.options.idSource();
    assertSessionId(sessionId);
    const paths = this.paths(sessionId);
    const browserSessionRoot = this.browserSessionRoot(sessionId);
    let sessionDirectoryCreated = false;
    let browserDirectoryCreated = false;
    try {
      await this.options.fileSystem.mkdir(paths.root, { mode: DIRECTORY_MODE });
      sessionDirectoryCreated = true;
      await this.assertOwnedDirectory(paths.root);
      await this.options.fileSystem.mkdir(browserSessionRoot, { mode: DIRECTORY_MODE });
      browserDirectoryCreated = true;
      await this.assertOwnedDirectory(browserSessionRoot);
      const createdAtUs = this.nowUs();
      const metadata: PersistedSession = {
        schemaVersion: 1,
        sessionId,
        ownerToken: this.options.ownerToken,
        state: "active",
        createdAtUs,
      };
      await this.writeAtomically(paths.metadata, canonicalJson(metadata));
      await this.writeAtomically(paths.request, canonicalJson(request));
      await this.writeAtomically(
        paths.captureConfig,
        canonicalJson({
          schemaVersion: 1,
          sessionId,
          rootPrefix: this.root,
          rootPath: paths.root,
          allowedOrigins: request.policy.allowedOrigins,
          format: "jpeg",
          quality: 90,
        }),
      );
      await this.writeAtomically(paths.telemetry, "");
      await this.writeAtomically(paths.startWrapper, this.wrapper("start", paths.captureConfig));
      await this.writeAtomically(paths.stopWrapper, this.wrapper("stop", paths.captureConfig));
    } catch (error) {
      if (browserDirectoryCreated) await this.removeOwnedDirectory(browserSessionRoot);
      if (sessionDirectoryCreated) await this.removeOwnedDirectory(paths.root);
      throw error;
    }
    return {
      sessionId,
      state: "active",
      eventCount: 0,
      frameCount: 0,
      rawCaptureTiming: "absent",
      paths,
    };
  }

  public async appendEvent(sessionId: string, eventInput: unknown): Promise<SessionInspection> {
    const event = validateSessionEvent(eventInput);
    const loaded = await this.load(sessionId);
    if (loaded.metadata.state !== "active") throw new SessionStoreError("session must be active");
    if (event.sessionId !== sessionId)
      throw new SessionStoreError("event session must match session ID");
    const nextEvents = [...loaded.events, event];
    validateSessionEvents(nextEvents);
    await this.writeAtomically(
      loaded.paths.telemetry,
      nextEvents
        .map((item) => canonicalJson(item))
        .join("\n")
        .concat("\n"),
    );
    return this.inspection(
      loaded.metadata,
      nextEvents,
      loaded.paths,
      undefined,
      await this.rawCaptureTiming(loaded.paths),
    );
  }

  public async inspect(sessionId: string): Promise<SessionInspection> {
    const loaded = await this.load(sessionId);
    const request = await this.readRequest(loaded.paths);
    const summary = await this.readBrowserSummary(loaded.paths, request, sessionId, false);
    return this.inspection(
      loaded.metadata,
      loaded.events,
      loaded.paths,
      summary,
      await this.rawCaptureTiming(loaded.paths),
    );
  }

  public async seal(sessionId: string): Promise<SessionInspection> {
    const loaded = await this.load(sessionId);
    if (loaded.metadata.state !== "active")
      throw new SessionStoreError("session must be active to seal");
    const request = await this.readRequest(loaded.paths);
    const summary = await this.readBrowserSummary(loaded.paths, request, sessionId, true);
    if (summary === undefined)
      throw new SessionStoreError("capture summary is required before sealing");
    if (summary.status !== "stopped" || summary.reason !== undefined) {
      throw new SessionStoreError("capture summary does not report a successful stopped capture");
    }
    if (
      summary.acceptedFrames === 0 ||
      summary.ackedFrames !== summary.acceptedFrames ||
      summary.rejectedFrames !== 0
    ) {
      throw new SessionStoreError("capture summary does not prove complete frame evidence");
    }
    const sealedAtUs = this.nowUs();
    const metadata: PersistedSession = { ...loaded.metadata, state: "sealed", sealedAtUs };
    await this.writeAtomically(loaded.paths.metadata, canonicalJson(metadata));
    return this.inspection(
      metadata,
      loaded.events,
      loaded.paths,
      summary,
      await this.rawCaptureTiming(loaded.paths),
    );
  }

  public async discard(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.assertOwnedDirectory(paths.root);
    await this.assertSessionEvidence(paths);
    const metadata = await this.readMetadata(paths);
    if (metadata.ownerToken !== this.options.ownerToken) {
      throw new SessionStoreError("session is not owned by this process");
    }
    const browserSessionRoot = this.browserSessionRoot(sessionId);
    await this.assertOwnedDirectory(browserSessionRoot);
    await this.options.fileSystem.rm(browserSessionRoot, { recursive: true, force: false });
    await this.options.fileSystem.rm(paths.root, { recursive: true, force: false });
  }

  private async load(sessionId: string): Promise<{
    metadata: PersistedSession;
    events: SessionEvent[];
    paths: SessionPaths;
  }> {
    assertSessionId(sessionId);
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.assertOwnedDirectory(paths.root);
    await this.assertSessionEvidence(paths);
    const metadata = await this.readMetadata(paths);
    if (metadata.sessionId !== sessionId)
      throw new SessionStoreError("session metadata ID does not match path");
    if (metadata.ownerToken !== this.options.ownerToken) {
      throw new SessionStoreError("session is not owned by this process");
    }
    const events = await this.readEvents(paths.telemetry);
    return { metadata, events, paths };
  }

  private async ensureRoot(): Promise<void> {
    await this.options.fileSystem.mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    await this.assertOwnedDirectory(this.root);
    await this.options.fileSystem.chmod(this.root, DIRECTORY_MODE);
    await this.assertOwnedDirectory(this.root);
  }

  private async ensureBrowserHelperRoot(): Promise<void> {
    const parent = resolve(this.browserHelperRoot, "..");
    await this.options.fileSystem.mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
    await this.assertOwnedDirectory(parent);
    await this.options.fileSystem.mkdir(this.browserHelperRoot, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    await this.assertOwnedDirectory(this.browserHelperRoot);
    await this.options.fileSystem.chmod(this.browserHelperRoot, DIRECTORY_MODE);
    await this.assertOwnedDirectory(this.browserHelperRoot);
  }

  private paths(sessionId: string): SessionPaths {
    const root = this.containedPath(sessionId);
    return {
      root,
      metadata: this.containedPath(sessionId, "session.json"),
      request: this.containedPath(sessionId, "request.sanitized.json"),
      captureConfig: this.containedPath(sessionId, "capture-config.json"),
      rawCaptureEvents: this.containedPath(sessionId, "capture-events.jsonl"),
      telemetry: this.containedPath(sessionId, "telemetry.ndjson"),
      startWrapper: this.browserHelperPath(sessionId, "browser-start.mjs"),
      stopWrapper: this.browserHelperPath(sessionId, "browser-stop.mjs"),
      captureSummary: this.containedPath(sessionId, "capture-summary.json"),
    };
  }

  private containedPath(sessionId: string, leaf?: string): string {
    assertSessionId(sessionId);
    const target = resolve(this.root, sessionId, leaf ?? "");
    const relativeTarget = relative(this.root, target);
    if (
      relativeTarget === "" ||
      (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))
    ) {
      return target;
    }
    throw new SessionStoreError("session path escapes configured root");
  }

  private browserSessionRoot(sessionId: string): string {
    return this.browserHelperPath(sessionId);
  }

  private browserHelperPath(sessionId: string, leaf?: string): string {
    assertSessionId(sessionId);
    const target = resolve(this.browserHelperRoot, sessionId, leaf ?? "");
    const relativeTarget = relative(this.browserHelperRoot, target);
    if (
      relativeTarget === "" ||
      (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))
    ) {
      return target;
    }
    throw new SessionStoreError("browser helper path escapes configured root");
  }

  private async assertOwnedDirectory(path: string): Promise<void> {
    const stat = await this.options.fileSystem.lstat(path);
    if (stat.isSymbolicLink())
      throw new SessionStoreError("session path cannot be a symbolic link");
    if (!stat.isDirectory()) throw new SessionStoreError("session path must be a directory");
  }

  private async removeOwnedDirectory(path: string): Promise<void> {
    try {
      await this.assertOwnedDirectory(path);
      await this.options.fileSystem.rm(path, { recursive: true, force: false });
    } catch {
      // Preserve the original create error and never remove an unverified path.
    }
  }

  private async assertRegularFile(path: string, label: string): Promise<void> {
    const stat = await this.options.fileSystem.lstat(path);
    if (stat.isSymbolicLink()) throw new SessionStoreError(`${label} cannot be a symbolic link`);
    if (!stat.isFile()) throw new SessionStoreError(`${label} must be a regular file`);
  }

  private async assertOptionalRegularFile(path: string, label: string): Promise<boolean> {
    try {
      await this.assertRegularFile(path, label);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async assertSessionEvidence(paths: SessionPaths): Promise<void> {
    await Promise.all([
      this.assertRegularFile(paths.metadata, "session metadata"),
      this.assertRegularFile(paths.request, "sanitized request"),
      this.assertRegularFile(paths.telemetry, "telemetry evidence"),
      this.assertRegularFile(paths.captureConfig, "capture configuration"),
      this.assertRegularFile(paths.startWrapper, "browser start wrapper"),
      this.assertRegularFile(paths.stopWrapper, "browser stop wrapper"),
    ]);
    await this.assertOptionalRegularFile(paths.captureSummary, "capture summary");
    await this.assertOptionalRegularFile(paths.rawCaptureEvents, "raw capture events");
  }

  private async readMetadata(paths: SessionPaths): Promise<PersistedSession> {
    await this.assertRegularFile(paths.metadata, "session metadata");
    const value = this.parseJson(
      await this.options.fileSystem.readFile(paths.metadata),
      "session metadata",
    );
    const metadata = asObject(value, "session metadata");
    const keys = Object.keys(metadata).sort();
    const allowed = [
      "createdAtUs",
      "ownerToken",
      "schemaVersion",
      "sealedAtUs",
      "sessionId",
      "state",
    ];
    if (keys.some((key) => !allowed.includes(key)))
      throw new SessionStoreError("session metadata has unknown fields");
    if (metadata["schemaVersion"] !== 1)
      throw new SessionStoreError("session metadata version is unsupported");
    const sessionId = metadata["sessionId"];
    const ownerToken = metadata["ownerToken"];
    const state = metadata["state"];
    if (typeof sessionId !== "string")
      throw new SessionStoreError("session metadata ID is invalid");
    assertSessionId(sessionId);
    if (typeof ownerToken !== "string")
      throw new SessionStoreError("session metadata owner is invalid");
    safeText(ownerToken, "session metadata owner");
    if (state !== "active" && state !== "sealed")
      throw new SessionStoreError("session state is invalid");
    const createdAtUs = asSafeInteger(metadata["createdAtUs"], "session metadata createdAtUs");
    const sealedAtUs = metadata["sealedAtUs"];
    if (sealedAtUs !== undefined) asSafeInteger(sealedAtUs, "session metadata sealedAtUs");
    if (state === "active" && sealedAtUs !== undefined) {
      throw new SessionStoreError("active session cannot have a sealed timestamp");
    }
    if (state === "sealed" && sealedAtUs === undefined) {
      throw new SessionStoreError("sealed session requires a sealed timestamp");
    }
    return sealedAtUs === undefined
      ? { schemaVersion: 1, sessionId, ownerToken, state, createdAtUs }
      : {
          schemaVersion: 1,
          sessionId,
          ownerToken,
          state,
          createdAtUs,
          sealedAtUs: sealedAtUs as number,
        };
  }

  private async readEvents(path: string): Promise<SessionEvent[]> {
    await this.assertRegularFile(path, "telemetry evidence");
    const content = await this.options.fileSystem.readFile(path);
    if (content.length === 0) return [];
    const lines = content.split("\n");
    if (lines.at(-1) !== "")
      throw new SessionStoreError("telemetry evidence must end with a newline");
    const events = lines.slice(0, -1).map((line, index) => {
      const value = this.parseJson(line, `telemetry line ${index + 1}`);
      const event = validateSessionEvent(value);
      if (canonicalJson(event) !== line) {
        throw new SessionStoreError("telemetry evidence must be canonical JSON");
      }
      return event;
    });
    return validateSessionEvents(events);
  }

  private async readRequest(paths: SessionPaths): Promise<RecordingRequest> {
    await this.assertRegularFile(paths.request, "sanitized request");
    return validateRecordingRequest(
      this.parseJson(await this.options.fileSystem.readFile(paths.request), "sanitized request"),
    );
  }

  private async readBrowserSummary(
    paths: SessionPaths,
    request: RecordingRequest,
    sessionId: string,
    required: boolean,
  ): Promise<BrowserCaptureSummary | undefined> {
    const hasSummary = await this.assertOptionalRegularFile(
      paths.captureSummary,
      "capture summary",
    );
    if (!hasSummary) {
      if (!required) return undefined;
      throw new SessionStoreError("capture summary is required before sealing");
    }
    const content = await this.options.fileSystem.readFile(paths.captureSummary);
    const summary = asObject(this.parseJson(content, "capture summary"), "capture summary");
    const keys = Object.keys(summary).sort();
    const allowed = [
      "acceptedFrames",
      "ackedFrames",
      "degradationRequested",
      "origin",
      "reason",
      "receivedFrames",
      "rejectedFrames",
      "schemaVersion",
      "sessionId",
      "status",
    ];
    if (keys.some((key) => !allowed.includes(key)))
      throw new SessionStoreError("capture summary has unknown fields");
    if (summary["schemaVersion"] !== 1)
      throw new SessionStoreError("capture summary version is unsupported");
    if (typeof summary["sessionId"] !== "string")
      throw new SessionStoreError("capture summary session is invalid");
    assertSessionId(summary["sessionId"]);
    if (summary["sessionId"] !== sessionId)
      throw new SessionStoreError("capture summary session does not match session ID");
    if (typeof summary["origin"] !== "string")
      throw new SessionStoreError("capture summary origin is invalid");
    const expectedOrigin = new URL(request.url).origin;
    if (summary["origin"] !== expectedOrigin)
      throw new SessionStoreError("capture summary origin does not match request");
    if (summary["status"] !== "stopped" && summary["status"] !== "failed")
      throw new SessionStoreError("capture summary status is invalid");
    if (typeof summary["degradationRequested"] !== "boolean")
      throw new SessionStoreError("capture summary degradation is invalid");
    const receivedFrames = asSafeInteger(
      summary["receivedFrames"],
      "capture summary receivedFrames",
    );
    const acceptedFrames = asSafeInteger(
      summary["acceptedFrames"],
      "capture summary acceptedFrames",
    );
    const ackedFrames = asSafeInteger(summary["ackedFrames"], "capture summary ackedFrames");
    const rejectedFrames = asSafeInteger(
      summary["rejectedFrames"],
      "capture summary rejectedFrames",
    );
    if (acceptedFrames > receivedFrames || ackedFrames > acceptedFrames) {
      throw new SessionStoreError("capture summary counts are inconsistent");
    }
    const reason = summary["reason"];
    if (reason !== undefined) {
      if (typeof reason !== "string")
        throw new SessionStoreError("capture summary reason is invalid");
      safeText(reason, "capture summary reason");
    }
    return reason === undefined
      ? {
          schemaVersion: 1,
          sessionId,
          origin: expectedOrigin,
          status: summary["status"],
          receivedFrames,
          acceptedFrames,
          ackedFrames,
          rejectedFrames,
          degradationRequested: summary["degradationRequested"],
        }
      : {
          schemaVersion: 1,
          sessionId,
          origin: expectedOrigin,
          status: summary["status"],
          receivedFrames,
          acceptedFrames,
          ackedFrames,
          rejectedFrames,
          degradationRequested: summary["degradationRequested"],
          reason,
        };
  }

  private async rawCaptureTiming(paths: SessionPaths): Promise<RawCaptureTiming> {
    if (!(await this.assertOptionalRegularFile(paths.rawCaptureEvents, "raw capture events"))) {
      return "absent";
    }
    const lines = (await this.options.fileSystem.readFile(paths.rawCaptureEvents))
      .split("\n")
      .filter(Boolean);
    const frames: BrokerCaptureFrameEvent[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as unknown;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const candidate = value as Record<string, unknown>;
          if (candidate["type"] === "frame") {
            if (!isBrokerCaptureFrameEvent(candidate)) return "legacy";
            frames.push(candidate);
          }
        }
      } catch {
        return "legacy";
      }
    }
    if (frames.length === 0) return lines.length === 0 ? "absent" : "legacy";
    let previousOffsetUs = -1;
    for (const frame of frames) {
      if (frame.receiptOffsetUs <= previousOffsetUs) return "legacy";
      previousOffsetUs = frame.receiptOffsetUs;
    }
    return "broker-receipt-offsets";
  }

  private parseJson(content: string, location: string): unknown {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new SessionStoreError(`${location} must be valid JSON`);
    }
  }

  private async writeAtomically(path: string, content: string): Promise<void> {
    this.writeSequence += 1;
    const temporary = `${path}.tmp-${this.writeSequence}`;
    await this.options.fileSystem.writeFile(temporary, content, { mode: FILE_MODE });
    await this.options.fileSystem.rename(temporary, path);
  }

  private inspection(
    metadata: PersistedSession,
    events: readonly SessionEvent[],
    paths: SessionPaths,
    summary?: BrowserCaptureSummary,
    rawCaptureTiming: RawCaptureTiming = "absent",
  ): SessionInspection {
    return {
      sessionId: metadata.sessionId,
      state: metadata.state,
      eventCount: events.length,
      frameCount:
        summary?.acceptedFrames ?? events.filter((event) => event.type === "frame").length,
      rawCaptureTiming,
      paths,
    };
  }

  private nowUs(): number {
    const now = this.options.clockUs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new SessionStoreError("clock must return a non-negative safe integer");
    }
    return now;
  }

  private wrapper(operation: "start" | "stop", configPath: string): string {
    const runtime = JSON.stringify(this.runtimeModuleSpecifier);
    const functionName = operation === "start" ? "startBrowserCapture" : "stopBrowserCapture";
    return [
      "async (page) => {",
      `  const { ${functionName} } = await import(${runtime});`,
      `  return ${functionName}(page, ${JSON.stringify(configPath)});`,
      "}",
      "",
    ].join("\n");
  }
}
