import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRecordingToolHandlers } from "./handlers.js";
import {
  createRecordingProjectInputSchema,
  createRecordingSessionInputSchema,
  discardRecordingSessionInputSchema,
  inspectRecordingProjectInputSchema,
  inspectRecordingSessionInputSchema,
  recordBrowserEventInputSchema,
  renderRecordingProjectInputSchema,
  reviseRecordingProjectInputSchema,
  sealRecordingCaptureInputSchema,
  toolOutputSchema,
} from "./schemas.js";
import type { RecordingMcpService } from "./types.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function createRecordingMcpServer(service: RecordingMcpService): McpServer {
  const server = new McpServer({ name: "recordly-codex-mcp-server", version: "0.3.0" });
  const handlers = createRecordingToolHandlers(service);
  server.registerTool(
    "create_recording_session",
    {
      title: "Create recording session",
      description: "Create a local recording session from an approved URL and recording objective.",
      inputSchema: createRecordingSessionInputSchema,
      outputSchema: toolOutputSchema,
      annotations: mutationAnnotations,
    },
    handlers.createRecordingSession,
  );
  server.registerTool(
    "record_browser_event",
    {
      title: "Record browser event",
      description: "Append one validated browser event to an open local recording session.",
      inputSchema: recordBrowserEventInputSchema,
      outputSchema: toolOutputSchema,
      annotations: mutationAnnotations,
    },
    handlers.recordBrowserEvent,
  );
  server.registerTool(
    "inspect_recording_session",
    {
      title: "Inspect recording session",
      description: "Read the safe summary and owned artifact paths for a local recording session.",
      inputSchema: inspectRecordingSessionInputSchema,
      outputSchema: toolOutputSchema,
      annotations: readOnlyAnnotations,
    },
    handlers.inspectRecordingSession,
  );
  server.registerTool(
    "seal_recording_capture",
    {
      title: "Seal recording capture",
      description: "Seal a local recording session so its captured evidence can move to rendering.",
      inputSchema: sealRecordingCaptureInputSchema,
      outputSchema: toolOutputSchema,
      annotations: mutationAnnotations,
    },
    handlers.sealRecordingCapture,
  );
  server.registerTool(
    "discard_recording_session",
    {
      title: "Discard recording session",
      description: "Discard a local recording session and its owned temporary capture artifacts.",
      inputSchema: discardRecordingSessionInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { ...mutationAnnotations, destructiveHint: true },
    },
    handlers.discardRecordingSession,
  );
  if (
    service.createProject !== undefined &&
    service.inspectProject !== undefined &&
    service.reviseProject !== undefined
  ) {
    server.registerTool(
      "create_recording_project",
      {
        title: "Create editable recording project",
        description: "Create a versioned local project from one quality-approved sealed capture.",
        inputSchema: createRecordingProjectInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.createRecordingProject,
    );
    server.registerTool(
      "inspect_recording_project",
      {
        title: "Inspect editable recording project",
        description: "Load the canonical editable project and its revision and preview status.",
        inputSchema: inspectRecordingProjectInputSchema,
        outputSchema: toolOutputSchema,
        annotations: readOnlyAnnotations,
      },
      handlers.inspectRecordingProject,
    );
    server.registerTool(
      "revise_recording_project",
      {
        title: "Revise editable recording project",
        description:
          "Replace one project with a validated monotonic full-document editorial revision.",
        inputSchema: reviseRecordingProjectInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.reviseRecordingProject,
    );
  }
  if (service.renderProject !== undefined && service.renderProjectEnabled === true) {
    server.registerTool(
      "render_recording_project_preview",
      {
        title: "Render recording project preview",
        description:
          "Render a deterministic preview only for the requested current project revision.",
        inputSchema: renderRecordingProjectInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.renderRecordingProjectPreview,
    );
    server.registerTool(
      "render_recording_project_final",
      {
        title: "Render recording project final",
        description:
          "Render a deterministic final only after a matching current preview is available.",
        inputSchema: renderRecordingProjectInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.renderRecordingProjectFinal,
    );
  }
  return server;
}
