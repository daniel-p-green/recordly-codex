import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRecordingToolHandlers } from "./handlers.js";
import {
  applyAcceptedEditorialProposalInputSchema,
  applyRecordingProfileInputSchema,
  createRecordingProfileInputSchema,
  createRecordingProjectInputSchema,
  createRecordingSessionInputSchema,
  discardRecordingSessionInputSchema,
  getRecordingProfileInputSchema,
  importRecordingProjectMediaInputSchema,
  inspectRecordingProjectInputSchema,
  inspectRecordingProjectPreviewInputSchema,
  inspectRecordingSessionInputSchema,
  judgeRecordingProjectPreviewInputSchema,
  listRecordingProfilesInputSchema,
  proposeRecordingProjectEditorialInputSchema,
  recordBrowserEventInputSchema,
  renderRecordingProjectInputSchema,
  reviseRecordingProjectInputSchema,
  sealRecordingCaptureInputSchema,
  toolOutputSchema,
  updateRecordingProfileInputSchema,
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
  const server = new McpServer({ name: "recordly-codex-mcp-server", version: "1.0.0" });
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
    if (service.judgePreview !== undefined) {
      server.registerTool(
        "judge_recording_project_preview",
        {
          title: "Judge recording project preview",
          description:
            "Persist a bounded preview verdict for the current rendered project revision without editing it.",
          inputSchema: judgeRecordingProjectPreviewInputSchema,
          outputSchema: toolOutputSchema,
          annotations: mutationAnnotations,
        },
        handlers.judgeRecordingProjectPreview,
      );
    }
    if (service.inspectPreview !== undefined) {
      server.registerTool(
        "inspect_recording_project_preview",
        {
          title: "Inspect rendered project preview",
          description:
            "Decode the exact current private preview into bounded visual evidence and technical QA for judgment.",
          inputSchema: inspectRecordingProjectPreviewInputSchema,
          outputSchema: toolOutputSchema,
          annotations: readOnlyAnnotations,
        },
        handlers.inspectRecordingProjectPreview,
      );
    }
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
    server.registerTool(
      "import_recording_project_media",
      {
        title: "Import private project media",
        description:
          "Import one image, video, or audio file from the runtime-configured authorized directory without exposing its path.",
        inputSchema: importRecordingProjectMediaInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.importRecordingProjectMedia,
    );
    if (
      service.proposeEditorial !== undefined &&
      service.applyAcceptedEditorialProposal !== undefined
    ) {
      server.registerTool(
        "propose_recording_project_editorial",
        {
          title: "Propose evidence-backed editorial zooms",
          description:
            "Analyze the exact V2 project revision from its sealed capture evidence and return a canonical review proposal.",
          inputSchema: proposeRecordingProjectEditorialInputSchema,
          outputSchema: toolOutputSchema,
          annotations: readOnlyAnnotations,
        },
        handlers.proposeRecordingProjectEditorial,
      );
      server.registerTool(
        "apply_accepted_recording_project_editorial",
        {
          title: "Apply accepted editorial zooms",
          description:
            "Apply accepted zoom proposal IDs from the exact current canonical proposal as one automated project revision.",
          inputSchema: applyAcceptedEditorialProposalInputSchema,
          outputSchema: toolOutputSchema,
          annotations: mutationAnnotations,
        },
        handlers.applyAcceptedRecordingProjectEditorial,
      );
    }
  }
  if (
    service.listProfiles !== undefined &&
    service.getProfile !== undefined &&
    service.createProfile !== undefined &&
    service.updateProfile !== undefined &&
    service.applyProfile !== undefined
  ) {
    server.registerTool(
      "list_recording_profiles",
      {
        title: "List recording profiles",
        description: "List the fixed built-ins and the caller-owned local profile summaries.",
        inputSchema: listRecordingProfilesInputSchema,
        outputSchema: toolOutputSchema,
        annotations: readOnlyAnnotations,
      },
      handlers.listRecordingProfiles,
    );
    server.registerTool(
      "get_recording_profile",
      {
        title: "Get recording profile",
        description: "Load one canonical built-in or caller-owned local recording profile.",
        inputSchema: getRecordingProfileInputSchema,
        outputSchema: toolOutputSchema,
        annotations: readOnlyAnnotations,
      },
      handlers.getRecordingProfile,
    );
    server.registerTool(
      "create_recording_profile",
      {
        title: "Create recording profile",
        description:
          "Create one owner-local recording profile at revision 1 from a strict snapshot.",
        inputSchema: createRecordingProfileInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.createRecordingProfile,
    );
    server.registerTool(
      "update_recording_profile",
      {
        title: "Update recording profile",
        description:
          "Replace one owner-local recording profile with an exact revision and digest CAS.",
        inputSchema: updateRecordingProfileInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.updateRecordingProfile,
    );
    server.registerTool(
      "apply_recording_profile",
      {
        title: "Apply recording profile",
        description:
          "Apply one exact canonical profile to one exact current project as a single editorial revision.",
        inputSchema: applyRecordingProfileInputSchema,
        outputSchema: toolOutputSchema,
        annotations: mutationAnnotations,
      },
      handlers.applyRecordingProfile,
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
