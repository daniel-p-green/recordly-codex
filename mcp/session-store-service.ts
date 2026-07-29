// biome-ignore-all lint/complexity/useLiteralKeys: persisted broker state is untrusted dictionary data.
import { createHash, randomUUID } from "node:crypto";
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
  applyAcceptedEditorialProposal as applyEditorialProposal,
  buildEditorialProposal,
  type EditorialProposal,
} from "../src/analysis/index.js";

import {
  type RecordingRequest,
  validateRecordingRequest,
  validateSessionEvent,
} from "../src/contracts/index.js";
import { canonicalJson } from "../src/manifest/index.js";
import { createPrivateAudioNormalizer } from "../src/media/private-audio-normalization.js";
import { createPrivateMediaLibrary } from "../src/media/private-media-library.js";
import { createPrivateVisualRasterAdapter } from "../src/media/private-visual-raster.js";
import {
  applyRecordingProfile,
  builtInRecordingProfiles,
  profileSnapshotSha256,
  type RecordingProject,
  reviseRecordingProject,
  validateRecordingProject,
} from "../src/project/index.js";
import { previewJudgmentDigests, previewJudgmentSummary } from "../src/project/preview-judgment.js";
import { renderRecordingProject } from "../src/render/project-renderer.js";
import { type RenderedSealedSession, renderSealedSession } from "../src/render/sealed-session.js";
import {
  type SessionFileSystem,
  type SessionInspection,
  SessionStore,
} from "../src/session/index.js";
import { browserStartHelper, browserStopHelper } from "./browser-helper.js";
import {
  type CaptureBroker,
  createCaptureBroker,
  DEFAULT_CAPTURE_BUDGET,
} from "./capture-broker.js";
import { RecordingServiceUnavailableError } from "./handlers.js";
import { inspectPrivatePreview } from "./preview-inspection.js";
import { digestPrivateArtifact } from "./private-artifact.js";
import { loadProjectAssetRegistry, registerProjectAudioAsset } from "./project-asset-registry.js";
import { ProjectMediaStore } from "./project-media-store.js";
import { RecordingProjectStore } from "./project-persistence.js";
import { PreviewJudgmentStore } from "./project-preview-judgment-store.js";
import {
  createVerifiedCaptureSource,
  readSourceKeyedCapturePresentationEvidence,
  readVerifiedCaptureEditorialEvidence,
} from "./project-render-source.js";
import { resolveProjectVisualSources } from "./project-visual-resolver.js";
import { RecordingProfileStore } from "./recording-profile-store.js";
import { createRenderPublication, publishThenCompareAndSwap } from "./render-publication.js";
import type {
  CaptureBudget,
  CaptureStatus,
  RecordingMcpService,
  RecordingProjectView,
  RecordingSessionView,
  SemanticBrowserEvent,
} from "./types.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ownerTokenName = ".recordly-codex-owner-token";
const sessionLocks = new Map<string, Promise<void>>();
const projectLocks = new Map<string, Promise<void>>();
const activeCaptureBrokers = new Map<string, CaptureBroker>();

type SessionStoreServiceOptions = {
  artifactRoot?: string;
  /** Explicitly authorized import root. It is never accepted from MCP input. */
  authorizedImportRoot?: string;
  idSource?: () => string;
  clockUs?: () => number;
};

type ServiceContext = {
  projectRoot: string;
  ownerToken: string;
  store: SessionStore;
  clockUs: () => number;
};

type BrokerState = {
  schemaVersion: 1;
  sessionId: string;
  origin: string;
  phase: "ready" | "claimed" | "running" | "stopped" | "failed";
  budget: CaptureBudget;
  acceptedFrames: number;
  acceptedBytes: number;
  reason?: "budget_exceeded";
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

function captureBudget(input: Partial<CaptureBudget> = {}): CaptureBudget {
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

function captureStatus(state: BrokerState): CaptureStatus {
  return {
    phase: state.phase,
    ...state.budget,
    acceptedFrames: state.acceptedFrames,
    acceptedBytes: state.acceptedBytes,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
  };
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
  browserHelperRoot: string,
  status?: RecordingSessionView["status"],
  delivery?: RenderedSealedSession,
  capture?: CaptureStatus,
): RecordingSessionView {
  const artifactRoot = inspection.paths.root;
  const view: RecordingSessionView = {
    sessionId: inspection.sessionId,
    requestId: id,
    status: status ?? (inspection.state === "active" ? "open" : "sealed"),
    eventCount: inspection.eventCount,
    artifactRoot,
    browserHelperRoot,
    browserStartHelperPath: inspection.paths.startWrapper,
    browserStopHelperPath: inspection.paths.stopWrapper,
    captureConfigPath: inspection.paths.captureConfig,
    artifactPaths: delivery === undefined ? artifactPaths(inspection) : delivery.artifactPaths,
  };
  const withCapture = capture === undefined ? view : { ...view, capture };
  if (delivery === undefined) return withCapture;
  return {
    ...withCapture,
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

async function createSessionBroker(
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

async function currentCaptureStatus(
  artifactRoot: string,
  inspection: SessionInspection,
): Promise<CaptureStatus | undefined> {
  const live = activeCaptureBrokers.get(captureBrokerKey(artifactRoot, inspection.sessionId));
  if (live !== undefined) return live.status();
  const state = await readBrokerState(inspection);
  return state === undefined ? undefined : captureStatus(state);
}

function generatedRequest(
  input: Parameters<RecordingMcpService["create"]>[0],
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
      allowedOrigins: [parsed.origin],
      maxAttempts: 2,
    },
  });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function approvedSealedDeliveryManifest(input: {
  artifactRoot: string;
  sessionId: string;
}): Promise<{ manifestPath: string; manifest: unknown; manifestSha256: string }> {
  const artifacts = join(input.artifactRoot, input.sessionId, "artifacts");
  const manifestPath = join(artifacts, "recording-manifest.json");
  const qualityPath = join(artifacts, "quality-report.json");
  const videoPath = join(artifacts, "recording.mp4");
  for (const path of [manifestPath, qualityPath, videoPath]) {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RecordingServiceUnavailableError();
    }
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const quality = JSON.parse(await readFile(qualityPath, "utf8")) as Record<string, unknown>;
  const timing = quality["timing"] as Record<string, unknown> | undefined;
  const artifactHashes = quality["artifactHashes"] as Record<string, unknown> | undefined;
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const artifact = manifest["artifact"] as Record<string, unknown> | undefined;
  if (
    quality["schemaVersion"] !== 1 ||
    quality["kind"] !== "recordly-codex-quality-report" ||
    quality["status"] !== "approved" ||
    timing?.["mode"] !== "broker-receipt-offsets" ||
    timing?.["eligibleForApproval"] !== true ||
    typeof artifactHashes?.["videoSha256"] !== "string" ||
    typeof artifactHashes?.["manifestSha256"] !== "string" ||
    artifact?.["file"] !== "recording.mp4" ||
    artifact?.["sha256"] !== artifactHashes["videoSha256"] ||
    sha256(manifestText) !== artifactHashes["manifestSha256"] ||
    sha256(await readFile(videoPath)) !== artifactHashes["videoSha256"]
  ) {
    throw new RecordingServiceUnavailableError();
  }
  return { manifestPath, manifest, manifestSha256: sha256(manifestText) };
}

function manifestProjectSource(input: {
  sessionId: string;
  projectId: string;
  automatedRevisionLimit: number;
  manifest: unknown;
  manifestSha256: string;
}): RecordingProject {
  if (
    input.manifest === null ||
    typeof input.manifest !== "object" ||
    Array.isArray(input.manifest)
  ) {
    throw new RecordingServiceUnavailableError();
  }
  const manifest = input.manifest as Record<string, unknown>;
  const source = manifest["source"];
  const timeline = manifest["timeline"];
  if (
    manifest["schemaVersion"] !== 1 ||
    manifest["kind"] !== "recordly-codex-delivery" ||
    manifest["sessionId"] !== input.sessionId ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    timeline === null ||
    typeof timeline !== "object" ||
    Array.isArray(timeline)
  ) {
    throw new RecordingServiceUnavailableError();
  }
  const sourceValue = source as Record<string, unknown>;
  const timelineValue = timeline as Record<string, unknown>;
  const cursorEvidence = manifest["cursorTrack"];
  const actionEvidence = manifest["observedActions"];
  const width = sourceValue["width"];
  const height = sourceValue["height"];
  const frameSetSha256 = sourceValue["aggregateSha256"];
  const durationUs = timelineValue["durationUs"];
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(durationUs) ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    (durationUs as number) < 1 ||
    typeof frameSetSha256 !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(frameSetSha256) ||
    (cursorEvidence !== undefined && !Array.isArray(cursorEvidence)) ||
    !Array.isArray(actionEvidence)
  ) {
    throw new RecordingServiceUnavailableError();
  }
  const captureId = `capture-${sha256(input.sessionId).slice(0, 24)}`;
  return validateRecordingProject({
    schemaVersion: 1,
    projectId: input.projectId,
    revision: 0,
    revisionPolicy: {
      automatedRevisionLimit: input.automatedRevisionLimit,
      automatedRevisionCount: 0,
    },
    captureSources: [
      {
        id: captureId,
        sessionId: input.sessionId,
        manifestSha256: input.manifestSha256,
        timelineSha256: sha256(canonicalJson(timelineValue)),
        frameSetSha256,
        sourceWidth: width,
        sourceHeight: height,
        durationUs,
      },
    ],
    output: {
      profile: "landscape-1080p",
      width: 1920,
      height: 1080,
      fps: 30,
      format: "mp4",
      quality: "high",
    },
    timeline: {
      clips: [
        {
          id: `clip-${sha256(input.sessionId).slice(0, 24)}`,
          sourceId: captureId,
          trim: { startUs: 0, endUs: durationUs },
          speedRegions: [],
          zoomRegions: [],
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
      ],
    },
    presentation: {
      cursor: {
        visible: Array.isArray(cursorEvidence) && cursorEvidence.length > 0,
        preset: "system",
        sizePx: 28,
        motion: "smoothed",
        clickEffect: actionEvidence.some(
          (event) =>
            event !== null &&
            typeof event === "object" &&
            (event as { type?: unknown }).type === "click",
        )
          ? "ripple"
          : "none",
      },
      frame: {
        background: { kind: "gradient", startColor: "#111827", endColor: "#312e81" },
        paddingPx: 40,
        radiusPx: 24,
        shadow: "soft",
      },
    },
    overlays: { annotations: [], captions: [] },
    audioTracks: [],
    pipTracks: [],
    renderHooks: [],
    preview: { status: "not-requested" },
  });
}

function projectView(
  project: RecordingProject,
  projectSha256: string,
  judgment?: RecordingProjectView["previewJudgment"],
): RecordingProjectView {
  return {
    project,
    projectSha256,
    ...(judgment === undefined ? {} : { previewJudgment: judgment }),
  };
}

async function canonicalEditorialProposal(
  artifactRoot: string,
  project: RecordingProject,
): Promise<EditorialProposal> {
  if (project.schemaVersion !== 2) throw new RecordingServiceUnavailableError();
  const evidence = await Promise.all(
    project.captureSources.map((source) =>
      readVerifiedCaptureEditorialEvidence({ artifactRoot, source }),
    ),
  );
  const observedEvents = evidence
    .flatMap((entry) => entry.observedEvents)
    .sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.tUs - right.tUs ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 2_048);
  return buildEditorialProposal({
    schemaVersion: 1,
    project,
    observedEvents,
    deadTimeBySource: project.captureSources.map((source, index) => ({
      sourceId: source.id,
      analysis: (
        evidence[index] as Awaited<ReturnType<typeof readVerifiedCaptureEditorialEvidence>>
      ).deadTime,
    })),
  });
}

function profileSummary(profile: {
  source: "builtin" | "owner-local";
  profileId: string;
  profileRevision: number;
  snapshotSha256: string;
}): {
  source: "builtin" | "owner-local";
  profileId: string;
  profileRevision: number;
  snapshotSha256: string;
} {
  return {
    source: profile.source,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    snapshotSha256: profile.snapshotSha256,
  };
}

async function resolveCanonicalProfile(
  artifactRoot: string,
  ownerToken: string,
  locator: {
    source: "builtin" | "owner-local";
    profileId: string;
    profileRevision?: number;
    snapshotSha256?: string;
  },
) {
  const profile =
    locator.source === "builtin"
      ? builtInRecordingProfiles().find((candidate) => candidate.profileId === locator.profileId)
      : await new RecordingProfileStore(artifactRoot, ownerToken).load(locator.profileId);
  if (profile === undefined || profile.source !== locator.source)
    throw new RecordingServiceUnavailableError();
  if (
    (locator.profileRevision !== undefined &&
      profile.profileRevision !== locator.profileRevision) ||
    (locator.snapshotSha256 !== undefined &&
      profile.snapshotSha256 !== locator.snapshotSha256.toLowerCase())
  ) {
    throw new RecordingServiceUnavailableError();
  }
  return profile;
}

async function previewArtifactDigest(
  artifactRoot: string,
  project: RecordingProject,
): Promise<string> {
  return (
    await digestPrivateArtifact({
      root: artifactRoot,
      relativePath: previewArtifactRelativePath(project),
      maximumBytes: 512 * 1024 * 1024,
    })
  ).sha256;
}

function previewArtifactRelativePath(project: RecordingProject): string {
  return `projects/renders/${project.projectId}-r${project.revision}-preview.${project.output.format}`;
}

async function inspectedPreviewJudgment(
  artifactRoot: string,
  ownerToken: string,
  project: RecordingProject,
): Promise<RecordingProjectView["previewJudgment"]> {
  const judgment = await new PreviewJudgmentStore(artifactRoot, ownerToken).load(
    project.projectId,
    project.revision,
  );
  if (judgment === undefined) return undefined;
  const summary = previewJudgmentSummary(judgment, project);
  try {
    const digests = previewJudgmentDigests(project);
    const artifactDigest = await previewArtifactDigest(artifactRoot, project);
    const current =
      judgment.projectSha256 === digests.projectSha256 &&
      judgment.renderInputSha256 === digests.renderInputSha256 &&
      judgment.renderRecipeSha256 === digests.renderRecipeSha256 &&
      judgment.previewArtifactSha256 === artifactDigest;
    return { ...summary, status: current ? "current" : "stale" };
  } catch {
    return { ...summary, status: "stale" };
  }
}

/** Local session persistence with browser helpers aligned to SessionStore's checked-in runtime contract. */
export function createSessionStoreService(
  options: SessionStoreServiceOptions = {},
): RecordingMcpService {
  const clockUs = options.clockUs ?? (() => Number(process.hrtime.bigint() / 1_000n));
  const projectRoot = resolve(process.cwd());
  const artifactRoot =
    options.artifactRoot === undefined
      ? defaultArtifactRoot()
      : validArtifactRoot(options.artifactRoot);
  const browserHelperRoot = join(artifactRoot, "browser-helpers");
  const authorizedImportRoot =
    options.authorizedImportRoot === undefined &&
    process.env["RECORDLY_CODEX_IMPORT_ROOT"] === undefined
      ? undefined
      : validArtifactRoot(
          options.authorizedImportRoot ?? (process.env["RECORDLY_CODEX_IMPORT_ROOT"] as string),
        );
  const context = readOrCreateOwnerToken(artifactRoot)
    .then(
      (ownerToken): ServiceContext => ({
        projectRoot,
        ownerToken,
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
  const serial = async <T>(
    locks: Map<string, Promise<void>>,
    identity: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const lockKey = `${artifactRoot}:${identity}`;
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    locks.set(lockKey, current);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
  };

  return {
    renderProjectEnabled: true,
    create: async (input) => {
      const ready = await context;
      const request = generatedRequest(input, randomUUID());
      const inspection = await ready.store.createSession(request);
      try {
        const budget = captureBudget(input);
        await createSessionBroker(artifactRoot, inspection, budget);
        return sessionView(
          inspection,
          request.requestId,
          browserHelperRoot,
          undefined,
          undefined,
          await currentCaptureStatus(artifactRoot, inspection),
        );
      } catch (error) {
        await ready.store.discard(inspection.sessionId).catch(() => undefined);
        throw error;
      }
    },
    recordEvent: async ({ sessionId, event }) =>
      serial(sessionLocks, sessionId, async () => {
        const ready = await context;
        const inspection = await ready.store.inspect(sessionId);
        await ensureBroker(artifactRoot, inspection);
        const id = await requestId(inspection);
        const eventToAppend = await stampedEvent(sessionId, event, inspection, ready.clockUs());
        const updated = await ready.store.appendEvent(sessionId, eventToAppend);
        return sessionView(
          updated,
          id,
          browserHelperRoot,
          undefined,
          undefined,
          await currentCaptureStatus(artifactRoot, updated),
        );
      }),
    inspect: async ({ sessionId }) => {
      const ready = await context;
      const inspection = await ready.store.inspect(sessionId);
      const existingCapture = await currentCaptureStatus(artifactRoot, inspection);
      if (existingCapture?.phase === "failed") {
        return sessionView(
          inspection,
          await requestId(inspection),
          browserHelperRoot,
          undefined,
          undefined,
          existingCapture,
        );
      }
      await ensureBroker(artifactRoot, inspection);
      return sessionView(
        inspection,
        await requestId(inspection),
        browserHelperRoot,
        undefined,
        undefined,
        await currentCaptureStatus(artifactRoot, inspection),
      );
    },
    seal: async ({ sessionId }) =>
      serial(sessionLocks, sessionId, async () => {
        const ready = await context;
        const beforeSeal = await ready.store.inspect(sessionId);
        if ((await currentCaptureStatus(artifactRoot, beforeSeal))?.phase === "failed") {
          throw new RecordingServiceUnavailableError();
        }
        await ensureBroker(artifactRoot, beforeSeal);
        const inspection = await ready.store.seal(sessionId);
        const brokerKey = captureBrokerKey(artifactRoot, sessionId);
        await activeCaptureBrokers.get(brokerKey)?.close();
        activeCaptureBrokers.delete(brokerKey);
        const delivery = await renderSealedSession({ artifactRoot, sessionId });
        if (!delivery.approved || delivery.timingMode !== "broker-receipt-offsets") {
          throw new Error("sealed capture is not approved for delivery");
        }
        return sessionView(
          inspection,
          await requestId(inspection),
          browserHelperRoot,
          undefined,
          delivery,
          await currentCaptureStatus(artifactRoot, inspection),
        );
      }),
    discard: async ({ sessionId }) =>
      serial(sessionLocks, sessionId, async () => {
        const ready = await context;
        const inspection = await ready.store.inspect(sessionId);
        const discarded = sessionView(
          inspection,
          await requestId(inspection),
          browserHelperRoot,
          "discarded",
          undefined,
          await currentCaptureStatus(artifactRoot, inspection),
        );
        const brokerKey = captureBrokerKey(artifactRoot, sessionId);
        await activeCaptureBrokers.get(brokerKey)?.close();
        activeCaptureBrokers.delete(brokerKey);
        await ready.store.discard(sessionId);
        return discarded;
      }),
    createProject: async ({ sessionId, projectId, automatedRevisionLimit }) =>
      serial(sessionLocks, sessionId, async () =>
        serial(projectLocks, projectId ?? sessionId, async () => {
          const ready = await context;
          const inspection = await ready.store.inspect(sessionId);
          if (inspection.state !== "sealed") throw new RecordingServiceUnavailableError();
          const delivery = await approvedSealedDeliveryManifest({ artifactRoot, sessionId });
          const project = manifestProjectSource({
            sessionId,
            projectId: projectId ?? sessionId,
            automatedRevisionLimit: automatedRevisionLimit ?? 4,
            manifest: delivery.manifest,
            manifestSha256: delivery.manifestSha256,
          });
          const stored = await new RecordingProjectStore(artifactRoot, ready.ownerToken).create(
            project,
          );
          return projectView(stored.project, stored.sha256);
        }),
      ),
    inspectProject: async ({ projectId }) => {
      const ready = await context;
      const stored = await new RecordingProjectStore(artifactRoot, ready.ownerToken).load(
        projectId,
      );
      return projectView(
        stored.project,
        stored.sha256,
        await inspectedPreviewJudgment(artifactRoot, ready.ownerToken, stored.project),
      );
    },
    listProfiles: async () => {
      const ready = await context;
      const local = await new RecordingProfileStore(artifactRoot, ready.ownerToken).list();
      return [
        ...builtInRecordingProfiles(),
        ...local.map((profile) => ({ ...profile, source: "owner-local" as const })),
      ]
        .map(profileSummary)
        .sort(
          (left, right) =>
            left.source.localeCompare(right.source) ||
            left.profileId.localeCompare(right.profileId),
        );
    },
    getProfile: async ({ source, profileId }) => {
      const ready = await context;
      return resolveCanonicalProfile(artifactRoot, ready.ownerToken, { source, profileId });
    },
    createProfile: async ({ profileId, snapshot }) => {
      const ready = await context;
      const profile = {
        source: "owner-local" as const,
        profileId,
        profileRevision: 1,
        snapshot,
        snapshotSha256: profileSnapshotSha256(snapshot),
      };
      return new RecordingProfileStore(artifactRoot, ready.ownerToken).create(profile);
    },
    updateProfile: async ({ profileId, expectedRevision, expectedSnapshotSha256, snapshot }) => {
      const ready = await context;
      const profile = {
        source: "owner-local" as const,
        profileId,
        profileRevision: expectedRevision + 1,
        snapshot,
        snapshotSha256: profileSnapshotSha256(snapshot),
      };
      return new RecordingProfileStore(artifactRoot, ready.ownerToken).update(profile, {
        expectedRevision,
        expectedSnapshotSha256,
      });
    },
    applyProfile: async ({ projectId, projectRevision, profile, mode }) =>
      serial(projectLocks, projectId, async () => {
        const ready = await context;
        const store = new RecordingProjectStore(artifactRoot, ready.ownerToken);
        const current = await store.load(projectId);
        if (current.project.revision !== projectRevision)
          throw new RecordingServiceUnavailableError();
        const canonical = await resolveCanonicalProfile(artifactRoot, ready.ownerToken, profile);
        const revised = applyRecordingProfile(current.project, canonical, mode);
        const stored = await store.replace(revised, {
          expectedRevision: current.project.revision,
          expectedSha256: current.sha256,
        });
        return projectView(stored.project, stored.sha256);
      }),
    reviseProject: async ({ project, mode }) => {
      const candidate = validateRecordingProject(project);
      return serial(projectLocks, candidate.projectId, async () => {
        const ready = await context;
        const store = new RecordingProjectStore(artifactRoot, ready.ownerToken);
        const current = await store.load(candidate.projectId);
        const revised = reviseRecordingProject(current.project, candidate, mode);
        const stored = await store.replace(revised, {
          expectedRevision: current.project.revision,
          expectedSha256: current.sha256,
        });
        return projectView(stored.project, stored.sha256);
      });
    },
    proposeEditorial: async ({ projectId, projectRevision }) =>
      serial(projectLocks, projectId, async () => {
        const ready = await context;
        const current = await new RecordingProjectStore(artifactRoot, ready.ownerToken).load(
          projectId,
        );
        if (current.project.revision !== projectRevision)
          throw new RecordingServiceUnavailableError();
        return canonicalEditorialProposal(artifactRoot, current.project);
      }),
    applyAcceptedEditorialProposal: async ({
      projectId,
      projectRevision,
      proposalSha256,
      acceptedZoomProposalIds,
    }) =>
      serial(projectLocks, projectId, async () => {
        const ready = await context;
        const store = new RecordingProjectStore(artifactRoot, ready.ownerToken);
        const current = await store.load(projectId);
        if (current.project.revision !== projectRevision)
          throw new RecordingServiceUnavailableError();
        const proposal = await canonicalEditorialProposal(artifactRoot, current.project);
        if (proposal.proposalSha256 !== proposalSha256)
          throw new RecordingServiceUnavailableError();
        const revised = applyEditorialProposal(current.project, proposal, acceptedZoomProposalIds);
        const stored = await store.replace(revised, {
          expectedRevision: current.project.revision,
          expectedSha256: current.sha256,
        });
        return projectView(stored.project, stored.sha256);
      }),
    importProjectMedia: async ({ projectId, revision, fileName }) =>
      serial(projectLocks, projectId, async () => {
        if (authorizedImportRoot === undefined) throw new RecordingServiceUnavailableError();
        const ready = await context;
        const current = await new RecordingProjectStore(artifactRoot, ready.ownerToken).load(
          projectId,
        );
        if (current.project.revision !== revision) throw new RecordingServiceUnavailableError();
        const libraryRoot = join(artifactRoot, "private-media-library");
        await mkdir(libraryRoot, { recursive: true, mode: DIRECTORY_MODE });
        const libraryStatus = await lstat(libraryRoot);
        if (!libraryStatus.isDirectory() || libraryStatus.isSymbolicLink()) {
          throw new RecordingServiceUnavailableError();
        }
        await chmod(libraryRoot, DIRECTORY_MODE);
        const library = await createPrivateMediaLibrary({ libraryRoot });
        const imported = await library.ingest({
          authorizedRoot: authorizedImportRoot,
          relativePath: fileName,
          maximumBytes: 512 * 1024 * 1024,
        });
        if (imported.mediaKind === "audio") {
          const assetRoot = join(artifactRoot, "project-assets");
          await mkdir(assetRoot, { recursive: true, mode: DIRECTORY_MODE });
          await chmod(assetRoot, DIRECTORY_MODE);
          const normalized = await (await createPrivateAudioNormalizer({ libraryRoot })).normalize({
            media: imported,
            outputRoot: assetRoot,
          });
          await registerProjectAudioAsset({
            artifactRoot,
            ownerToken: ready.ownerToken,
            projectId,
            assetId: normalized.audioId,
            sha256: normalized.sha256,
            relativePath: `${normalized.audioId}.wav`,
          });
          return {
            mediaId: normalized.audioId,
            sha256: normalized.sha256,
            kind: "audio" as const,
            extension: "wav" as const,
            durationUs: Math.round(normalized.durationSeconds * 1_000_000),
            sampleRate: normalized.sampleRate,
            channels: normalized.channels,
          };
        }
        if (imported.mediaKind !== "image" && imported.mediaKind !== "video")
          throw new RecordingServiceUnavailableError();
        const adapter = await createPrivateVisualRasterAdapter({ libraryRoot });
        const inspected = await adapter.inspect({ media: imported });
        const stored = await new ProjectMediaStore(artifactRoot, ready.ownerToken).save(inspected);
        return {
          mediaId: stored.mediaId,
          sha256: stored.sha256,
          kind: stored.mediaKind,
          extension: stored.extension,
          durationUs: stored.durationUs,
          width: stored.width,
          height: stored.height,
          ...(stored.fps === undefined ? {} : { fps: stored.fps }),
        };
      }),
    inspectPreview: async ({ projectId, revision }) =>
      serial(projectLocks, projectId, async () => {
        const ready = await context;
        const current = await new RecordingProjectStore(artifactRoot, ready.ownerToken).load(
          projectId,
        );
        if (
          current.project.revision !== revision ||
          current.project.preview.status !== "ready" ||
          current.project.preview.revision !== current.project.revision
        ) {
          throw new RecordingServiceUnavailableError();
        }
        return inspectPrivatePreview({
          artifactRoot,
          relativePath: previewArtifactRelativePath(current.project),
          projectId,
          revision,
          projectSha256: current.sha256,
        });
      }),
    judgePreview: async ({
      projectId,
      revision,
      projectSha256,
      previewArtifactSha256,
      verdict,
      issues,
    }) =>
      serial(projectLocks, projectId, async () => {
        const ready = await context;
        const current = await new RecordingProjectStore(artifactRoot, ready.ownerToken).load(
          projectId,
        );
        if (
          current.project.revision !== revision ||
          current.project.preview.status !== "ready" ||
          current.project.preview.revision !== current.project.revision
        ) {
          throw new RecordingServiceUnavailableError();
        }
        const artifactDigest = await previewArtifactDigest(artifactRoot, current.project);
        if (current.sha256 !== projectSha256 || artifactDigest !== previewArtifactSha256) {
          throw new RecordingServiceUnavailableError();
        }
        const judgment = await new PreviewJudgmentStore(artifactRoot, ready.ownerToken).create({
          schemaVersion: 1,
          projectId,
          revision,
          ...previewJudgmentDigests(current.project),
          previewArtifactSha256: artifactDigest,
          verdict,
          issues,
        });
        return projectView(current.project, current.sha256, {
          ...previewJudgmentSummary(judgment, current.project),
          status: "current",
        });
      }),
    renderProject: async ({ projectId, revision, kind }) =>
      serial(projectLocks, projectId, async () => {
        const ready = await context;
        const store = new RecordingProjectStore(artifactRoot, ready.ownerToken);
        const current = await store.load(projectId);
        if (current.project.revision !== revision) throw new RecordingServiceUnavailableError();
        if (
          kind === "final" &&
          (current.project.preview.status !== "ready" ||
            current.project.preview.revision !== current.project.revision)
        ) {
          throw new RecordingServiceUnavailableError();
        }
        if (kind === "final") {
          const judgmentStore = new PreviewJudgmentStore(artifactRoot, ready.ownerToken);
          const recorded = await judgmentStore.load(
            current.project.projectId,
            current.project.revision,
          );
          if (current.project.schemaVersion === 2 || recorded !== undefined) {
            await judgmentStore.assertAccepted({
              projectId: current.project.projectId,
              revision: current.project.revision,
              ...previewJudgmentDigests(current.project),
              previewArtifactSha256: await previewArtifactDigest(artifactRoot, current.project),
            });
          }
        }
        const extension = current.project.output.format;
        const artifact = `projects/renders/${projectId}-r${revision}-${kind}.${extension}`;
        const publication = await createRenderPublication({
          artifactRoot,
          fileName: `${projectId}-r${revision}-${kind}.${extension}`,
        });
        try {
          const sourceInputs = await Promise.all(
            current.project.captureSources.map((source) =>
              Promise.all([
                createVerifiedCaptureSource({
                  artifactRoot,
                  source,
                  stagingRoot: publication.stagingRoot,
                }),
                readSourceKeyedCapturePresentationEvidence({ artifactRoot, source }),
              ]),
            ),
          );
          const sources = sourceInputs.map(([source]) => source);
          const cursorTrack = sourceInputs.flatMap(([, evidence]) => evidence.cursorTrack);
          const clickTrack = sourceInputs.flatMap(([, evidence]) => evidence.clickTrack);
          const assets = await loadProjectAssetRegistry({
            artifactRoot,
            ownerToken: ready.ownerToken,
            project: current.project,
          });
          const visual = await resolveProjectVisualSources({
            artifactRoot,
            ownerToken: ready.ownerToken,
            project: current.project,
          });
          try {
            await renderRecordingProject({
              project: current.project,
              sources,
              visualSources: visual.sources,
              assetRoot: assets.assetRoot,
              assets: assets.assets,
              outputPath: publication.temporaryPath,
              ...(current.project.presentation.cursor.visible ? { cursorTrack } : {}),
              ...(current.project.presentation.cursor.clickEffect !== "none" ? { clickTrack } : {}),
            });
          } finally {
            // Integrity verification happens in dispose; it must complete before publication.
            await visual.dispose();
          }
          const artifactDigest = sha256(await readFile(publication.temporaryPath));
          const updated = validateRecordingProject({
            ...current.project,
            preview:
              kind === "preview"
                ? { status: "ready", revision: current.project.revision }
                : { status: "rendered", revision: current.project.revision },
          });
          const stored = await publishThenCompareAndSwap(publication, () =>
            store.replace(updated, {
              expectedRevision: current.project.revision,
              expectedSha256: current.sha256,
            }),
          );
          return {
            ...projectView(stored.project, stored.sha256),
            render: {
              kind,
              revision,
              format: extension,
              artifact,
              sha256: artifactDigest,
            },
          };
        } finally {
          await publication.cleanup();
        }
      }),
  };
}
