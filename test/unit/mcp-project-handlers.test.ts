import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createRecordingToolHandlers } from "../../mcp/handlers.js";
import { createRecordingProjectInputSchema } from "../../mcp/schemas.js";
import { createRecordingMcpServer } from "../../mcp/server-factory.js";
import type { RecordingMcpService, RecordingProjectView } from "../../mcp/types.js";
import { validateRecordingProject } from "../../src/project/index.js";

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
} satisfies RecordingMcpService;

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
});
