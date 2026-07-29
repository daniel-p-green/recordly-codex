import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createRecordingSessionInputSchema,
  discardRecordingSessionInputSchema,
  inspectRecordingSessionInputSchema,
  recordBrowserEventInputSchema,
  sealRecordingCaptureInputSchema,
  toolOutputSchema,
} from "./schemas.js";
import { createRecordingToolHandlers } from "./handlers.js";
import type { RecordingSessionService } from "./types.js";

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

export function createRecordingMcpServer(service: RecordingSessionService): McpServer {
  const server = new McpServer({ name: "recordly-codex-mcp-server", version: "0.1.0" });
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
  return server;
}
