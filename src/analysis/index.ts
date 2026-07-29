export {
  ACTIVITY_ANALYSIS_SCHEMA_VERSION,
  type ActivityAnalysisConfig,
  type ActivityAnalysisInput,
  type ActivityAnalysisResult,
  type ActivityClassification,
  type ActivityEvidenceCounts,
  type ActivityInterval,
  analyzeDeadTime,
  type FrameSample,
  type ObservedActionKind,
  type ObservedActionSample,
  type SuggestedAction,
} from "./dead-time.js";
export type {
  EditorialObservedEvent,
  EditorialObservedEventKind,
  EditorialProposal,
  EditorialProposalInput,
  EditorialReviewTrimProposal,
  EditorialTransitionSuggestion,
  EditorialZoomProposal,
} from "./editorial-proposal.js";
export {
  applyAcceptedEditorialProposal,
  buildEditorialProposal,
  EDITORIAL_PROPOSAL_SCHEMA_VERSION,
  validateEditorialProposal,
} from "./editorial-proposal.js";
