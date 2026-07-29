// biome-ignore-all lint/complexity/useLiteralKeys: persisted broker state is untrusted dictionary data.
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  type RecordingRequest,
  validateRecordingRequest,
  validateSessionEvent,
} from "../src/contracts/index.js";
import { type RenderedSealedSession, renderSealedSession } from "../src/render/sealed-session.js";
import {
  type SessionFileSystem,
  type SessionInspection,
  SessionStore,
} from "../src/session/index.js";
import { browserStartHelper, browserStopHelper } from "./browser-helper.js";
import { type CaptureBroker, createCaptureBroker } from "./capture-broker.js";
import { RecordingServiceUnavailableError } from "./handlers.js";
import type {
  RecordingSessionService,
  RecordingSessionView,
  SemanticBrowserEvent,
} from "./types.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ownerTokenName = ".recordly-codex-owner-token";
const sessionLocks = new Map<string, Promise<void>>();
const activeCaptureBrokers = new Map<string, CaptureBroker>();

type SessionStoreServiceOptions = {
  artifactRoot?: string;
  idSource?: () => string;
  clockUs?: () => number;
};

type ServiceContext = {
  projectRoot: string;
  store: SessionStore;
  clockUs: () => number;
};

type BrokerState = {
  schemaVersion: 1;
  sessionId: string;
  origin: string;
  phase: "ready" | "claimed" | "running" | "stopped" | "failed";
};

function nodeFileSystem(): SessionFileSystem {
  return {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    chmod,
    readFile: async (path) => readFile(path, "utf8"),
    writeFile: async (path, content, options) => writeFile(path, content, options),
    rename,
    lstat: async (path) => {
      const status = await lstat(path);
      return {
        isDirectory: () => status.isDirectory(),
        isFile: () => status.isFile(),
        isSymbolicLink: () => status.isSymbolicLink(),
      };
    },
    rm,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function validArtifactRoot(value: string): string {
  if (!isAbsolute(value) || value === "/" || value.includes("\\") || value.includes("..")) {
    throw new RecordingServiceUnavailableError();
  }
  return resolve(value);
}

function defaultArtifactRoot(): string {
  const configured = process.env["RECORDLY_CODEX_ARTIFACT_ROOT"];
  return validArtifactRoot(
    configured === undefined ? join(tmpdir(), "recordly-codex") : configured,
  );
}

async function readOrCreateOwnerToken(artifactRoot: string): Promise<string> {
  await mkdir(artifactRoot, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(artifactRoot, DIRECTORY_MODE);
  const directory = await lstat(artifactRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new RecordingServiceUnavailableError();
  const tokenPath = join(artifactRoot, ownerTokenName);
  try {
    const tokenStat = await lstat(tokenPath);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o077) !== 0) {
      throw new RecordingServiceUnavailableError();
    }
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(token)) {
      throw new RecordingServiceUnavailableError();
    }
    return token;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const token = randomUUID();
  const temporary = join(artifactRoot, `.${ownerTokenName}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${token}\n`, { mode: FILE_MODE, flag: "wx" });
  try {
    await link(temporary, tokenPath);
    await unlink(temporary);
    return token;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (!isNotFound(error) && !isAlreadyExists(error)) throw error;
    return readOrCreateOwnerToken(artifactRoot);
  }
}

function containedArtifactPath(root: string, value: string): boolean {
  if (!isAbsolute(value) || value.includes("\\") || value.includes("..")) return false;
  const relation = relative(root, value);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

function artifactPaths(inspection: SessionInspection): string[] {
  return Object.values(inspection.paths)
    .filter((path) => containedArtifactPath(inspection.paths.root, path))
    .sort();
}

function requestId(inspection: SessionInspection): Promise<string> {
  return readFile(inspection.paths.request, "utf8").then((content) => {
    const request = validateRecordingRequest(JSON.parse(content) as unknown);
    return request.requestId;
  });
}

function stampedEvent(
  sessionId: string,
  semantic: SemanticBrowserEvent,
  inspection: SessionInspection,
  currentUs: number,
): Promise<ReturnType<typeof validateSessionEvent>> {
  return readFile(inspection.paths.telemetry, "utf8").then((content) => {
    const lastLine = content.split("\n").filter(Boolean).at(-1);
    const last =
      lastLine === undefined ? undefined : validateSessionEvent(JSON.parse(lastLine) as unknown);
    return validateSessionEvent({
      schemaVersion: 1,
      sessionId,
      seq: (last?.seq ?? -1) + 1,
      tUs: Math.max(currentUs, (last?.tUs ?? -1) + 1),
      type: semantic.type,
      data: semantic.data,
    });
  });
}

function sessionView(
  inspection: SessionInspection,
  id: string,
  status?: RecordingSessionView["status"],
  delivery?: RenderedSealedSession,
): RecordingSessionView {
  const artifactRoot = inspection.paths.root;
  const view: RecordingSessionView = {
    sessionId: inspection.sessionId,
    requestId: id,
    status: status ?? (inspection.state === "active" ? "open" : "sealed"),
    eventCount: inspection.eventCount,
    artifactRoot,
    browserStartHelperPath: inspection.paths.startWrapper,
    browserStopHelperPath: inspection.paths.stopWrapper,
    captureConfigPath: inspection.paths.captureConfig,
    artifactPaths: delivery === undefined ? artifactPaths(inspection) : delivery.artifactPaths,
  };
  if (delivery === undefined) return view;
  return {
    ...view,
    videoPath: delivery.videoPath,
    manifestPath: delivery.manifestPath,
    qualityReportPath: delivery.qualityReportPath,
  };
}

function captureBrokerKey(artifactRoot: string, sessionId: string): string {
  return `${artifactRoot}:${sessionId}`;
}

function brokerStatePath(inspection: SessionInspection): string {
  return join(inspection.paths.root, "broker-state.json");
}

async function writePrivateJson(path: string, value: BrokerState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: FILE_MODE, flag: "wx" });
  await rename(temporary, path);
}

async function readBrokerState(inspection: SessionInspection): Promise<BrokerState | undefined> {
  try {
    const value = JSON.parse(await readFile(brokerStatePath(inspection), "utf8")) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      (value as Record<string, unknown>)["schemaVersion"] !== 1 ||
      (value as Record<string, unknown>)["sessionId"] !== inspection.sessionId ||
      typeof (value as Record<string, unknown>)["origin"] !== "string" ||
      !["ready", "claimed", "running", "stopped", "failed"].includes(
        String((value as Record<string, unknown>)["phase"]),
      )
    ) {
      throw new RecordingServiceUnavailableError();
    }
    return value as BrokerState;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeInterruptedSummary(
  inspection: SessionInspection,
  origin: string,
): Promise<void> {
  const path = inspection.paths.captureSummary;
  try {
    await lstat(path);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, sessionId: inspection.sessionId, origin, status: "failed", receivedFrames: 0, acceptedFrames: 0, ackedFrames: 0, rejectedFrames: 0, degradationRequested: false, reason: "broker_interrupted" })}\n`,
    { mode: FILE_MODE, flag: "wx" },
  );
  await rename(temporary, path);
}

async function writeBrowserHelper(path: string, content: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new RecordingServiceUnavailableError();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: FILE_MODE, flag: "wx" });
  await rename(temporary, path);
}

async function startBroker(
  artifactRoot: string,
  inspection: SessionInspection,
  state: BrokerState,
): Promise<void> {
  const statePath = brokerStatePath(inspection);
  const broker = await createCaptureBroker({
    sessionId: inspection.sessionId,
    root: inspection.paths.root,
    origin: state.origin,
    onPhase: async (phase) => writePrivateJson(statePath, { ...state, phase }),
  });
  try {
    const helperInput = {
      sessionId: inspection.sessionId,
      endpoint: broker.endpoint,
    };
    await writeBrowserHelper(inspection.paths.startWrapper, browserStartHelper(helperInput));
    await writeBrowserHelper(inspection.paths.stopWrapper, browserStopHelper(helperInput));
    activeCaptureBrokers.set(captureBrokerKey(artifactRoot, inspection.sessionId), broker);
  } catch (error) {
    await broker.close().catch(() => undefined);
    throw error;
  }
}

async function createSessionBroker(
  artifactRoot: string,
  inspection: SessionInspection,
): Promise<void> {
  const request = validateRecordingRequest(
    JSON.parse(await readFile(inspection.paths.request, "utf8")) as unknown,
  );
  const state: BrokerState = {
    schemaVersion: 1,
    sessionId: inspection.sessionId,
    origin: new URL(request.url).origin,
    phase: "ready",
  };
  await writePrivateJson(brokerStatePath(inspection), state);
  await startBroker(artifactRoot, inspection, state);
}

async function ensureBroker(artifactRoot: string, inspection: SessionInspection): Promise<void> {
  const key = captureBrokerKey(artifactRoot, inspection.sessionId);
  if (activeCaptureBrokers.has(key)) return;
  const state = await readBrokerState(inspection);
  if (state === undefined || state.phase === "stopped") return;
  if (state.phase === "ready") {
    await startBroker(artifactRoot, inspection, state);
    return;
  }
  if (state.phase === "claimed" || state.phase === "running") {
    await writePrivateJson(brokerStatePath(inspection), { ...state, phase: "failed" });
    await writeInterruptedSummary(inspection, state.origin);
  }
  throw new RecordingServiceUnavailableError();
}

function generatedRequest(
  input: Parameters<RecordingSessionService["create"]>[0],
  requestIdValue: string,
): RecordingRequest {
  const parsed = new URL(input.url);
  return validateRecordingRequest({
    schemaVersion: 1,
    requestId: requestIdValue,
    url: input.url,
    objective: input.objective,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
    policy: {
      allowPrivateOrigin: input.allowPrivateOrigin ?? false,
      allowedOrigins: input.allowedOrigins ?? [parsed.origin],
      maxAttempts: 2,
    },
  });
}

/** Local session persistence with browser helpers aligned to SessionStore's checked-in runtime contract. */
export function createSessionStoreService(
  options: SessionStoreServiceOptions = {},
): RecordingSessionService {
  const clockUs = options.clockUs ?? (() => Number(process.hrtime.bigint() / 1_000n));
  const projectRoot = resolve(process.cwd());
  const browserHelperRoot = join(projectRoot, ".playwright-mcp", "recordly-codex");
  const artifactRoot =
    options.artifactRoot === undefined
      ? defaultArtifactRoot()
      : validArtifactRoot(options.artifactRoot);
  const context = readOrCreateOwnerToken(artifactRoot)
    .then(
      (ownerToken): ServiceContext => ({
        projectRoot,
        clockUs,
        store: new SessionStore({
          root: artifactRoot,
          browserHelperRoot,
          ownerToken,
          runtimeModulePath: resolve(projectRoot, "browser", "capture-runtime.js"),
          clockUs,
          idSource: options.idSource ?? randomUUID,
          fileSystem: nodeFileSystem(),
        }),
      }),
    )
    .catch(() => {
      throw new RecordingServiceUnavailableError();
    });
  const serial = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const lockKey = `${artifactRoot}:${sessionId}`;
    const previous = sessionLocks.get(lockKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    sessionLocks.set(lockKey, current);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (sessionLocks.get(lockKey) === current) sessionLocks.delete(lockKey);
    }
  };

  return {
    create: async (input) => {
      const ready = await context;
      const request = generatedRequest(input, randomUUID());
      const inspection = await ready.store.createSession(request);
      try {
        await createSessionBroker(artifactRoot, inspection);
        return sessionView(inspection, request.requestId);
      } catch (error) {
        await ready.store.discard(inspection.sessionId).catch(() => undefined);
        throw error;
      }
    },
    recordEvent: async ({ sessionId, event }) =>
      serial(sessionId, async () => {
        const ready = await context;
        const inspection = await ready.store.inspect(sessionId);
        await ensureBroker(artifactRoot, inspection);
        const id = await requestId(inspection);
        const eventToAppend = await stampedEvent(sessionId, event, inspection, ready.clockUs());
        return sessionView(await ready.store.appendEvent(sessionId, eventToAppend), id);
      }),
    inspect: async ({ sessionId }) => {
      const ready = await context;
      const inspection = await ready.store.inspect(sessionId);
      await ensureBroker(artifactRoot, inspection);
      return sessionView(inspection, await requestId(inspection));
    },
    seal: async ({ sessionId }) => {
      const ready = await context;
      const beforeSeal = await ready.store.inspect(sessionId);
      await ensureBroker(artifactRoot, beforeSeal);
      const inspection = await ready.store.seal(sessionId);
      const brokerKey = captureBrokerKey(artifactRoot, sessionId);
      await activeCaptureBrokers.get(brokerKey)?.close();
      activeCaptureBrokers.delete(brokerKey);
      const delivery = await renderSealedSession({ artifactRoot, sessionId });
      if (!delivery.approved || delivery.timingMode !== "broker-receipt-offsets") {
        throw new Error("sealed capture is not approved for delivery");
      }
      return sessionView(inspection, await requestId(inspection), undefined, delivery);
    },
    discard: async ({ sessionId }) => {
      const ready = await context;
      const inspection = await ready.store.inspect(sessionId);
      const discarded = sessionView(inspection, await requestId(inspection), "discarded");
      const brokerKey = captureBrokerKey(artifactRoot, sessionId);
      await activeCaptureBrokers.get(brokerKey)?.close();
      activeCaptureBrokers.delete(brokerKey);
      await ready.store.discard(sessionId);
      return discarded;
    },
  };
}
