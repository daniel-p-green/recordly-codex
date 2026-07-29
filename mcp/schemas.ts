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
    allowedOrigins: z.array(safeText(512)).min(1).max(20).optional(),
    allowPrivateOrigin: z.boolean().optional(),
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
export const renderRecordingProjectInputSchema = z
  .object({ projectId: identifier, revision: z.number().int().nonnegative() })
  .strict();

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

export const successfulToolOutputSchema = z
  .object({
    ok: z.literal(true),
    operation: toolOperationSchema,
    session: sessionOutputSchema,
  })
  .strict();
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
    error: z
      .object({ code: z.enum(["invalid_input", "service_unavailable", "operation_failed"]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.ok) {
      const validated = failedToolOutputSchema.safeParse(value);
      if (!validated.success) {
        context.addIssue({
          code: "custom",
          message: "must match its declared tool result variant",
        });
      }
      return;
    }
    const sessionOperation = [
      "create_recording_session",
      "record_browser_event",
      "inspect_recording_session",
      "seal_recording_capture",
      "discard_recording_session",
    ].includes(value.operation);
    const projectOperation = [
      "create_recording_project",
      "inspect_recording_project",
      "revise_recording_project",
      "render_recording_project_preview",
      "render_recording_project_final",
    ].includes(value.operation);
    if (
      (sessionOperation && value.session === undefined) ||
      (projectOperation && value.project === undefined) ||
      (projectOperation && value.session !== undefined) ||
      (value.render !== undefined && !value.operation.startsWith("render_recording_project_"))
    ) {
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
export type RenderRecordingProjectInput = z.infer<typeof renderRecordingProjectInputSchema>;
export type SuccessfulToolOutput = z.infer<typeof successfulToolOutputSchema>;
