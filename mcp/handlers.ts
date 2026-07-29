import { join, resolve } from "node:path";
import type {
  CreateRecordingSessionInput,
  DiscardRecordingSessionInput,
  InspectRecordingSessionInput,
  RecordBrowserEventInput,
  SealRecordingCaptureInput,
  SuccessfulToolOutput,
} from "./schemas.js";
import type { RecordingSessionService, RecordingSessionView } from "./types.js";

type Operation =
  | "create_recording_session"
  | "record_browser_event"
  | "inspect_recording_session"
  | "seal_recording_capture"
  | "discard_recording_session";

type ToolErrorOutput = {
  ok: false;
  operation: Operation;
  error: { code: "invalid_input" | "service_unavailable" | "operation_failed" };
};

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: SuccessfulToolOutput | ToolErrorOutput;
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

export function createRecordingToolHandlers(service: RecordingSessionService): {
  createRecordingSession(input: CreateRecordingSessionInput): Promise<ToolResult>;
  recordBrowserEvent(input: RecordBrowserEventInput): Promise<ToolResult>;
  inspectRecordingSession(input: InspectRecordingSessionInput): Promise<ToolResult>;
  sealRecordingCapture(input: SealRecordingCaptureInput): Promise<ToolResult>;
  discardRecordingSession(input: DiscardRecordingSessionInput): Promise<ToolResult>;
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
  };
}
