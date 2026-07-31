import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_REASONS,
  isDiagnosticReason,
  RecordingDiagnosticError,
} from "../../mcp/diagnostics.js";
import { createRecordingToolHandlers } from "../../mcp/handlers.js";
import type { RecordingMcpService } from "../../mcp/types.js";

describe("privacy-safe diagnostics", () => {
  it("exposes only bounded reason codes", () => {
    expect(DIAGNOSTIC_REASONS).toContain("stale_preview_judgment");
    expect(DIAGNOSTIC_REASONS).toContain("final_publication_failed");
    expect(isDiagnosticReason("stale_preview_judgment")).toBe(true);
    expect(isDiagnosticReason("/private/secret.json")).toBe(false);
    expect(isDiagnosticReason("https://recordly.dev/workflow")).toBe(false);
  });

  it("returns actionable structured reasons without private payloads", async () => {
    const handlers = createRecordingToolHandlers({
      renderProject: async () => {
        throw new RecordingDiagnosticError("operation_failed", "stale_preview_judgment");
      },
    } as unknown as RecordingMcpService);

    const result = await handlers.renderRecordingProjectFinal({
      projectId: "project-diagnostics",
      revision: 0,
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(result.structuredContent).toEqual({
      ok: false,
      operation: "render_recording_project_final",
      error: { code: "operation_failed", reason: "stale_preview_judgment" },
    });
    expect(serialized).not.toMatch(/\/private\/|https?:\/\/|[0-9a-f]{64}/iu);
  });

  it("maps publication failures to a bounded final_publication_failed reason", async () => {
    const handlers = createRecordingToolHandlers({
      renderProject: async () => {
        throw new RecordingDiagnosticError("operation_failed", "final_publication_failed");
      },
    } as unknown as RecordingMcpService);

    const result = await handlers.renderRecordingProjectFinal({
      projectId: "project-diagnostics",
      revision: 0,
    });
    expect(result.structuredContent).toEqual({
      ok: false,
      operation: "render_recording_project_final",
      error: { code: "operation_failed", reason: "final_publication_failed" },
    });
  });
});
