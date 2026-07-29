import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createRecordingToolHandlers } from "../../mcp/handlers.js";
import {
  applyAcceptedEditorialProposalInputSchema,
  createRecordingProjectInputSchema,
  importRecordingProjectMediaInputSchema,
  judgeRecordingProjectPreviewInputSchema,
  proposeRecordingProjectEditorialInputSchema,
} from "../../mcp/schemas.js";
import { createRecordingMcpServer } from "../../mcp/server-factory.js";
import type { RecordingMcpService, RecordingProjectView } from "../../mcp/types.js";
import {
  analyzeDeadTime,
  applyAcceptedEditorialProposal,
  buildEditorialProposal,
} from "../../src/analysis/index.js";
import { migrateV1RecordingProject, validateRecordingProject } from "../../src/project/index.js";

const project = validateRecordingProject({
  schemaVersion: 1,
  projectId: "project-1",
  revision: 0,
  revisionPolicy: { automatedRevisionLimit: 4, automatedRevisionCount: 0 },
  captureSources: [
    {
      id: "capture-1",
      sessionId: "session-1",
      manifestSha256: "a".repeat(64),
      timelineSha256: "b".repeat(64),
      frameSetSha256: "c".repeat(64),
      sourceWidth: 320,
      sourceHeight: 180,
      durationUs: 1_000_000,
    },
  ],
  output: {
    profile: "landscape-1080p",
    width: 1920,
    height: 1080,
    fps: 30,
    format: "mp4",
    quality: "standard",
  },
  timeline: {
    clips: [
      {
        id: "clip-1",
        sourceId: "capture-1",
        trim: { startUs: 0, endUs: 1_000_000 },
        speedRegions: [],
        zoomRegions: [],
        transitionAfter: { kind: "cut", durationUs: 0 },
      },
    ],
  },
  presentation: {
    cursor: { visible: true, preset: "system", sizePx: 28, motion: "source", clickEffect: "none" },
    frame: {
      background: { kind: "solid", color: "#111827" },
      paddingPx: 32,
      radiusPx: 16,
      shadow: "soft",
    },
  },
  overlays: { annotations: [], captions: [] },
  audioTracks: [],
  pipTracks: [],
  renderHooks: [],
  preview: { status: "not-requested" },
});

const view = { project, projectSha256: "d".repeat(64) } satisfies RecordingProjectView;

const service = {
  create: async () => {
    throw new Error("not used");
  },
  recordEvent: async () => {
    throw new Error("not used");
  },
  inspect: async () => {
    throw new Error("not used");
  },
  seal: async () => {
    throw new Error("not used");
  },
  discard: async () => {
    throw new Error("not used");
  },
  createProject: async () => view,
  inspectProject: async () => view,
  reviseProject: async () => view,
  renderProject: async ({ kind }: { kind: "preview" | "final" }) => ({
    ...view,
    render: {
      kind,
      revision: 0,
      format: "mp4" as const,
      artifact: `projects/project-1/${kind}.mp4`,
      sha256: "e".repeat(64),
    },
  }),
  renderProjectEnabled: true,
  judgePreview: async () => ({
    ...view,
    previewJudgment: {
      status: "current" as const,
      verdict: "accept" as const,
      revision: 0,
      issues: [],
      remainingAutomatedRevisionBudget: 4,
    },
  }),
  importProjectMedia: async () => ({
    mediaId: "media_0123456789abcdef0123456789abcdef",
    sha256: "a".repeat(64),
    kind: "image" as const,
    extension: "png" as const,
    durationUs: 1,
    width: 4,
    height: 2,
  }),
} satisfies RecordingMcpService;

const previewInspection = {
  evidence: {
    projectId: "project-1",
    revision: 0,
    projectSha256: "d".repeat(64),
    previewArtifactSha256: "e".repeat(64),
    previewByteLength: 12,
    technicalQa: {
      decodeStatus: "passed" as const,
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 30,
      durationUs: 1_000_000,
      pixelFormat: "yuv420p",
      colorRange: "tv",
      hasAudio: false,
    },
    contactSheet: {
      sha256: "f".repeat(64),
      byteLength: 3,
      width: 960 as const,
      height: 180,
      timestampsUs: [0, 500_000, 966_667],
    },
  },
  image: { data: "cG5n", mimeType: "image/png" as const },
};

describe("project MCP handlers", () => {
  it("returns full path-free projects and only safe relative rendered artifacts", async () => {
    const handlers = createRecordingToolHandlers(service);
    const created = await handlers.createRecordingProject({ sessionId: "session-1" });
    const revised = await handlers.reviseRecordingProject({ project, mode: "manual" });
    const preview = await handlers.renderRecordingProjectPreview({
      projectId: "project-1",
      revision: 0,
    });

    for (const result of [created, revised, preview]) {
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent)).not.toContain("/tmp/");
      expect(result.structuredContent).toMatchObject({ ok: true, project: { project } });
    }
    expect(preview.structuredContent).toMatchObject({
      render: { kind: "preview", artifact: "projects/project-1/preview.mp4" },
    });
    expect(
      createRecordingProjectInputSchema.safeParse({ sessionId: "session-1", unsafe: true }).success,
    ).toBe(false);
    expect(
      judgeRecordingProjectPreviewInputSchema.safeParse({
        projectId: "project-1",
        revision: 0,
        verdict: "accept",
        issues: [],
        previewPath: "/tmp/preview.mp4",
      }).success,
    ).toBe(false);
  });

  it("accepts only an opaque, bounded project-media import and never returns a source path", async () => {
    const handlers = createRecordingToolHandlers(service);
    const result = await handlers.importRecordingProjectMedia({
      projectId: "project-1",
      revision: 0,
      fileName: "still.png",
    });

    expect(result).toMatchObject({
      structuredContent: {
        ok: true,
        operation: "import_recording_project_media",
        media: { mediaId: "media_0123456789abcdef0123456789abcdef", extension: "png" },
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("/");
    for (const fileName of [
      "/tmp/still.png",
      "../still.png",
      "folder/still.png",
      "still.png/next",
    ]) {
      expect(
        importRecordingProjectMediaInputSchema.safeParse({
          projectId: "project-1",
          revision: 0,
          fileName,
        }).success,
      ).toBe(false);
    }
    expect(
      importRecordingProjectMediaInputSchema.safeParse({
        projectId: "project-1",
        revision: 0,
        fileName: "still.png",
        authorizedRoot: "/tmp/unsafe",
      }).success,
    ).toBe(false);
  });

  it("keeps the stable import handler path-free and reports an unavailable configured service", async () => {
    const { importProjectMedia: _importProjectMedia, ...serviceWithoutImport } = service;
    const handlers = createRecordingToolHandlers(serviceWithoutImport);

    const result = await handlers.importRecordingProjectMedia({
      projectId: "project-1",
      revision: 0,
      fileName: "tone.wav",
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        operation: "import_recording_project_media",
        error: { code: "service_unavailable" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("/");
  });

  it("revises a loaded project over MCP without creating or recapturing another source", async () => {
    const revisedProject = validateRecordingProject({
      ...project,
      revision: 1,
      presentation: {
        ...project.presentation,
        cursor: { ...project.presentation.cursor, preset: "large" },
      },
      preview: { status: "not-requested" },
    });
    const revisedView = {
      project: revisedProject,
      projectSha256: "f".repeat(64),
    } satisfies RecordingProjectView;
    let createCalls = 0;
    let reviseCalls = 0;
    const projectService: RecordingMcpService = {
      ...service,
      createProject: async () => {
        createCalls += 1;
        return view;
      },
      reviseProject: async () => {
        reviseCalls += 1;
        return revisedView;
      },
      inspectProject: async () => revisedView,
    };
    const server = createRecordingMcpServer(projectService);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "recordly-project-flow-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "create_recording_project",
          "inspect_recording_project",
          "revise_recording_project",
          "render_recording_project_preview",
          "render_recording_project_final",
          "judge_recording_project_preview",
          "import_recording_project_media",
        ]),
      );
      await client.callTool({
        name: "create_recording_project",
        arguments: { sessionId: "session-1" },
      });
      const revision = await client.callTool({
        name: "revise_recording_project",
        arguments: { project: revisedProject, mode: "manual" },
      });
      expect(revision.structuredContent).toMatchObject({
        ok: true,
        project: { project: { revision: 1, captureSources: project.captureSources } },
      });
      expect(createCalls).toBe(1);
      expect(reviseCalls).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("exposes a strict path-free preview judgment result", async () => {
    const handlers = createRecordingToolHandlers(service);
    const result = await handlers.judgeRecordingProjectPreview({
      projectId: "project-1",
      revision: 0,
      projectSha256: "d".repeat(64),
      previewArtifactSha256: "e".repeat(64),
      verdict: "accept",
      issues: [],
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      operation: "judge_recording_project_preview",
      judgment: { status: "current", verdict: "accept", remainingAutomatedRevisionBudget: 4 },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("/");
  });

  it("returns bounded preview evidence as an actual MCP image block, never structured base64", async () => {
    const handlers = createRecordingToolHandlers({
      ...service,
      inspectPreview: async () => previewInspection,
    });
    const result = await handlers.inspectRecordingProjectPreview({
      projectId: "project-1",
      revision: 0,
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      operation: "inspect_recording_project_preview",
      inspection: { projectSha256: "d".repeat(64), previewArtifactSha256: "e".repeat(64) },
    });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("cG5n");
    expect(JSON.stringify(result.structuredContent)).not.toContain("/");
  });

  it("surfaces the preview contact sheet as an image through the raw MCP SDK client", async () => {
    const server = createRecordingMcpServer({
      ...service,
      inspectPreview: async () => previewInspection,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "recordly-preview-image-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "inspect_recording_project_preview",
        arguments: { projectId: "project-1", revision: 0 },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([{ type: "image", data: "cG5n", mimeType: "image/png" }]),
      );
      expect(result.structuredContent).toMatchObject({
        operation: "inspect_recording_project_preview",
        inspection: { previewArtifactSha256: "e".repeat(64) },
      });
    } finally {
      await client.close();
    }
  });

  it("reserves bounded, path-free proposal operations for an editorial-capable service", async () => {
    expect(
      proposeRecordingProjectEditorialInputSchema.safeParse({
        projectId: "project-1",
        projectRevision: 0,
        sourcePath: "/tmp/capture-events.jsonl",
      }).success,
    ).toBe(false);
    expect(
      applyAcceptedEditorialProposalInputSchema.safeParse({
        projectId: "project-1",
        projectRevision: 0,
        proposalSha256: "a".repeat(64),
        acceptedZoomProposalIds: Array.from({ length: 33 }, (_, index) => `zoom-${index}`),
      }).success,
    ).toBe(false);
  });

  it("lists exactly the two editorial tools only when the service can recompute and apply proposals", async () => {
    const editorialProject = migrateV1RecordingProject(project);
    const proposal = buildEditorialProposal({
      schemaVersion: 1,
      project: editorialProject,
      observedEvents: [
        {
          id: "event-1",
          source: "observed",
          sourceId: "capture-1",
          tUs: 500_000,
          kind: "click",
          x: 160,
          y: 90,
        },
      ],
      deadTimeBySource: [
        {
          sourceId: "capture-1",
          analysis: analyzeDeadTime({
            schemaVersion: 1,
            captureDurationUs: 1_000_000,
            frameSamples: [
              { tUs: 0, sha256: "a".repeat(64) },
              { tUs: 999_999, sha256: "a".repeat(64) },
            ],
            actionSamples: [{ tUs: 500_000, kind: "click" }],
          }),
        },
      ],
    });
    const firstZoom = proposal.zoomProposals[0];
    if (firstZoom === undefined) throw new Error("proposal fixture has no zoom");
    const editorialService: RecordingMcpService = {
      ...service,
      proposeEditorial: async () => proposal,
      applyAcceptedEditorialProposal: async ({ acceptedZoomProposalIds }) => ({
        project: applyAcceptedEditorialProposal(
          editorialProject,
          proposal,
          acceptedZoomProposalIds,
        ),
        projectSha256: "f".repeat(64),
      }),
    };
    const handlers = createRecordingToolHandlers(editorialService);
    const proposed = await handlers.proposeRecordingProjectEditorial({
      projectId: "project-1",
      projectRevision: 0,
    });
    const applied = await handlers.applyAcceptedRecordingProjectEditorial({
      projectId: "project-1",
      projectRevision: 0,
      proposalSha256: proposal.proposalSha256,
      acceptedZoomProposalIds: [firstZoom.id],
    });
    expect(proposed.structuredContent).toMatchObject({
      ok: true,
      operation: "propose_recording_project_editorial",
      proposal: { proposalSha256: proposal.proposalSha256 },
    });
    expect(JSON.stringify(proposed.structuredContent)).not.toContain("/");
    expect(applied.structuredContent).toMatchObject({
      ok: true,
      operation: "apply_accepted_recording_project_editorial",
      project: { project: { revision: 1, revisionPolicy: { automatedRevisionCount: 1 } } },
    });
    const server = createRecordingMcpServer(editorialService);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "recordly-editorial-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "propose_recording_project_editorial",
          "apply_accepted_recording_project_editorial",
        ]),
      );
    } finally {
      await client.close();
    }
  });
});
