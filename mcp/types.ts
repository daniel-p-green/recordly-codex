import type { EditorialProposal } from "../src/analysis/index.js";
import type { RecordingProfileReference, RecordingProject } from "../src/project/index.js";
import type {
  PreviewJudgmentIssue,
  PreviewJudgmentVerdict,
} from "../src/project/preview-judgment.js";
import type { CaptureBrokerFailureReason } from "./capture-broker.js";
import type { PreviewInspection } from "./preview-inspection.js";

export type RecordingSessionStatus = "open" | "sealed" | "discarded";

export type CaptureBudget = {
  maxCaptureSeconds: number;
  maxAcceptedFrames: number;
  maxAcceptedBytes: number;
};

export type CaptureStatus = CaptureBudget & {
  phase: "ready" | "claimed" | "running" | "stopped" | "failed";
  acceptedFrames: number;
  acceptedBytes: number;
  reason?: CaptureBrokerFailureReason;
};

/** Events Codex may describe. Capture evidence is generated locally, never supplied by the model. */
export type SemanticBrowserEvent =
  | {
      type: "pointer";
      data: { x: number; y: number; buttons: number; source: "planned" | "observed" };
    }
  | {
      type: "click";
      data: { x: number; y: number; button: 0 | 1 | 2; targetLabel?: string | undefined };
    }
  | { type: "scroll"; data: { x: number; y: number; deltaX: number; deltaY: number } }
  | { type: "navigation"; data: { origin: string } }
  | { type: "viewport"; data: { width: number; height: number; deviceScaleFactor: number } }
  | { type: "marker"; data: { id: string } };

export type RecordingSessionView = {
  sessionId: string;
  requestId: string;
  status: RecordingSessionStatus;
  eventCount: number;
  artifactRoot: string;
  /** Private writable helper root, separate from the installed plugin package. */
  browserHelperRoot: string;
  browserStartHelperPath: string;
  browserStopHelperPath: string;
  captureConfigPath: string;
  artifactPaths: readonly string[];
  videoPath?: string;
  manifestPath?: string;
  qualityReportPath?: string;
  capture?: CaptureStatus;
};

export interface RecordingSessionService {
  create(input: {
    url: string;
    objective: string;
    allowPrivateOrigin?: boolean;
    maxCaptureSeconds?: number;
    maxAcceptedFrames?: number;
    maxAcceptedBytes?: number;
  }): Promise<RecordingSessionView>;
  recordEvent(input: {
    sessionId: string;
    event: SemanticBrowserEvent;
  }): Promise<RecordingSessionView>;
  inspect(input: { sessionId: string }): Promise<RecordingSessionView>;
  seal(input: { sessionId: string }): Promise<RecordingSessionView>;
  discard(input: { sessionId: string; reason?: string }): Promise<RecordingSessionView>;
}

export type RecordingProjectView = {
  project: RecordingProject;
  projectSha256: string;
  previewJudgment?: {
    status: "current" | "stale";
    verdict: PreviewJudgmentVerdict;
    revision: number;
    issues: readonly PreviewJudgmentIssue[];
    remainingAutomatedRevisionBudget: number;
  };
  render?: {
    kind: "preview" | "final";
    revision: number;
    format: "mp4" | "gif";
    /** A safe relative artifact name, never a filesystem path. */
    artifact: string;
    sha256: string;
  };
};

export type ImportedRecordingProjectMedia = {
  mediaId: string;
  sha256: string;
  kind: "image" | "video" | "audio";
  extension: "gif" | "jpg" | "png" | "ppm" | "webp" | "mov" | "mp4" | "webm" | "wav";
  durationUs: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: 48000;
  channels?: 2;
};

export interface RecordingProjectService {
  createProject(input: {
    sessionId: string;
    projectId?: string;
    automatedRevisionLimit?: number;
  }): Promise<RecordingProjectView>;
  inspectProject(input: { projectId: string }): Promise<RecordingProjectView>;
  reviseProject(input: {
    project: unknown;
    mode: "manual" | "automated";
  }): Promise<RecordingProjectView>;
  renderProject(input: {
    projectId: string;
    revision: number;
    kind: "preview" | "final";
  }): Promise<RecordingProjectView>;
  judgePreview(input: {
    projectId: string;
    revision: number;
    projectSha256: string;
    previewArtifactSha256: string;
    verdict: PreviewJudgmentVerdict;
    issues: readonly PreviewJudgmentIssue[];
  }): Promise<RecordingProjectView>;
  inspectPreview?(input: { projectId: string; revision: number }): Promise<PreviewInspection>;
  importProjectMedia?(input: {
    projectId: string;
    revision: number;
    fileName: string;
  }): Promise<ImportedRecordingProjectMedia>;
  /** Set only after the renderer's current safety checklist clears. */
  renderProjectEnabled?: boolean;
}

export type RecordingProfileSummary = Pick<
  RecordingProfileReference,
  "source" | "profileId" | "profileRevision" | "snapshotSha256"
>;

export interface RecordingProfileService {
  listProfiles(input: Record<never, never>): Promise<readonly RecordingProfileSummary[]>;
  getProfile(input: {
    source: "builtin" | "owner-local";
    profileId: string;
  }): Promise<RecordingProfileReference>;
  createProfile(input: {
    profileId: string;
    snapshot: unknown;
  }): Promise<RecordingProfileReference>;
  updateProfile(input: {
    profileId: string;
    expectedRevision: number;
    expectedSnapshotSha256: string;
    snapshot: unknown;
  }): Promise<RecordingProfileReference>;
  applyProfile(input: {
    projectId: string;
    projectRevision: number;
    profile: {
      source: "builtin" | "owner-local";
      profileId: string;
      profileRevision: number;
      snapshotSha256: string;
    };
    mode: "manual" | "automated";
  }): Promise<RecordingProjectView>;
}

export interface RecordingEditorialService {
  proposeEditorial(input: {
    projectId: string;
    projectRevision: number;
  }): Promise<EditorialProposal>;
  applyAcceptedEditorialProposal(input: {
    projectId: string;
    projectRevision: number;
    proposalSha256: string;
    acceptedZoomProposalIds: readonly string[];
  }): Promise<RecordingProjectView>;
}

export type RecordingMcpService = RecordingSessionService &
  Partial<RecordingProjectService> &
  Partial<RecordingProfileService> &
  Partial<RecordingEditorialService>;
