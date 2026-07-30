// biome-ignore-all lint/complexity/useLiteralKeys: persisted broker state is untrusted dictionary data.
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRecordingRequest } from "../src/contracts/index.js";
import type { SessionInspection } from "../src/session/index.js";
import { browserStartHelper, browserStopHelper } from "./browser-helper.js";
import {
  type CaptureBroker,
  createCaptureBroker,
  DEFAULT_CAPTURE_BUDGET,
} from "./capture-broker.js";
import { RecordingServiceUnavailableError } from "./handlers.js";
import type { CaptureBudget, CaptureStatus } from "./types.js";

const FILE_MODE = 0o600;

export type BrokerState = {
  schemaVersion: 1;
  sessionId: string;
  origin: string;
  phase: "ready" | "claimed" | "running" | "stopped" | "failed";
  budget: CaptureBudget;
  acceptedFrames: number;
  acceptedBytes: number;
  reason?: "budget_exceeded";
};

export const activeCaptureBrokers = new Map<string, CaptureBroker>();

export function captureBrokerKey(artifactRoot: string, sessionId: string): string {
  return `${artifactRoot}:${sessionId}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function captureBudget(input: Partial<CaptureBudget> = {}): CaptureBudget {
  const budget = {
    maxCaptureSeconds: input.maxCaptureSeconds ?? DEFAULT_CAPTURE_BUDGET.maxCaptureSeconds,
    maxAcceptedFrames: input.maxAcceptedFrames ?? DEFAULT_CAPTURE_BUDGET.maxAcceptedFrames,
    maxAcceptedBytes: input.maxAcceptedBytes ?? DEFAULT_CAPTURE_BUDGET.maxAcceptedBytes,
  };
  if (
    !Number.isSafeInteger(budget.maxCaptureSeconds) ||
    budget.maxCaptureSeconds < 1 ||
    budget.maxCaptureSeconds > 300 ||
    !Number.isSafeInteger(budget.maxAcceptedFrames) ||
    budget.maxAcceptedFrames < 1 ||
    budget.maxAcceptedFrames > 9_000 ||
    !Number.isSafeInteger(budget.maxAcceptedBytes) ||
    budget.maxAcceptedBytes < 1 ||
    budget.maxAcceptedBytes > 512 * 1024 * 1024
  ) {
    throw new RecordingServiceUnavailableError();
  }
  return budget;
}

export function captureStatus(state: BrokerState): CaptureStatus {
  return {
    phase: state.phase,
    ...state.budget,
    acceptedFrames: state.acceptedFrames,
    acceptedBytes: state.acceptedBytes,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
  };
}

function brokerStatePath(inspection: SessionInspection): string {
  return join(inspection.paths.root, "broker-state.json");
}

async function writePrivateJson(path: string, value: BrokerState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: FILE_MODE, flag: "wx" });
  await rename(temporary, path);
}

export async function readBrokerState(
  inspection: SessionInspection,
): Promise<BrokerState | undefined> {
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
    const legacy = value as Record<string, unknown>;
    const budget = captureBudget(
      legacy["budget"] !== null && typeof legacy["budget"] === "object"
        ? (legacy["budget"] as Partial<CaptureBudget>)
        : {},
    );
    const acceptedFrames = legacy["acceptedFrames"] ?? 0;
    const acceptedBytes = legacy["acceptedBytes"] ?? 0;
    if (
      !Number.isSafeInteger(acceptedFrames) ||
      (acceptedFrames as number) < 0 ||
      !Number.isSafeInteger(acceptedBytes) ||
      (acceptedBytes as number) < 0 ||
      (legacy["reason"] !== undefined && legacy["reason"] !== "budget_exceeded")
    ) {
      throw new RecordingServiceUnavailableError();
    }
    return {
      schemaVersion: 1,
      sessionId: inspection.sessionId,
      origin: legacy["origin"] as string,
      phase: legacy["phase"] as BrokerState["phase"],
      budget,
      acceptedFrames: acceptedFrames as number,
      acceptedBytes: acceptedBytes as number,
      ...(legacy["reason"] === undefined ? {} : { reason: "budget_exceeded" }),
    };
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

export async function startBroker(
  artifactRoot: string,
  inspection: SessionInspection,
  state: BrokerState,
): Promise<void> {
  const statePath = brokerStatePath(inspection);
  const broker = await createCaptureBroker({
    sessionId: inspection.sessionId,
    root: inspection.paths.root,
    origin: state.origin,
    ...state.budget,
    onPhase: async (phase, capture) =>
      writePrivateJson(statePath, {
        ...state,
        phase,
        acceptedFrames: capture.acceptedFrames,
        acceptedBytes: capture.acceptedBytes,
        ...(capture.reason === undefined ? {} : { reason: capture.reason }),
      }),
  });
  try {
    const helperInput = {
      sessionId: inspection.sessionId,
      endpoint: broker.endpoint,
      origin: state.origin,
    };
    await writeBrowserHelper(inspection.paths.startWrapper, browserStartHelper(helperInput));
    await writeBrowserHelper(inspection.paths.stopWrapper, browserStopHelper(helperInput));
    activeCaptureBrokers.set(captureBrokerKey(artifactRoot, inspection.sessionId), broker);
  } catch (error) {
    await broker.close().catch(() => undefined);
    throw error;
  }
}

export async function createSessionBroker(
  artifactRoot: string,
  inspection: SessionInspection,
  budget: CaptureBudget,
): Promise<void> {
  const request = validateRecordingRequest(
    JSON.parse(await readFile(inspection.paths.request, "utf8")) as unknown,
  );
  const state: BrokerState = {
    schemaVersion: 1,
    sessionId: inspection.sessionId,
    origin: new URL(request.url).origin,
    phase: "ready",
    budget,
    acceptedFrames: 0,
    acceptedBytes: 0,
  };
  await writePrivateJson(brokerStatePath(inspection), state);
  await startBroker(artifactRoot, inspection, state);
}

export async function ensureBroker(
  artifactRoot: string,
  inspection: SessionInspection,
): Promise<void> {
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

export async function currentCaptureStatus(
  artifactRoot: string,
  inspection: SessionInspection,
): Promise<CaptureStatus | undefined> {
  const live = activeCaptureBrokers.get(captureBrokerKey(artifactRoot, inspection.sessionId));
  if (live !== undefined) return live.status();
  const state = await readBrokerState(inspection);
  return state === undefined ? undefined : captureStatus(state);
}
