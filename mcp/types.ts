import type { RecordingProject } from "../src/project/index.js";

export type RecordingSessionStatus = "open" | "sealed" | "discarded";

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
  browserStartHelperPath: string;
  browserStopHelperPath: string;
  captureConfigPath: string;
  artifactPaths: readonly string[];
  videoPath?: string;
  manifestPath?: string;
  qualityReportPath?: string;
};

export interface RecordingSessionService {
  create(input: {
    url: string;
    objective: string;
    allowedOrigins?: readonly string[];
    allowPrivateOrigin?: boolean;
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
  render?: {
    kind: "preview" | "final";
    revision: number;
    format: "mp4" | "gif";
    /** A safe relative artifact name, never a filesystem path. */
    artifact: string;
    sha256: string;
  };
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
  /** Set only after the renderer's current safety checklist clears. */
  renderProjectEnabled?: boolean;
}

export type RecordingMcpService = RecordingSessionService & Partial<RecordingProjectService>;
