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
]);

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
    error: z
      .object({ code: z.enum(["invalid_input", "service_unavailable", "operation_failed"]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const variant = value.ok ? successfulToolOutputSchema : failedToolOutputSchema;
    const validated = variant.safeParse(value);
    if (!validated.success) {
      context.addIssue({ code: "custom", message: "must match its declared tool result variant" });
    }
  });

export type CreateRecordingSessionInput = z.infer<typeof createRecordingSessionInputSchema>;
export type RecordBrowserEventInput = z.infer<typeof recordBrowserEventInputSchema>;
export type InspectRecordingSessionInput = z.infer<typeof inspectRecordingSessionInputSchema>;
export type SealRecordingCaptureInput = z.infer<typeof sealRecordingCaptureInputSchema>;
export type DiscardRecordingSessionInput = z.infer<typeof discardRecordingSessionInputSchema>;
export type SuccessfulToolOutput = z.infer<typeof successfulToolOutputSchema>;
