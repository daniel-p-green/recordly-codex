import { z } from "zod";

const safeText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every(
          (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
        ),
      "must not contain control characters",
    );

const identifier = safeText(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
  "must be a safe identifier",
);
const finiteNumber = z.number().finite();
const semanticEventBase = {
  type: z.enum(["pointer", "click", "scroll", "navigation", "viewport", "marker"]),
};

const semanticBrowserEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...semanticEventBase,
      type: z.literal("pointer"),
      data: z
        .object({
          x: finiteNumber,
          y: finiteNumber,
          buttons: z.number().int().nonnegative(),
          source: z.enum(["planned", "observed"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...semanticEventBase,
      type: z.literal("click"),
      data: z
        .object({
          x: finiteNumber,
          y: finiteNumber,
          button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          targetLabel: safeText(120).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...semanticEventBase,
      type: z.literal("scroll"),
      data: z
        .object({ x: finiteNumber, y: finiteNumber, deltaX: finiteNumber, deltaY: finiteNumber })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...semanticEventBase,
      type: z.literal("navigation"),
      data: z.object({ origin: safeText(512) }).strict(),
    })
    .strict(),
  z
    .object({
      ...semanticEventBase,
      type: z.literal("viewport"),
      data: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          deviceScaleFactor: finiteNumber,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...semanticEventBase,
      type: z.literal("marker"),
      data: z.object({ id: identifier }).strict(),
    })
    .strict(),
]);

export const createRecordingSessionInputSchema = z
  .object({
    url: safeText(2_048),
    objective: safeText(2_000),
    allowPrivateOrigin: z.boolean().optional(),
    maxCaptureSeconds: z.number().int().min(1).max(300).optional(),
    maxAcceptedFrames: z.number().int().min(1).max(9_000).optional(),
    maxAcceptedBytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024)
      .optional(),
  })
  .strict();
export const recordBrowserEventInputSchema = z
  .object({ sessionId: identifier, event: semanticBrowserEventSchema })
  .strict();
export const inspectRecordingSessionInputSchema = z.object({ sessionId: identifier }).strict();
export const sealRecordingCaptureInputSchema = z.object({ sessionId: identifier }).strict();
export const discardRecordingSessionInputSchema = z
  .object({ sessionId: identifier, reason: safeText(240).optional() })
  .strict();
export const createRecordingProjectInputSchema = z
  .object({
    sessionId: identifier,
    projectId: identifier.optional(),
    automatedRevisionLimit: z.number().int().min(0).max(16).optional(),
  })
  .strict();
export const inspectRecordingProjectInputSchema = z.object({ projectId: identifier }).strict();
export const reviseRecordingProjectInputSchema = z
  .object({ project: z.unknown(), mode: z.enum(["manual", "automated"]).optional() })
  .strict();
const profileSourceSchema = z.enum(["builtin", "owner-local"]);
const profileDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const profileRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const profileLocatorInputSchema = z
  .object({
    source: profileSourceSchema,
    profileId: identifier,
  })
  .strict();
const profileVersionInputSchema = profileLocatorInputSchema
  .extend({
    profileRevision: profileRevisionSchema,
    snapshotSha256: profileDigestSchema,
  })
  .strict();
export const listRecordingProfilesInputSchema = z.object({}).strict();
export const getRecordingProfileInputSchema = profileLocatorInputSchema;
export const createRecordingProfileInputSchema = z
  .object({ profileId: identifier, snapshot: z.unknown() })
  .strict();
export const updateRecordingProfileInputSchema = z
  .object({
    profileId: identifier,
    expectedRevision: profileRevisionSchema,
    expectedSnapshotSha256: profileDigestSchema,
    snapshot: z.unknown(),
  })
  .strict();
export const applyRecordingProfileInputSchema = z
  .object({
    projectId: identifier,
    projectRevision: z.number().int().nonnegative(),
    profile: profileVersionInputSchema,
    mode: z.enum(["manual", "automated"]).optional(),
  })
  .strict();
export const renderRecordingProjectInputSchema = z
  .object({ projectId: identifier, revision: z.number().int().nonnegative() })
  .strict();
export const inspectRecordingProjectPreviewInputSchema = renderRecordingProjectInputSchema;
const mediaImportFileName = safeText(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
  "must be a bounded relative file name",
);
export const importRecordingProjectMediaInputSchema = z
  .object({
    projectId: identifier,
    revision: z.number().int().nonnegative(),
    fileName: mediaImportFileName,
  })
  .strict();
const previewJudgmentIssueInputSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    severity: z.enum(["blocking", "major", "minor"]),
    region: z.enum(["timeline", "presentation", "audio", "captions", "output"]),
    startUs: z.number().int().min(0).max(86_400_000_000),
    endUs: z.number().int().min(0).max(86_400_000_000),
    evidence: safeText(240),
  })
  .strict()
  .refine((issue) => issue.endUs >= issue.startUs, "must be an ordered time range");
export const judgeRecordingProjectPreviewInputSchema = z
  .object({
    projectId: identifier,
    revision: z.number().int().nonnegative(),
    projectSha256: profileDigestSchema,
    previewArtifactSha256: profileDigestSchema,
    verdict: z.enum(["accept", "revise", "reject"]),
    issues: z.array(previewJudgmentIssueInputSchema).max(12),
  })
  .strict();
export const proposeRecordingProjectEditorialInputSchema = z
  .object({ projectId: identifier, projectRevision: z.number().int().nonnegative() })
  .strict();
export const applyAcceptedEditorialProposalInputSchema = z
  .object({
    projectId: identifier,
    projectRevision: z.number().int().nonnegative(),
    proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    acceptedZoomProposalIds: z.array(identifier).min(1).max(32),
  })
  .strict()
  .refine(
    (value) => new Set(value.acceptedZoomProposalIds).size === value.acceptedZoomProposalIds.length,
    "accepted zoom proposal IDs must be unique",
  );

const absoluteArtifactPath = z.string().min(2);
export const sessionOutputSchema = z
  .object({
    sessionId: identifier,
    requestId: identifier,
    status: z.enum(["open", "sealed", "discarded"]),
    eventCount: z.number().int().nonnegative(),
    artifactRoot: absoluteArtifactPath,
    browserStartHelperPath: absoluteArtifactPath,
    browserStopHelperPath: absoluteArtifactPath,
    captureConfigPath: absoluteArtifactPath,
    artifactPaths: z.array(absoluteArtifactPath),
    videoPath: absoluteArtifactPath.optional(),
    manifestPath: absoluteArtifactPath.optional(),
    qualityReportPath: absoluteArtifactPath.optional(),
    capture: z
      .object({
        phase: z.enum(["ready", "claimed", "running", "stopped", "failed"]),
        maxCaptureSeconds: z.number().int().positive().max(300),
        maxAcceptedFrames: z.number().int().positive().max(9_000),
        maxAcceptedBytes: z
          .number()
          .int()
          .positive()
          .max(512 * 1024 * 1024),
        acceptedFrames: z.number().int().nonnegative(),
        acceptedBytes: z.number().int().nonnegative(),
        reason: z.literal("budget_exceeded").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const toolOperationSchema = z.enum([
  "create_recording_session",
  "record_browser_event",
  "inspect_recording_session",
  "seal_recording_capture",
  "discard_recording_session",
  "create_recording_project",
  "inspect_recording_project",
  "revise_recording_project",
  "render_recording_project_preview",
  "render_recording_project_final",
  "inspect_recording_project_preview",
  "judge_recording_project_preview",
  "import_recording_project_media",
  "list_recording_profiles",
  "get_recording_profile",
  "create_recording_profile",
  "update_recording_profile",
  "apply_recording_profile",
  "propose_recording_project_editorial",
  "apply_accepted_recording_project_editorial",
]);

const projectOutputSchema = z
  .object({
    project: z.unknown(),
    projectSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const renderOutputSchema = z
  .object({
    kind: z.enum(["preview", "final"]),
    revision: z.number().int().nonnegative(),
    format: z.enum(["mp4", "gif"]),
    artifact: safeText(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const previewInspectionOutputSchema = z
  .object({
    projectId: identifier,
    revision: z.number().int().nonnegative(),
    projectSha256: profileDigestSchema,
    previewArtifactSha256: profileDigestSchema,
    previewByteLength: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    technicalQa: z
      .object({
        decodeStatus: z.literal("passed"),
        width: z.number().int().min(2).max(4096),
        height: z.number().int().min(2).max(2160),
        fps: z.number().positive().max(240),
        frameCount: z.number().int().positive().max(18_000),
        durationUs: z.number().int().positive().max(300_000_000),
        pixelFormat: safeText(32),
        colorRange: safeText(32),
        hasAudio: z.boolean(),
      })
      .strict(),
    contactSheet: z
      .object({
        sha256: profileDigestSchema,
        byteLength: z.number().int().positive().max(1_500_000),
        width: z.literal(960),
        height: z.number().int().min(2).max(2160),
        timestampsUs: z.array(z.number().int().nonnegative().max(300_000_000)).length(3),
      })
      .strict(),
  })
  .strict();
const previewJudgmentOutputSchema = z
  .object({
    status: z.enum(["current", "stale"]),
    verdict: z.enum(["accept", "revise", "reject"]),
    revision: z.number().int().nonnegative(),
    issues: z
      .array(
        z
          .object({
            code: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
            severity: z.enum(["blocking", "major", "minor"]),
            region: z.enum(["timeline", "presentation", "audio", "captions", "output"]),
            startUs: z.number().int().nonnegative(),
            endUs: z.number().int().nonnegative(),
            evidence: safeText(240),
          })
          .strict(),
      )
      .max(12),
    remainingAutomatedRevisionBudget: z.number().int().nonnegative().max(16),
  })
  .strict();
const importedMediaOutputSchema = z
  .object({
    mediaId: z.string().regex(/^(?:media|audio)_[a-f0-9]{32}$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.enum(["image", "video", "audio"]),
    extension: z.enum(["gif", "jpg", "png", "ppm", "webp", "mov", "mp4", "webm", "wav"]),
    durationUs: z.number().int().positive().max(300_000_000),
    width: z.number().int().min(2).max(4096).optional(),
    height: z.number().int().min(2).max(2160).optional(),
    fps: z.number().positive().max(60).optional(),
    sampleRate: z.literal(48000).optional(),
    channels: z.literal(2).optional(),
  })
  .strict();
const recordingProfileSummaryOutputSchema = z
  .object({
    source: profileSourceSchema,
    profileId: identifier,
    profileRevision: profileRevisionSchema,
    snapshotSha256: profileDigestSchema,
  })
  .strict();
const recordingProfileOutputSchema = z
  .object({
    source: profileSourceSchema,
    profileId: identifier,
    profileRevision: profileRevisionSchema,
    snapshot: z.unknown(),
    snapshotSha256: profileDigestSchema,
  })
  .strict();
const editorialRangeOutputSchema = z
  .object({
    startUs: z.number().int().nonnegative().max(86_400_000_000),
    endUs: z.number().int().positive().max(86_400_000_000),
  })
  .strict();
const editorialProposalOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: identifier,
    projectRevision: z.number().int().nonnegative(),
    projectSha256: profileDigestSchema,
    sourceAnalyses: z
      .array(z.object({ sourceId: identifier, analysisSha256: profileDigestSchema }).strict())
      .max(8),
    zoomProposals: z
      .array(
        z
          .object({
            id: identifier,
            clipId: identifier,
            sourceRange: editorialRangeOutputSchema,
            focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
            scale: z.number().min(1.05).max(2),
            easing: z.literal("ease-out"),
            evidence: z
              .object({
                sourceId: identifier,
                observedEventIds: z.array(identifier).min(1).max(2048),
                observedEvidenceSha256: profileDigestSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .max(32),
    reviewTrimProposals: z
      .array(
        z
          .object({
            id: identifier,
            clipId: identifier,
            sourceRange: editorialRangeOutputSchema,
            action: z.literal("review-trim"),
            evidence: z
              .object({
                sourceId: identifier,
                activityAnalysisSha256: profileDigestSchema,
                staticFramePairs: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(64),
    transitionSuggestions: z
      .array(
        z
          .object({
            id: identifier,
            fromClipId: identifier,
            toClipId: identifier,
            family: z.literal("cut"),
            durationUs: z.literal(0),
            evidence: z.object({ fromSourceId: identifier, toSourceId: identifier }).strict(),
          })
          .strict(),
      )
      .max(31),
    proposalSha256: profileDigestSchema,
  })
  .strict();

const successfulSessionOutputSchema = <
  Operation extends
    | "create_recording_session"
    | "record_browser_event"
    | "inspect_recording_session"
    | "seal_recording_capture"
    | "discard_recording_session",
>(
  operation: Operation,
) =>
  z
    .object({
      ok: z.literal(true),
      operation: z.literal(operation),
      session: sessionOutputSchema,
    })
    .strict();
const successfulProjectOutputSchema = <
  Operation extends
    | "create_recording_project"
    | "inspect_recording_project"
    | "revise_recording_project"
    | "apply_recording_profile"
    | "apply_accepted_recording_project_editorial",
>(
  operation: Operation,
) =>
  z
    .object({
      ok: z.literal(true),
      operation: z.literal(operation),
      project: projectOutputSchema,
    })
    .strict();
const successfulRenderOutputSchema = <
  Operation extends "render_recording_project_preview" | "render_recording_project_final",
  Kind extends "preview" | "final",
>(
  operation: Operation,
  kind: Kind,
) =>
  z
    .object({
      ok: z.literal(true),
      operation: z.literal(operation),
      project: projectOutputSchema,
      render: renderOutputSchema.extend({ kind: z.literal(kind) }),
    })
    .strict();

export const successfulToolOutputSchema = z.union([
  successfulSessionOutputSchema("create_recording_session"),
  successfulSessionOutputSchema("record_browser_event"),
  successfulSessionOutputSchema("inspect_recording_session"),
  successfulSessionOutputSchema("seal_recording_capture"),
  successfulSessionOutputSchema("discard_recording_session"),
  successfulProjectOutputSchema("create_recording_project"),
  successfulProjectOutputSchema("inspect_recording_project"),
  successfulProjectOutputSchema("revise_recording_project"),
  successfulRenderOutputSchema("render_recording_project_preview", "preview"),
  successfulRenderOutputSchema("render_recording_project_final", "final"),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("inspect_recording_project_preview"),
      inspection: previewInspectionOutputSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("judge_recording_project_preview"),
      project: projectOutputSchema,
      judgment: previewJudgmentOutputSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("import_recording_project_media"),
      media: importedMediaOutputSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("list_recording_profiles"),
      profiles: z.array(recordingProfileSummaryOutputSchema).max(35),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("get_recording_profile"),
      profile: recordingProfileOutputSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("create_recording_profile"),
      profile: recordingProfileOutputSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("update_recording_profile"),
      profile: recordingProfileOutputSchema,
    })
    .strict(),
  successfulProjectOutputSchema("apply_recording_profile"),
  successfulProjectOutputSchema("apply_accepted_recording_project_editorial"),
  z
    .object({
      ok: z.literal(true),
      operation: z.literal("propose_recording_project_editorial"),
      proposal: editorialProposalOutputSchema,
    })
    .strict(),
]);
export const failedToolOutputSchema = z
  .object({
    ok: z.literal(false),
    operation: toolOperationSchema,
    error: z
      .object({ code: z.enum(["invalid_input", "service_unavailable", "operation_failed"]) })
      .strict(),
  })
  .strict();
/**
 * MCP SDK 1.30 extracts output schemas as top-level Zod objects. Keep this
 * object-shaped while enforcing the success/error variants in Zod itself.
 */
export const toolOutputSchema = z
  .object({
    ok: z.boolean(),
    operation: toolOperationSchema,
    session: sessionOutputSchema.optional(),
    project: projectOutputSchema.optional(),
    render: renderOutputSchema.optional(),
    inspection: previewInspectionOutputSchema.optional(),
    judgment: previewJudgmentOutputSchema.optional(),
    media: importedMediaOutputSchema.optional(),
    profiles: z.array(recordingProfileSummaryOutputSchema).max(35).optional(),
    profile: recordingProfileOutputSchema.optional(),
    proposal: editorialProposalOutputSchema.optional(),
    error: z
      .object({ code: z.enum(["invalid_input", "service_unavailable", "operation_failed"]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const variant = value.ok ? successfulToolOutputSchema : failedToolOutputSchema;
    if (!variant.safeParse(value).success) {
      context.addIssue({ code: "custom", message: "must match its declared tool result variant" });
    }
  });

export type CreateRecordingSessionInput = z.infer<typeof createRecordingSessionInputSchema>;
export type RecordBrowserEventInput = z.infer<typeof recordBrowserEventInputSchema>;
export type InspectRecordingSessionInput = z.infer<typeof inspectRecordingSessionInputSchema>;
export type SealRecordingCaptureInput = z.infer<typeof sealRecordingCaptureInputSchema>;
export type DiscardRecordingSessionInput = z.infer<typeof discardRecordingSessionInputSchema>;
export type CreateRecordingProjectInput = z.infer<typeof createRecordingProjectInputSchema>;
export type InspectRecordingProjectInput = z.infer<typeof inspectRecordingProjectInputSchema>;
export type ReviseRecordingProjectInput = z.infer<typeof reviseRecordingProjectInputSchema>;
export type ListRecordingProfilesInput = z.infer<typeof listRecordingProfilesInputSchema>;
export type GetRecordingProfileInput = z.infer<typeof getRecordingProfileInputSchema>;
export type CreateRecordingProfileInput = z.infer<typeof createRecordingProfileInputSchema>;
export type UpdateRecordingProfileInput = z.infer<typeof updateRecordingProfileInputSchema>;
export type ApplyRecordingProfileInput = z.infer<typeof applyRecordingProfileInputSchema>;
export type RenderRecordingProjectInput = z.infer<typeof renderRecordingProjectInputSchema>;
export type InspectRecordingProjectPreviewInput = z.infer<
  typeof inspectRecordingProjectPreviewInputSchema
>;
export type ImportRecordingProjectMediaInput = z.infer<
  typeof importRecordingProjectMediaInputSchema
>;
export type JudgeRecordingProjectPreviewInput = z.infer<
  typeof judgeRecordingProjectPreviewInputSchema
>;
export type ProposeRecordingProjectEditorialInput = z.infer<
  typeof proposeRecordingProjectEditorialInputSchema
>;
export type ApplyAcceptedEditorialProposalInput = z.infer<
  typeof applyAcceptedEditorialProposalInputSchema
>;
export type SessionOutput = z.infer<typeof sessionOutputSchema>;
export type SuccessfulToolOutput = z.infer<typeof successfulToolOutputSchema>;
