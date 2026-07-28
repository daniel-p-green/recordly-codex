import type { RecordingRequest, SessionEvent } from "../contracts/index.js";
import type { FrameSlot, SelectedZoomCandidate } from "../timeline/index.js";

export type CompilerProvenance = {
  environment: {
    codexSurface: "desktop-browser";
    browserProtocol: string;
    runtime: string;
  };
  renderer: {
    name: string;
    version: string;
    profile: string;
    implementationSha256: string;
  };
};

export type ImmutableFrameHash = {
  frameId: number;
  imagePath: string;
  sha256: string;
};

export type QaPrecondition = {
  id: "frame-coverage" | "frame-cadence" | "capture-health" | "navigation";
  status: "pass" | "warn" | "fail";
  reason: string;
};

export type QualityAssessment = {
  status: "ready" | "blocked";
  preconditions: QaPrecondition[];
};

export type RecordingManifest = {
  schemaVersion: 1;
  request: {
    requestId: string;
    objective: string;
    target: { origin: string; path: string };
  };
  sessionId: string;
  provenance: CompilerProvenance;
  redactions: { query: "omitted"; fragment: "omitted"; credentials: "omitted" };
  artifacts: ImmutableFrameHash[];
  events: SessionEvent[];
};

export type RenderTimeline = {
  schemaVersion: 1;
  requestId: string;
  sessionId: string;
  durationUs: number;
  fps: number;
  cfrSlots: FrameSlot[];
  cursorTrack: Array<{
    tUs: number;
    x: number;
    y: number;
    buttons: number;
    source: "planned" | "observed";
  }>;
  clickTrack: Array<{
    tUs: number;
    x: number;
    y: number;
    button: 0 | 1 | 2;
    targetLabel?: string;
  }>;
  zoomCandidates: SelectedZoomCandidate[];
  qa: QualityAssessment;
};

export type CompileRecordingInput = {
  request: RecordingRequest | unknown;
  events: readonly (SessionEvent | unknown)[];
  frameHashes: readonly (ImmutableFrameHash | unknown)[];
  provenance: CompilerProvenance | unknown;
};

export type CompiledRecording = {
  manifest: RecordingManifest;
  timeline: RenderTimeline;
  canonical: { manifest: string; timeline: string };
  hashes: { manifestSha256: string; timelineSha256: string };
};
