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
export { CaptureAdapter } from "./capture/index.js";
export type {
  CompiledRecording,
  CompileRecordingInput,
  CompilerProvenance,
  ImmutableFrameHash,
  QaPrecondition,
  QualityAssessment,
  RecordingManifest,
  RenderTimeline,
} from "./compiler/index.js";
export { CompilationError, compileRecording } from "./compiler/index.js";
export type { RecordingRequest, SessionEvent, SessionEventType } from "./contracts/index.js";
export {
  ContractValidationError,
  validateRecordingRequest,
  validateSessionEvent,
  validateSessionEvents,
} from "./contracts/index.js";
export { fixtureVideoContract } from "./encoder/ffmpeg.js";
export type { RenderedVideoProbe } from "./encoder/probe.js";
export { assertFixtureContract } from "./encoder/probe.js";
export type { CanonicalJsonValue } from "./manifest/index.js";
export { canonicalJson } from "./manifest/index.js";
export type {
  AuthoredProjectText,
  ProjectAssetReference,
  ProjectCaptureSource,
  ProjectRenderInput,
  RecordingProject,
} from "./project/index.js";
export {
  assertProjectTextReadyForExport,
  canonicalRecordingProject,
  MAX_AUTOMATED_PROJECT_REVISIONS,
  reviseRecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "./project/index.js";
export type {
  SourceClickSample,
  SourceCursorSample,
} from "./render/composition.js";
export type {
  ProjectRenderAssets,
  RecordingProjectRenderInput,
  RecordingProjectRenderResult,
} from "./render/project-renderer.js";
export { renderRecordingProject } from "./render/project-renderer.js";
export type { LazyRasterSource, RasterFrame } from "./render/raster-compositor.js";
export type { RenderedFixtureCandidate } from "./render/sanitized-fixture.js";
export {
  cleanupRenderedFixtureCandidate,
  renderSanitizedFixtureCandidate,
} from "./render/sanitized-fixture.js";
export type {
  RenderedSealedSession,
  TimingMode,
} from "./render/sealed-session.js";
export {
  renderSealedSession,
  SealedSessionRenderError,
} from "./render/sealed-session.js";
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
export {
  cssPointToCapturePoint,
  normalizeFrameGrid,
  selectZoomCandidates,
} from "./timeline/index.js";
