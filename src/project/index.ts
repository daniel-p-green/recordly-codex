export { ContractValidationError } from "../contracts/errors.js";
export {
  assertCaptureSourceGeometryBounded,
  isCaptureSourceGeometryBounded,
  MAX_CAPTURE_SOURCE_HEIGHT,
  MAX_CAPTURE_SOURCE_PIXELS,
  MAX_CAPTURE_SOURCE_WIDTH,
  MIN_CAPTURE_SOURCE_DIMENSION,
} from "./capture-geometry.js";
export type { CaptureSourceGeometry } from "./capture-geometry.js";
export {
  assertProjectTextReadyForExport,
  canonicalRecordingProject,
  MAX_AUTOMATED_PROJECT_REVISIONS,
  migrateV1RecordingProject,
  reviseRecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "./recording-project.js";
export type {
  AuthoredProjectText,
  ProjectAssetReference,
  ProjectCaptureSource,
  ProjectMediaAsset,
  ProjectRenderInput,
  RecordingProject,
  RecordingProjectV1,
  RecordingProjectV2,
} from "./types.js";
export {
  builtInRecordingProfiles,
  applyRecordingProfile,
  profileSnapshotSha256,
  validateRecordingProfileReference,
  validateRecordingProfileSnapshot,
} from "./recording-profile.js";
export type {
  RecordingProfileApplicationMode,
  RecordingProfileReference,
  RecordingProfileSnapshot,
} from "./recording-profile.js";
