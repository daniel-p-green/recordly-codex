export { ContractValidationError } from "../contracts/errors.js";
export {
  assertProjectTextReadyForExport,
  canonicalRecordingProject,
  MAX_AUTOMATED_PROJECT_REVISIONS,
  reviseRecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "./recording-project.js";
export type {
  AuthoredProjectText,
  ProjectAssetReference,
  ProjectCaptureSource,
  ProjectRenderInput,
  RecordingProject,
} from "./types.js";
