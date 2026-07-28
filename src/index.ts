export {
  ContractValidationError,
  validateRecordingRequest,
  validateSessionEvent,
  validateSessionEvents,
} from "./contracts/index.js";
export type { RecordingRequest, SessionEvent, SessionEventType } from "./contracts/index.js";

export { CaptureAdapter } from "./capture/index.js";
export type {
  CaptureAdapterOptions,
  CapturedFrame,
  CaptureFailureReason,
  CaptureHealthResult,
  CaptureTelemetry,
  CdpNotificationListener,
  CdpTransport,
  DurableFrame,
  DurableFrameStore,
} from "./capture/index.js";

export { compileRecording, CompilationError } from "./compiler/index.js";
export type {
  CompiledRecording,
  CompilerProvenance,
  CompileRecordingInput,
  ImmutableFrameHash,
  QaPrecondition,
  QualityAssessment,
  RecordingManifest,
  RenderTimeline,
} from "./compiler/index.js";

export { canonicalJson } from "./manifest/index.js";
export type { CanonicalJsonValue } from "./manifest/index.js";

export {
  cssPointToCapturePoint,
  normalizeFrameGrid,
  selectZoomCandidates,
} from "./timeline/index.js";
export type {
  CadenceGap,
  Dimensions,
  FrameGrid,
  FrameGridOptions,
  FrameSlot,
  Point,
  SelectedZoomCandidate,
  SourceFrame,
  ZoomCandidate,
  ZoomCandidateKind,
} from "./timeline/index.js";

export { fixtureVideoContract } from "./encoder/ffmpeg.js";
export { assertFixtureContract } from "./encoder/probe.js";
export type { RenderedVideoProbe } from "./encoder/probe.js";

export {
  cleanupRenderedFixtureCandidate,
  renderSanitizedFixtureCandidate,
} from "./render/sanitized-fixture.js";
export type { RenderedFixtureCandidate } from "./render/sanitized-fixture.js";
