/** Bounded, privacy-safe machine reasons for supported MCP operation failures. */
export const DIAGNOSTIC_REASONS = [
  "backpressure",
  "broker_interrupted",
  "budget_exceeded",
  "final_publication_failed",
  "incomplete_capture",
  "invalid_input",
  "stale_preview_judgment",
  "unsupported_state",
] as const;

export type DiagnosticReason = (typeof DIAGNOSTIC_REASONS)[number];

export type DiagnosticCode = "invalid_input" | "service_unavailable" | "operation_failed";

const reasonSet = new Set<string>(DIAGNOSTIC_REASONS);

export function isDiagnosticReason(value: unknown): value is DiagnosticReason {
  return typeof value === "string" && reasonSet.has(value);
}

/**
 * Fail-closed service error with a stable reason code and no private payload.
 * Message equals the reason so logs never carry tokens, paths, URLs, or page text.
 */
export class RecordingDiagnosticError extends Error {
  public constructor(
    public readonly code: DiagnosticCode,
    public readonly reason: DiagnosticReason,
  ) {
    super(reason);
    this.name = "RecordingDiagnosticError";
  }
}
