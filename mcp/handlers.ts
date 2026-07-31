import { type EditorialProposal, validateEditorialProposal } from "../src/analysis/index.js";
import {
  validateRecordingProfileReference,
  validateRecordingProject,
} from "../src/project/index.js";
import { isContainedAbsoluteChild } from "../src/safe/path.js";
import {
  type DiagnosticCode,
  type DiagnosticReason,
  RecordingDiagnosticError,
} from "./diagnostics.js";
import type { PreviewInspection } from "./preview-inspection.js";
import type {
  ApplyAcceptedEditorialProposalInput,
  ApplyRecordingProfileInput,
  CreateRecordingProfileInput,
  CreateRecordingProjectInput,
  CreateRecordingSessionInput,
  DiscardRecordingSessionInput,
  GetRecordingProfileInput,
  ImportRecordingProjectMediaInput,
  InspectRecordingProjectInput,
  InspectRecordingProjectPreviewInput,
  InspectRecordingSessionInput,
  JudgeRecordingProjectPreviewInput,
  ListRecordingProfilesInput,
  ProposeRecordingProjectEditorialInput,
  RecordBrowserEventInput,
  RenderRecordingProjectInput,
  ReviseRecordingProjectInput,
  SealRecordingCaptureInput,
  SessionOutput,
  SuccessfulToolOutput,
  UpdateRecordingProfileInput,
} from "./schemas.js";
import { toolOutputSchema } from "./schemas.js";
import type {
  ImportedRecordingProjectMedia,
  RecordingMcpService,
  RecordingProjectView,
  RecordingSessionView,
} from "./types.js";

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
  | "render_recording_project_final"
  | "inspect_recording_project_preview"
  | "judge_recording_project_preview"
  | "import_recording_project_media"
  | "list_recording_profiles"
  | "get_recording_profile"
  | "create_recording_profile"
  | "update_recording_profile"
  | "apply_recording_profile"
  | "propose_recording_project_editorial"
  | "apply_accepted_recording_project_editorial";

type SessionOperation =
  | "create_recording_session"
  | "record_browser_event"
  | "inspect_recording_session"
  | "seal_recording_capture"
  | "discard_recording_session";

type SessionSuccess = {
  ok: true;
  operation: SessionOperation;
  session: SessionOutput;
};

type ToolErrorOutput = {
  ok: false;
  operation: Operation;
  error: { code: DiagnosticCode; reason?: DiagnosticReason };
};

type ProjectOutput = {
  project: unknown;
  projectSha256: string;
};

type RenderOutput = NonNullable<RecordingProjectView["render"]>;
type JudgmentOutput = NonNullable<RecordingProjectView["previewJudgment"]>;

type ProjectSuccess =
  | {
      ok: true;
      operation:
        | "create_recording_project"
        | "inspect_recording_project"
        | "revise_recording_project"
        | "apply_recording_profile"
        | "apply_accepted_recording_project_editorial";
      project: ProjectOutput;
    }
  | {
      ok: true;
      operation: "render_recording_project_preview" | "render_recording_project_final";
      project: ProjectOutput;
      render: RenderOutput;
    }
  | {
      ok: true;
      operation: "judge_recording_project_preview";
      project: ProjectOutput;
      judgment: JudgmentOutput;
    };

type PreviewInspectionSuccess = {
  ok: true;
  operation: "inspect_recording_project_preview";
  inspection: PreviewInspection["evidence"];
};

type MediaImportSuccess = {
  ok: true;
  operation: "import_recording_project_media";
  media: ImportedRecordingProjectMedia;
};

type ProfileSuccess = {
  ok: true;
  operation:
    | "list_recording_profiles"
    | "get_recording_profile"
    | "create_recording_profile"
    | "update_recording_profile";
  profiles?: readonly {
    source: "builtin" | "owner-local";
    profileId: string;
    profileRevision: number;
    snapshotSha256: string;
  }[];
  profile?: ReturnType<typeof validateRecordingProfileReference>;
};

type EditorialProposalSuccess = {
  ok: true;
  operation: "propose_recording_project_editorial";
  proposal: EditorialProposal;
};

export type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }
  >;
  structuredContent:
    | SuccessfulToolOutput
    | SessionSuccess
    | ProjectSuccess
    | PreviewInspectionSuccess
    | MediaImportSuccess
    | ProfileSuccess
    | EditorialProposalSuccess
    | ToolErrorOutput;
  isError?: true;
};

export class RecordingServiceUnavailableError extends Error {
  public constructor() {
    super("recording session service is unavailable");
    this.name = "RecordingServiceUnavailableError";
  }
}

function safeSession(view: RecordingSessionView): SessionOutput {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(view.sessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(view.requestId) ||
    !Number.isSafeInteger(view.eventCount) ||
    view.eventCount < 0
  ) {
    throw new Error("service returned an invalid session view");
  }
  if (
    !isContainedAbsoluteChild(view.artifactRoot, view.captureConfigPath) ||
    ![view.browserStartHelperPath, view.browserStopHelperPath].every((path) =>
      isContainedAbsoluteChild(view.browserHelperRoot, path),
    )
  ) {
    throw new Error("service returned an unsafe artifact path");
  }
  const deliveryPaths = [view.videoPath, view.manifestPath, view.qualityReportPath];
  const hasDelivery = deliveryPaths.some((path) => path !== undefined);
  if (
    hasDelivery &&
    (!deliveryPaths.every((path) => typeof path === "string") ||
      !deliveryPaths.every((path) => isContainedAbsoluteChild(view.artifactRoot, path)) ||
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
      isContainedAbsoluteChild(view.artifactRoot, path),
    ),
  };
  const capture = view.capture;
  if (
    capture !== undefined &&
    (!Number.isSafeInteger(capture.maxCaptureSeconds) ||
      capture.maxCaptureSeconds < 1 ||
      capture.maxCaptureSeconds > 300 ||
      !Number.isSafeInteger(capture.maxAcceptedFrames) ||
      capture.maxAcceptedFrames < 1 ||
      capture.maxAcceptedFrames > 9_000 ||
      !Number.isSafeInteger(capture.maxAcceptedBytes) ||
      capture.maxAcceptedBytes < 1 ||
      capture.maxAcceptedBytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(capture.acceptedFrames) ||
      capture.acceptedFrames < 0 ||
      capture.acceptedFrames > capture.maxAcceptedFrames ||
      !Number.isSafeInteger(capture.acceptedBytes) ||
      capture.acceptedBytes < 0 ||
      capture.acceptedBytes > capture.maxAcceptedBytes ||
      (capture.reason !== undefined && capture.reason !== "budget_exceeded"))
  ) {
    throw new Error("service returned invalid capture status");
  }
  const withCapture = capture === undefined ? session : { ...session, capture };
  return hasDelivery
    ? {
        ...withCapture,
        videoPath: view.videoPath as string,
        manifestPath: view.manifestPath as string,
        qualityReportPath: view.qualityReportPath as string,
      }
    : withCapture;
}

function success(operation: SessionOperation, view: RecordingSessionView): ToolResult {
  const structuredContent: SessionSuccess = {
    ok: true,
    operation,
    session: safeSession(view),
  };
  return successfulResult(structuredContent);
}

function safeProject(view: RecordingProjectView): ProjectOutput {
  const project = validateRecordingProject(view.project);
  if (!/^[a-f0-9]{64}$/u.test(view.projectSha256)) {
    throw new Error("service returned an invalid project digest");
  }
  return { project, projectSha256: view.projectSha256 };
}

function safeRender(view: RecordingProjectView): RenderOutput | undefined {
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
  const project = safeProject(view);
  switch (operation) {
    case "render_recording_project_preview":
    case "render_recording_project_final": {
      const render = safeRender(view);
      const expectedKind = operation === "render_recording_project_preview" ? "preview" : "final";
      if (render === undefined || render.kind !== expectedKind) {
        throw new Error("service returned a render for the wrong operation");
      }
      return successfulResult({ ok: true, operation, project, render });
    }
    case "judge_recording_project_preview":
      if (view.previewJudgment === undefined) {
        throw new Error("service returned no preview judgment");
      }
      return successfulResult({
        ok: true,
        operation,
        project,
        judgment: view.previewJudgment,
      });
    default:
      return successfulResult({ ok: true, operation, project });
  }
}

function previewInspectionSuccess(value: PreviewInspection): ToolResult {
  const structuredContent: PreviewInspectionSuccess = {
    ok: true,
    operation: "inspect_recording_project_preview",
    inspection: value.evidence,
  };
  if (!toolOutputSchema.safeParse(structuredContent).success) {
    throw new Error("service returned an invalid preview inspection output");
  }
  const imageBytes = Buffer.from(value.image.data, "base64");
  if (
    value.image.mimeType !== "image/png" ||
    imageBytes.length === 0 ||
    imageBytes.length > 1_500_000 ||
    imageBytes.toString("base64") !== value.image.data
  ) {
    throw new Error("service returned an invalid preview inspection image");
  }
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      { type: "image", data: value.image.data, mimeType: "image/png" },
    ],
    structuredContent,
  };
}

function successfulResult(structuredContent: ToolResult["structuredContent"]): ToolResult {
  if (!toolOutputSchema.safeParse(structuredContent).success) {
    throw new Error("service returned an invalid successful tool output");
  }
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function error(
  operation: Operation,
  code: ToolErrorOutput["error"]["code"],
  reason?: DiagnosticReason,
): ToolResult {
  const structuredContent: ToolErrorOutput = {
    ok: false,
    operation,
    error: reason === undefined ? { code } : { code, reason },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function mapCaughtError(operation: Operation, caught: unknown): ToolResult {
  if (caught instanceof RecordingServiceUnavailableError) {
    return error(operation, "service_unavailable", "unsupported_state");
  }
  if (caught instanceof RecordingDiagnosticError) {
    return error(operation, caught.code, caught.reason);
  }
  return error(operation, "operation_failed");
}

function safeProfileSummary(value: unknown): {
  source: "builtin" | "owner-local";
  profileId: string;
  profileRevision: number;
  snapshotSha256: string;
} {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertyNames(value).length !== 4
  ) {
    throw new Error("service returned an invalid profile summary");
  }
  const profile = value as {
    source?: unknown;
    profileId?: unknown;
    profileRevision?: unknown;
    snapshotSha256?: unknown;
  };
  if (
    !["builtin", "owner-local"].includes(String(profile.source)) ||
    typeof profile.profileId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profile.profileId) ||
    !Number.isSafeInteger(profile.profileRevision) ||
    (profile.profileRevision as number) < 1 ||
    typeof profile.snapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(profile.snapshotSha256)
  ) {
    throw new Error("service returned an invalid profile summary");
  }
  return {
    source: profile.source as "builtin" | "owner-local",
    profileId: profile.profileId,
    profileRevision: profile.profileRevision as number,
    snapshotSha256: profile.snapshotSha256,
  };
}

function profileSuccess(value: ProfileSuccess): ToolResult {
  return successfulResult(value);
}

function editorialProposalSuccess(value: unknown): ToolResult {
  return successfulResult({
    ok: true,
    operation: "propose_recording_project_editorial",
    proposal: validateEditorialProposal(value),
  });
}

async function execute(
  operation: SessionOperation,
  work: () => Promise<RecordingSessionView>,
): Promise<ToolResult> {
  try {
    return success(operation, await work());
  } catch (caught) {
    return mapCaughtError(operation, caught);
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
  inspectRecordingProjectPreview(input: InspectRecordingProjectPreviewInput): Promise<ToolResult>;
  judgeRecordingProjectPreview(input: JudgeRecordingProjectPreviewInput): Promise<ToolResult>;
  importRecordingProjectMedia(input: ImportRecordingProjectMediaInput): Promise<ToolResult>;
  listRecordingProfiles(input: ListRecordingProfilesInput): Promise<ToolResult>;
  getRecordingProfile(input: GetRecordingProfileInput): Promise<ToolResult>;
  createRecordingProfile(input: CreateRecordingProfileInput): Promise<ToolResult>;
  updateRecordingProfile(input: UpdateRecordingProfileInput): Promise<ToolResult>;
  applyRecordingProfile(input: ApplyRecordingProfileInput): Promise<ToolResult>;
  proposeRecordingProjectEditorial(
    input: ProposeRecordingProjectEditorialInput,
  ): Promise<ToolResult>;
  applyAcceptedRecordingProjectEditorial(
    input: ApplyAcceptedEditorialProposalInput,
  ): Promise<ToolResult>;
} {
  return {
    createRecordingSession: (input) =>
      execute("create_recording_session", () =>
        service.create({
          url: input.url,
          objective: input.objective,
          ...(input.allowPrivateOrigin === undefined
            ? {}
            : { allowPrivateOrigin: input.allowPrivateOrigin }),
          ...(input.maxCaptureSeconds === undefined
            ? {}
            : { maxCaptureSeconds: input.maxCaptureSeconds }),
          ...(input.maxAcceptedFrames === undefined
            ? {}
            : { maxAcceptedFrames: input.maxAcceptedFrames }),
          ...(input.maxAcceptedBytes === undefined
            ? {}
            : { maxAcceptedBytes: input.maxAcceptedBytes }),
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
        return error("create_recording_project", "service_unavailable", "unsupported_state");
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
      } catch (caught) {
        return mapCaughtError("create_recording_project", caught);
      }
    },
    inspectRecordingProject: async (input) => {
      if (service.inspectProject === undefined) {
        return error("inspect_recording_project", "service_unavailable", "unsupported_state");
      }
      try {
        return projectSuccess("inspect_recording_project", await service.inspectProject(input));
      } catch (caught) {
        return mapCaughtError("inspect_recording_project", caught);
      }
    },
    reviseRecordingProject: async (input) => {
      if (service.reviseProject === undefined) {
        return error("revise_recording_project", "service_unavailable", "unsupported_state");
      }
      try {
        return projectSuccess(
          "revise_recording_project",
          await service.reviseProject({ project: input.project, mode: input.mode ?? "manual" }),
        );
      } catch (caught) {
        return mapCaughtError("revise_recording_project", caught);
      }
    },
    renderRecordingProjectPreview: async (input) => {
      if (service.renderProject === undefined) {
        return error(
          "render_recording_project_preview",
          "service_unavailable",
          "unsupported_state",
        );
      }
      try {
        return projectSuccess(
          "render_recording_project_preview",
          await service.renderProject({ ...input, kind: "preview" }),
        );
      } catch (caught) {
        return mapCaughtError("render_recording_project_preview", caught);
      }
    },
    renderRecordingProjectFinal: async (input) => {
      if (service.renderProject === undefined) {
        return error("render_recording_project_final", "service_unavailable", "unsupported_state");
      }
      try {
        return projectSuccess(
          "render_recording_project_final",
          await service.renderProject({ ...input, kind: "final" }),
        );
      } catch (caught) {
        return mapCaughtError("render_recording_project_final", caught);
      }
    },
    inspectRecordingProjectPreview: async (input) => {
      if (service.inspectPreview === undefined) {
        return error(
          "inspect_recording_project_preview",
          "service_unavailable",
          "unsupported_state",
        );
      }
      try {
        return previewInspectionSuccess(await service.inspectPreview(input));
      } catch (caught) {
        return mapCaughtError("inspect_recording_project_preview", caught);
      }
    },
    judgeRecordingProjectPreview: async (input) => {
      if (service.judgePreview === undefined) {
        return error("judge_recording_project_preview", "service_unavailable", "unsupported_state");
      }
      try {
        return projectSuccess("judge_recording_project_preview", await service.judgePreview(input));
      } catch (caught) {
        return mapCaughtError("judge_recording_project_preview", caught);
      }
    },
    importRecordingProjectMedia: async (input) => {
      if (service.importProjectMedia === undefined) {
        return error("import_recording_project_media", "service_unavailable", "unsupported_state");
      }
      try {
        const media = await service.importProjectMedia(input);
        const structuredContent: MediaImportSuccess = {
          ok: true,
          operation: "import_recording_project_media",
          media,
        };
        return successfulResult(structuredContent);
      } catch (caught) {
        return mapCaughtError("import_recording_project_media", caught);
      }
    },
    listRecordingProfiles: async () => {
      if (service.listProfiles === undefined)
        return error("list_recording_profiles", "service_unavailable", "unsupported_state");
      try {
        const profiles = (await service.listProfiles({})).map(safeProfileSummary);
        if (profiles.length > 35) throw new Error("service returned too many profiles");
        return profileSuccess({ ok: true, operation: "list_recording_profiles", profiles });
      } catch (caught) {
        return mapCaughtError("list_recording_profiles", caught);
      }
    },
    getRecordingProfile: async (input) => {
      if (service.getProfile === undefined)
        return error("get_recording_profile", "service_unavailable", "unsupported_state");
      try {
        return profileSuccess({
          ok: true,
          operation: "get_recording_profile",
          profile: validateRecordingProfileReference(await service.getProfile(input)),
        });
      } catch (caught) {
        return mapCaughtError("get_recording_profile", caught);
      }
    },
    createRecordingProfile: async (input) => {
      if (service.createProfile === undefined)
        return error("create_recording_profile", "service_unavailable", "unsupported_state");
      try {
        return profileSuccess({
          ok: true,
          operation: "create_recording_profile",
          profile: validateRecordingProfileReference(await service.createProfile(input)),
        });
      } catch (caught) {
        return mapCaughtError("create_recording_profile", caught);
      }
    },
    updateRecordingProfile: async (input) => {
      if (service.updateProfile === undefined)
        return error("update_recording_profile", "service_unavailable", "unsupported_state");
      try {
        return profileSuccess({
          ok: true,
          operation: "update_recording_profile",
          profile: validateRecordingProfileReference(await service.updateProfile(input)),
        });
      } catch (caught) {
        return mapCaughtError("update_recording_profile", caught);
      }
    },
    applyRecordingProfile: async (input) => {
      if (service.applyProfile === undefined)
        return error("apply_recording_profile", "service_unavailable", "unsupported_state");
      try {
        return projectSuccess(
          "apply_recording_profile",
          await service.applyProfile({ ...input, mode: input.mode ?? "manual" }),
        );
      } catch (caught) {
        return mapCaughtError("apply_recording_profile", caught);
      }
    },
    proposeRecordingProjectEditorial: async (input) => {
      if (service.proposeEditorial === undefined)
        return error(
          "propose_recording_project_editorial",
          "service_unavailable",
          "unsupported_state",
        );
      try {
        return editorialProposalSuccess(await service.proposeEditorial(input));
      } catch (caught) {
        return mapCaughtError("propose_recording_project_editorial", caught);
      }
    },
    applyAcceptedRecordingProjectEditorial: async (input) => {
      if (service.applyAcceptedEditorialProposal === undefined)
        return error(
          "apply_accepted_recording_project_editorial",
          "service_unavailable",
          "unsupported_state",
        );
      try {
        return projectSuccess(
          "apply_accepted_recording_project_editorial",
          await service.applyAcceptedEditorialProposal(input),
        );
      } catch (caught) {
        return mapCaughtError("apply_accepted_recording_project_editorial", caught);
      }
    },
  };
}
