import { join, resolve } from "node:path";
import { validateRecordingProject } from "../src/project/index.js";
import type {
  CreateRecordingProjectInput,
  CreateRecordingSessionInput,
  DiscardRecordingSessionInput,
  InspectRecordingProjectInput,
  InspectRecordingSessionInput,
  RecordBrowserEventInput,
  RenderRecordingProjectInput,
  ReviseRecordingProjectInput,
  SealRecordingCaptureInput,
  SuccessfulToolOutput,
} from "./schemas.js";
import type { RecordingMcpService, RecordingProjectView, RecordingSessionView } from "./types.js";

type Operation =
  | "create_recording_session"
  | "record_browser_event"
  | "inspect_recording_session"
  | "seal_recording_capture"
  | "discard_recording_session"
  | "create_recording_project"
  | "inspect_recording_project"
  | "revise_recording_project"
  | "render_recording_project_preview"
  | "render_recording_project_final";

type ToolErrorOutput = {
  ok: false;
  operation: Operation;
  error: { code: "invalid_input" | "service_unavailable" | "operation_failed" };
};

type ProjectSuccess = {
  ok: true;
  operation: Exclude<
    Operation,
    | "create_recording_session"
    | "record_browser_event"
    | "inspect_recording_session"
    | "seal_recording_capture"
    | "discard_recording_session"
  >;
  project: { project: unknown; projectSha256: string };
  render?: {
    kind: "preview" | "final";
    revision: number;
    format: "mp4" | "gif";
    artifact: string;
    sha256: string;
  };
};

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: SuccessfulToolOutput | ProjectSuccess | ToolErrorOutput;
  isError?: true;
};

export class RecordingServiceUnavailableError extends Error {
  public constructor() {
    super("recording session service is unavailable");
    this.name = "RecordingServiceUnavailableError";
  }
}

function containedAbsolutePath(root: string, value: string): boolean {
  if (
    !root.startsWith("/") ||
    root === "/" ||
    root.includes("\\") ||
    root.includes("..") ||
    value.includes("\\")
  ) {
    return false;
  }
  if (!value.startsWith(`${root}/`) || value.includes("..")) return false;
  return value
    .split("/")
    .slice(1)
    .every((segment) => segment.length > 0 && segment !== ".");
}

function safeSession(view: RecordingSessionView): SuccessfulToolOutput["session"] {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(view.sessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(view.requestId) ||
    !Number.isSafeInteger(view.eventCount) ||
    view.eventCount < 0
  ) {
    throw new Error("service returned an invalid session view");
  }
  const browserHelperRoot = join(resolve(process.cwd()), ".playwright-mcp", "recordly-codex");
  if (
    !containedAbsolutePath(view.artifactRoot, view.captureConfigPath) ||
    ![view.browserStartHelperPath, view.browserStopHelperPath].every((path) =>
      containedAbsolutePath(browserHelperRoot, path),
    )
  ) {
    throw new Error("service returned an unsafe artifact path");
  }
  const deliveryPaths = [view.videoPath, view.manifestPath, view.qualityReportPath];
  const hasDelivery = deliveryPaths.some((path) => path !== undefined);
  if (
    hasDelivery &&
    (!deliveryPaths.every((path) => typeof path === "string") ||
      !deliveryPaths.every((path) => containedAbsolutePath(view.artifactRoot, path)) ||
      view.artifactPaths.length !== deliveryPaths.length ||
      view.artifactPaths.some((path, index) => path !== deliveryPaths[index]))
  ) {
    throw new Error("service returned an unsafe delivery artifact path");
  }
  const session = {
    sessionId: view.sessionId,
    requestId: view.requestId,
    status: view.status,
    eventCount: view.eventCount,
    artifactRoot: view.artifactRoot,
    browserStartHelperPath: view.browserStartHelperPath,
    browserStopHelperPath: view.browserStopHelperPath,
    captureConfigPath: view.captureConfigPath,
    artifactPaths: view.artifactPaths.filter((path) =>
      containedAbsolutePath(view.artifactRoot, path),
    ),
  };
  return hasDelivery
    ? {
        ...session,
        videoPath: view.videoPath as string,
        manifestPath: view.manifestPath as string,
        qualityReportPath: view.qualityReportPath as string,
      }
    : session;
}

function success(operation: Operation, view: RecordingSessionView): ToolResult {
  const structuredContent: SuccessfulToolOutput = {
    ok: true,
    operation,
    session: safeSession(view),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function safeProject(view: RecordingProjectView): ProjectSuccess["project"] {
  const project = validateRecordingProject(view.project);
  if (!/^[a-f0-9]{64}$/u.test(view.projectSha256)) {
    throw new Error("service returned an invalid project digest");
  }
  return { project, projectSha256: view.projectSha256 };
}

function safeRender(view: RecordingProjectView): ProjectSuccess["render"] | undefined {
  if (view.render === undefined) return undefined;
  const { artifact } = view.render;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(artifact) ||
    artifact.includes("..") ||
    artifact.startsWith("/") ||
    !/^[a-f0-9]{64}$/u.test(view.render.sha256)
  ) {
    throw new Error("service returned an unsafe render artifact");
  }
  return view.render;
}

function projectSuccess(
  operation: ProjectSuccess["operation"],
  view: RecordingProjectView,
): ToolResult {
  const render = safeRender(view);
  const structuredContent: ProjectSuccess = {
    ok: true,
    operation,
    project: safeProject(view),
    ...(render === undefined ? {} : { render }),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function error(operation: Operation, code: ToolErrorOutput["error"]["code"]): ToolResult {
  const structuredContent: ToolErrorOutput = { ok: false, operation, error: { code } };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

async function execute(
  operation: Operation,
  work: () => Promise<RecordingSessionView>,
): Promise<ToolResult> {
  try {
    return success(operation, await work());
  } catch (caught) {
    if (caught instanceof RecordingServiceUnavailableError)
      return error(operation, "service_unavailable");
    return error(operation, "operation_failed");
  }
}

export function createRecordingToolHandlers(service: RecordingMcpService): {
  createRecordingSession(input: CreateRecordingSessionInput): Promise<ToolResult>;
  recordBrowserEvent(input: RecordBrowserEventInput): Promise<ToolResult>;
  inspectRecordingSession(input: InspectRecordingSessionInput): Promise<ToolResult>;
  sealRecordingCapture(input: SealRecordingCaptureInput): Promise<ToolResult>;
  discardRecordingSession(input: DiscardRecordingSessionInput): Promise<ToolResult>;
  createRecordingProject(input: CreateRecordingProjectInput): Promise<ToolResult>;
  inspectRecordingProject(input: InspectRecordingProjectInput): Promise<ToolResult>;
  reviseRecordingProject(input: ReviseRecordingProjectInput): Promise<ToolResult>;
  renderRecordingProjectPreview(input: RenderRecordingProjectInput): Promise<ToolResult>;
  renderRecordingProjectFinal(input: RenderRecordingProjectInput): Promise<ToolResult>;
} {
  return {
    createRecordingSession: (input) =>
      execute("create_recording_session", () =>
        service.create({
          url: input.url,
          objective: input.objective,
          ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
          ...(input.allowPrivateOrigin === undefined
            ? {}
            : { allowPrivateOrigin: input.allowPrivateOrigin }),
        }),
      ),
    recordBrowserEvent: (input) =>
      execute("record_browser_event", () =>
        service.recordEvent({ sessionId: input.sessionId, event: input.event }),
      ),
    inspectRecordingSession: (input) =>
      execute("inspect_recording_session", () => service.inspect({ sessionId: input.sessionId })),
    sealRecordingCapture: (input) =>
      execute("seal_recording_capture", () => service.seal({ sessionId: input.sessionId })),
    discardRecordingSession: (input) =>
      execute("discard_recording_session", () =>
        service.discard(
          input.reason === undefined
            ? { sessionId: input.sessionId }
            : { sessionId: input.sessionId, reason: input.reason },
        ),
      ),
    createRecordingProject: async (input) => {
      if (service.createProject === undefined) {
        return error("create_recording_project", "service_unavailable");
      }
      try {
        return projectSuccess(
          "create_recording_project",
          await service.createProject({
            sessionId: input.sessionId,
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            ...(input.automatedRevisionLimit === undefined
              ? {}
              : { automatedRevisionLimit: input.automatedRevisionLimit }),
          }),
        );
      } catch {
        return error("create_recording_project", "operation_failed");
      }
    },
    inspectRecordingProject: async (input) => {
      if (service.inspectProject === undefined) {
        return error("inspect_recording_project", "service_unavailable");
      }
      try {
        return projectSuccess("inspect_recording_project", await service.inspectProject(input));
      } catch {
        return error("inspect_recording_project", "operation_failed");
      }
    },
    reviseRecordingProject: async (input) => {
      if (service.reviseProject === undefined) {
        return error("revise_recording_project", "service_unavailable");
      }
      try {
        return projectSuccess(
          "revise_recording_project",
          await service.reviseProject({ project: input.project, mode: input.mode ?? "manual" }),
        );
      } catch {
        return error("revise_recording_project", "operation_failed");
      }
    },
    renderRecordingProjectPreview: async (input) => {
      if (service.renderProject === undefined) {
        return error("render_recording_project_preview", "service_unavailable");
      }
      try {
        return projectSuccess(
          "render_recording_project_preview",
          await service.renderProject({ ...input, kind: "preview" }),
        );
      } catch {
        return error("render_recording_project_preview", "operation_failed");
      }
    },
    renderRecordingProjectFinal: async (input) => {
      if (service.renderProject === undefined) {
        return error("render_recording_project_final", "service_unavailable");
      }
      try {
        return projectSuccess(
          "render_recording_project_final",
          await service.renderProject({ ...input, kind: "final" }),
        );
      } catch {
        return error("render_recording_project_final", "operation_failed");
      }
    },
  };
}
