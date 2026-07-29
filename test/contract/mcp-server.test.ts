import { execFile, spawn } from "node:child_process";
import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createRecordingToolHandlers } from "../../mcp/handlers.js";
import {
  type CreateRecordingSessionInput,
  createRecordingSessionInputSchema,
  type RecordBrowserEventInput,
  recordBrowserEventInputSchema,
  toolOutputSchema,
} from "../../mcp/schemas.js";
import { createRecordingMcpServer } from "../../mcp/server-factory.js";
import { createSessionStoreService } from "../../mcp/session-store-service.js";
import type { RecordingSessionService, RecordingSessionView } from "../../mcp/types.js";

const execFileAsync = promisify(execFile);
const browserHelperRoot = "/tmp/recordly-codex/browser-helpers";

async function rawJsonRpcOutput(): Promise<{ lines: string[]; stderr: string }> {
  const child = spawn(process.execPath, ["./dist/mcp/server.js"], { cwd: process.cwd() });
  const lines: string[] = [];
  let stdoutBuffer = "";
  let stderr = "";
  const listed = new Promise<void>((resolveListed, rejectListed) => {
    const timeout = setTimeout(
      () => rejectListed(new Error("timed out waiting for tools/list")),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectListed(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const complete = stdoutBuffer.split("\n");
      stdoutBuffer = complete.pop() ?? "";
      for (const line of complete) {
        if (line.length === 0) continue;
        lines.push(line);
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === 2) {
            clearTimeout(timeout);
            resolveListed();
          }
        } catch {
          // The assertion below reports non-JSON stdout with the complete output.
        }
      }
    });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.write(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw-json-rpc-contract-test", version: "0.1.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join(""),
  );
  try {
    await listed;
    return { lines, stderr };
  } finally {
    child.kill("SIGTERM");
  }
}

const createInput = {
  url: "https://demo.example/products",
  objective: "Show the product search flow.",
} satisfies CreateRecordingSessionInput;

const pointerEvent = {
  type: "pointer" as const,
  data: { x: 640, y: 480, buttons: 0, source: "planned" as const },
} satisfies RecordBrowserEventInput["event"];

const session: RecordingSessionView = {
  sessionId: "session-001",
  requestId: "request-001",
  status: "open",
  eventCount: 0,
  artifactRoot: "/tmp/recordly-codex/session-001",
  browserHelperRoot,
  browserStartHelperPath: `${browserHelperRoot}/session-001/browser-start.mjs`,
  browserStopHelperPath: `${browserHelperRoot}/session-001/browser-stop.mjs`,
  captureConfigPath: "/tmp/recordly-codex/session-001/capture-config.json",
  artifactPaths: ["/tmp/recordly-codex/session-001/request.sanitized.json", "/private/secret.json"],
};

const schemaSession = {
  sessionId: "session-001",
  requestId: "request-001",
  status: "open",
  eventCount: 0,
  artifactRoot: "/tmp/recordly-codex/session-001",
  browserStartHelperPath: `${browserHelperRoot}/session-001/browser-start.mjs`,
  browserStopHelperPath: `${browserHelperRoot}/session-001/browser-stop.mjs`,
  captureConfigPath: "/tmp/recordly-codex/session-001/capture-config.json",
  artifactPaths: ["/tmp/recordly-codex/session-001/request.sanitized.json"],
};
const schemaProject = { project: { projectId: "project-001" }, projectSha256: "a".repeat(64) };
const schemaRender = {
  revision: 0,
  format: "mp4" as const,
  artifact: "projects/project-001/preview.mp4",
  sha256: "b".repeat(64),
};
const schemaJudgment = {
  status: "current" as const,
  verdict: "accept" as const,
  revision: 0,
  issues: [],
  remainingAutomatedRevisionBudget: 4,
};
const schemaProfile = {
  source: "builtin" as const,
  profileId: "landscape-1080p",
  profileRevision: 1,
  snapshot: {},
  snapshotSha256: "c".repeat(64),
};
const schemaProfileSummary = {
  source: schemaProfile.source,
  profileId: schemaProfile.profileId,
  profileRevision: schemaProfile.profileRevision,
  snapshotSha256: schemaProfile.snapshotSha256,
};

describe("MCP tool output contract", () => {
  it("accepts each declared successful operation shape", () => {
    const validSuccesses = [
      ...[
        "create_recording_session",
        "record_browser_event",
        "inspect_recording_session",
        "seal_recording_capture",
        "discard_recording_session",
      ].map((operation) => ({ ok: true, operation, session: schemaSession })),
      ...[
        "create_recording_project",
        "inspect_recording_project",
        "revise_recording_project",
        "apply_recording_profile",
        "apply_accepted_recording_project_editorial",
      ].map((operation) => ({ ok: true, operation, project: schemaProject })),
      {
        ok: true,
        operation: "render_recording_project_preview",
        project: schemaProject,
        render: { ...schemaRender, kind: "preview" as const },
      },
      {
        ok: true,
        operation: "render_recording_project_final",
        project: schemaProject,
        render: { ...schemaRender, kind: "final" as const },
      },
      {
        ok: true,
        operation: "judge_recording_project_preview",
        project: schemaProject,
        judgment: schemaJudgment,
      },
      {
        ok: true,
        operation: "import_recording_project_media",
        media: {
          mediaId: "media_0123456789abcdef0123456789abcdef",
          sha256: "d".repeat(64),
          kind: "image",
          extension: "png",
          durationUs: 1,
        },
      },
      { ok: true, operation: "list_recording_profiles", profiles: [schemaProfileSummary] },
      ...["get_recording_profile", "create_recording_profile", "update_recording_profile"].map(
        (operation) => ({ ok: true, operation, profile: schemaProfile }),
      ),
    ];

    for (const output of validSuccesses) {
      expect(toolOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(true);
    }
  });

  it("rejects successful payloads that do not belong to their declared operation", () => {
    const malformedSuccesses = [
      {
        ok: true,
        operation: "judge_recording_project_preview",
      },
      {
        ok: true,
        operation: "render_recording_project_preview",
        project: schemaProject,
      },
      {
        ok: true,
        operation: "render_recording_project_final",
        project: schemaProject,
      },
      {
        ok: true,
        operation: "render_recording_project_preview",
        project: schemaProject,
        render: { ...schemaRender, kind: "final" as const },
      },
      {
        ok: true,
        operation: "judge_recording_project_preview",
        project: schemaProject,
        judgment: schemaJudgment,
        render: { ...schemaRender, kind: "preview" as const },
      },
      {
        ok: true,
        operation: "inspect_recording_session",
        session: schemaSession,
        project: schemaProject,
      },
      {
        ok: true,
        operation: "list_recording_profiles",
        profiles: [schemaProfileSummary],
        project: schemaProject,
      },
      {
        ok: true,
        operation: "get_recording_profile",
        profile: schemaProfile,
        render: { ...schemaRender, kind: "preview" as const },
      },
      {
        ok: true,
        operation: "create_recording_profile",
        profile: schemaProfile,
        media: {
          mediaId: "media_0123456789abcdef0123456789abcdef",
          sha256: "d".repeat(64),
          kind: "image",
          extension: "png",
          durationUs: 1,
        },
      },
      {
        ok: true,
        operation: "update_recording_profile",
        profile: schemaProfile,
        session: schemaSession,
      },
    ];

    for (const output of malformedSuccesses) {
      expect(toolOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(false);
    }
  });
});

describe("recordly Codex MCP handlers", () => {
  it("accepts ergonomic intent, restricts events to semantic actions, and returns only owned paths", async () => {
    const calls: string[] = [];
    const service: RecordingSessionService = {
      create: async (input) => {
        calls.push(`create:${input.url}`);
        return session;
      },
      recordEvent: async (input) => {
        calls.push(`event:${input.event.type}`);
        return { ...session, eventCount: 1 };
      },
      inspect: async () => ({ ...session, eventCount: 1 }),
      seal: async () => ({ ...session, status: "sealed", eventCount: 1 }),
      discard: async () => ({ ...session, status: "discarded", eventCount: 1 }),
    };
    const handlers = createRecordingToolHandlers(service);

    const created = await handlers.createRecordingSession(createInput);
    const recorded = await handlers.recordBrowserEvent({
      sessionId: "session-001",
      event: pointerEvent,
    });
    const inspected = await handlers.inspectRecordingSession({ sessionId: "session-001" });
    const sealed = await handlers.sealRecordingCapture({ sessionId: "session-001" });
    const discarded = await handlers.discardRecordingSession({
      sessionId: "session-001",
      reason: "retry the approved workflow",
    });

    expect(calls).toEqual(["create:https://demo.example/products", "event:pointer"]);
    for (const result of [created, recorded, inspected, sealed, discarded]) {
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: JSON.stringify(result.structuredContent) }),
      ]);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        session: {
          sessionId: "session-001",
          requestId: "request-001",
          eventCount: expect.any(Number),
          artifactRoot: "/tmp/recordly-codex/session-001",
          artifactPaths: ["/tmp/recordly-codex/session-001/request.sanitized.json"],
        },
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("/private/secret.json");
    }
    expect(sealed.structuredContent).toMatchObject({ session: { status: "sealed" } });
    expect(discarded.structuredContent).toMatchObject({ session: { status: "discarded" } });
    expect(
      recordBrowserEventInputSchema.safeParse({
        sessionId: "session-001",
        event: { type: "frame", data: {} },
      }).success,
    ).toBe(false);
    expect(
      createRecordingSessionInputSchema.safeParse({ ...createInput, requestId: "model-supplied" })
        .success,
    ).toBe(false);
    expect(
      createRecordingSessionInputSchema.safeParse({
        ...createInput,
        allowedOrigins: ["https://demo.example", "https://other.example"],
      }).success,
    ).toBe(false);
  });

  it("never exposes unsafe primary artifact paths or service errors", async () => {
    const handlers = createRecordingToolHandlers({
      create: async () => ({ ...session, browserStartHelperPath: "/private/browser-start.mjs" }),
      recordEvent: async () => session,
      inspect: async () => session,
      seal: async () => session,
      discard: async () => session,
    });

    const result = await handlers.createRecordingSession(createInput);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        operation: "create_recording_session",
        error: { code: "operation_failed" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("returns only contained quality-approved delivery artifacts after sealing", async () => {
    const deliveryPaths = [
      "/tmp/recordly-codex/session-001/artifacts/recording.mp4",
      "/tmp/recordly-codex/session-001/artifacts/recording-manifest.json",
      "/tmp/recordly-codex/session-001/artifacts/quality-report.json",
    ] as const;
    const delivered = {
      ...session,
      status: "sealed" as const,
      artifactPaths: deliveryPaths,
      videoPath: deliveryPaths[0],
      manifestPath: deliveryPaths[1],
      qualityReportPath: deliveryPaths[2],
    };
    const handlers = createRecordingToolHandlers({
      create: async () => session,
      recordEvent: async () => session,
      inspect: async () => session,
      seal: async () => delivered,
      discard: async () => session,
    });

    const result = await handlers.sealRecordingCapture({ sessionId: "session-001" });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      session: {
        artifactPaths: deliveryPaths,
        videoPath: deliveryPaths[0],
        manifestPath: deliveryPaths[1],
        qualityReportPath: deliveryPaths[2],
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("frames/raw");
  });

  it("returns a redacted structured operation error through the MCP client transport", async () => {
    const server = createRecordingMcpServer({
      create: async () => {
        throw new Error("database failed at /private/recordly-codex/session.ts:17");
      },
      recordEvent: async () => session,
      inspect: async () => session,
      seal: async () => session,
      discard: async () => session,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "recordly-codex-error-contract-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.listTools();
      const result = await client.callTool({
        name: "create_recording_session",
        arguments: createInput,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        operation: "create_recording_session",
        error: { code: "operation_failed" },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify(result.structuredContent),
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("database failed");
    } finally {
      await client.close();
    }
  });

  it("persists one owner token and serializes resumed semantic events", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-codex-mcp-"));
    try {
      const first = createSessionStoreService({
        artifactRoot,
        idSource: () => "session-001",
        clockUs: () => 100,
      });
      const created = await first.create(createInput);
      const startHelper = await readFile(created.browserStartHelperPath, "utf8");
      const resumed = createSessionStoreService({ artifactRoot, clockUs: () => 100 });

      await Promise.all([
        first.recordEvent({ sessionId: created.sessionId, event: pointerEvent }),
        resumed.recordEvent({
          sessionId: created.sessionId,
          event: { type: "marker", data: { id: "search-opened" } },
        }),
      ]);
      const inspected = await resumed.inspect({ sessionId: created.sessionId });
      const telemetry = await readFile(join(created.artifactRoot, "telemetry.ndjson"), "utf8");
      const events = telemetry
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number; tUs: number; sessionId: string });

      expect(inspected.requestId).toBe(created.requestId);
      expect(startHelper).toContain('const recordingOrigin = "https://demo.example";');
      expect(startHelper).not.toContain("new URL");
      expect(inspected.eventCount).toBe(2);
      expect((await lstat(artifactRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(artifactRoot, ".recordly-codex-owner-token"))).mode & 0o777).toBe(
        0o600,
      );
      expect(events.map((event) => event.seq)).toEqual([0, 1]);
      expect(events.map((event) => event.tUs)).toEqual([100, 101]);
      expect(events.every((event) => event.sessionId === created.sessionId)).toBe(true);
      expect(inspected.artifactRoot).toBe(created.artifactRoot);
      expect(inspected.browserStartHelperPath).toBe(
        `${artifactRoot}/browser-helpers/${created.sessionId}/browser-start.mjs`,
      );
      expect(inspected.browserStopHelperPath).toBe(
        `${artifactRoot}/browser-helpers/${created.sessionId}/browser-stop.mjs`,
      );
      expect(inspected.captureConfigPath.startsWith(`${created.artifactRoot}/`)).toBe(true);
      expect(
        inspected.artifactPaths.every((path) => path.startsWith(`${created.artifactRoot}/`)),
      ).toBe(true);
      await resumed.discard({ sessionId: created.sessionId });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects a filesystem-root artifact directory", () => {
    expect(() => createSessionStoreService({ artifactRoot: "/" })).toThrow(
      "recording session service is unavailable",
    );
  });

  it("creates one canonical approved origin with broker-owned capture limits below the renderer cap", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-codex-origin-"));
    try {
      const service = createSessionStoreService({ artifactRoot, idSource: () => "session-origin" });
      const created = await service.create({
        url: "https://DEMO.example:443/products",
        objective: "Show the approved opening state.",
        maxCaptureSeconds: 60,
        maxAcceptedFrames: 900,
        maxAcceptedBytes: 4 * 1024 * 1024,
      });

      expect(created.capture).toEqual({
        phase: "ready",
        maxCaptureSeconds: 60,
        maxAcceptedFrames: 900,
        maxAcceptedBytes: 4 * 1024 * 1024,
        acceptedFrames: 0,
        acceptedBytes: 0,
      });
      expect(await readFile(created.browserStartHelperPath, "utf8")).toContain(
        'const recordingOrigin = "https://demo.example";',
      );
      expect(created.browserStartHelperPath).toBe(
        `${artifactRoot}/browser-helpers/session-origin/browser-start.mjs`,
      );
      await service.discard({ sessionId: created.sessionId });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps a budget-terminal capture inspectable with its safe counters", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-codex-budget-terminal-"));
    try {
      const service = createSessionStoreService({ artifactRoot, idSource: () => "session-budget" });
      const created = await service.create({
        url: "https://demo.example/products",
        objective: "Show the approved opening state.",
        maxAcceptedFrames: 1,
      });
      const startHelper = await readFile(created.browserStartHelperPath, "utf8");
      const endpoint = JSON.parse(
        startHelper.match(/^const endpoint = (.+);$/mu)?.[1] ?? "null",
      ) as string;
      const claim = await fetch(`${endpoint}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: created.sessionId,
          url: "https://demo.example/products",
        }),
      });
      const token = ((await claim.json()) as { token: string }).token;
      const frame = (sequence: number) => ({
        sessionId: created.sessionId,
        url: "https://demo.example/products",
        frame: {
          sessionId: sequence,
          data: Buffer.from(`frame-${sequence}`).toString("base64"),
          metadata: { deviceWidth: 1440, deviceHeight: 900 },
        },
      });
      for (const [sequence, expectedStatus] of [
        [1, 200],
        [2, 429],
      ] as const) {
        const response = await fetch(`${endpoint}/frame`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-recordly-capability": token },
          body: JSON.stringify(frame(sequence)),
        });
        expect(response.status).toBe(expectedStatus);
      }

      await expect(service.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        capture: { phase: "failed", reason: "budget_exceeded", acceptedFrames: 1 },
      });
      await expect(service.seal({ sessionId: created.sessionId })).rejects.toThrow(
        "recording session service is unavailable",
      );
      await service.discard({ sessionId: created.sessionId });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("builds the stdio server, exposes the compatible session tools and editable project tools, and creates a recording through an SDK client", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-codex-stdio-"));
    await execFileAsync("npm", ["run", "build"]);
    await access("dist/mcp/server.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/mcp/server.js"],
      cwd: process.cwd(),
      env: { RECORDLY_CODEX_ARTIFACT_ROOT: artifactRoot },
      stderr: "pipe",
    });
    const client = new Client({ name: "recordly-codex-contract-test", version: "0.1.0" });
    let closed = false;
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "apply_accepted_recording_project_editorial",
        "apply_recording_profile",
        "create_recording_profile",
        "create_recording_project",
        "create_recording_session",
        "discard_recording_session",
        "get_recording_profile",
        "import_recording_project_media",
        "inspect_recording_project",
        "inspect_recording_project_preview",
        "inspect_recording_session",
        "judge_recording_project_preview",
        "list_recording_profiles",
        "propose_recording_project_editorial",
        "record_browser_event",
        "render_recording_project_final",
        "render_recording_project_preview",
        "revise_recording_project",
        "seal_recording_capture",
        "update_recording_profile",
      ]);
      const importTool = listed.tools.find(
        (tool) => tool.name === "import_recording_project_media",
      );
      expect(importTool?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["projectId", "revision", "fileName"],
        properties: {
          projectId: expect.any(Object),
          revision: expect.any(Object),
          fileName: expect.any(Object),
        },
      });
      expect(JSON.stringify(importTool?.inputSchema)).not.toContain("authorizedRoot");
      const proposalTool = listed.tools.find(
        (tool) => tool.name === "propose_recording_project_editorial",
      );
      const applyProposalTool = listed.tools.find(
        (tool) => tool.name === "apply_accepted_recording_project_editorial",
      );
      expect(proposalTool?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["projectId", "projectRevision"],
      });
      expect(applyProposalTool?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["projectId", "projectRevision", "proposalSha256", "acceptedZoomProposalIds"],
      });
      expect(JSON.stringify(proposalTool?.inputSchema)).not.toMatch(/path|frame|evidence/i);
      expect(JSON.stringify(applyProposalTool?.inputSchema)).not.toMatch(/path|frame|evidence/i);
      const created = toolOutputSchema.parse(
        await client
          .callTool({ name: "create_recording_session", arguments: createInput })
          .then((result) => result.structuredContent),
      );
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok || created.session === undefined) {
        throw new Error("expected a successful recording-session result");
      }
      const unavailableImport = await client.callTool({
        name: "import_recording_project_media",
        arguments: { projectId: "unavailable-project", revision: 0, fileName: "tone.wav" },
      });
      expect(unavailableImport).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          operation: "import_recording_project_media",
          error: { code: "service_unavailable" },
        },
      });
      expect(created.session.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
      const startHelper = await readFile(created.session.browserStartHelperPath, "utf8");
      expect(startHelper).toMatch(/^async \(page\) =>/u);
      expect(startHelper).toContain("page.request.post");
      expect(startHelper).not.toContain("import ");
      expect(startHelper).not.toMatch(/[0-9a-f]{64}/u);
      expect(startHelper).not.toContain("receiptOffsetUs");
      expect(JSON.stringify(created.session)).not.toContain("capability");
      const brokerState = await readFile(
        join(created.session.artifactRoot, "broker-state.json"),
        "utf8",
      );
      const captureConfig = await readFile(created.session.captureConfigPath, "utf8");
      expect(brokerState).not.toContain("capability");
      expect(brokerState).not.toContain("token");
      expect(captureConfig).not.toContain("capability");
      expect(captureConfig).not.toContain("token");
      const endpoint = JSON.parse(
        startHelper.match(/^const endpoint = (.+);$/mu)?.[1] ?? "null",
      ) as string;
      const claim = await fetch(`${endpoint}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: created.session.sessionId,
          url: createInput.url,
        }),
      });
      expect(claim.status).toBe(200);
      await client.close();
      closed = true;

      const resumed = createSessionStoreService({ artifactRoot });
      await expect(resumed.inspect({ sessionId: created.session.sessionId })).rejects.toThrow(
        "recording session service is unavailable",
      );
      expect(
        JSON.parse(await readFile(join(created.session.artifactRoot, "broker-state.json"), "utf8")),
      ).toMatchObject({ phase: "failed" });
      expect(
        JSON.parse(
          await readFile(join(created.session.artifactRoot, "capture-summary.json"), "utf8"),
        ),
      ).toMatchObject({ status: "failed", reason: "broker_interrupted" });
      await resumed.discard({ sessionId: created.session.sessionId });
    } finally {
      if (!closed) await client.close();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns a redacted operation error through the built stdio MCP transport", async () => {
    await execFileAsync("npm", ["run", "build"]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./test/support/failing-mcp-server.mjs"],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "recordly-codex-stdio-error-contract-test",
      version: "0.1.0",
    });
    try {
      await client.connect(transport);
      await client.listTools();
      const result = await client.callTool({
        name: "create_recording_session",
        arguments: createInput,
      });

      expect(result.isError).toBe(true);
      expect(toolOutputSchema.parse(result.structuredContent)).toEqual({
        ok: false,
        operation: "create_recording_session",
        error: { code: "operation_failed" },
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("database failed");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("writes JSON-RPC messages only to stdout", async () => {
    const output = await rawJsonRpcOutput();
    const messages = output.lines.map((line) => JSON.parse(line));

    expect(output.stderr).toBe("");
    expect(output.lines).not.toHaveLength(0);
    expect(messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, jsonrpc: "2.0" })]),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          result: expect.objectContaining({
            serverInfo: { name: "recordly-codex-mcp-server", version: "0.5.0" },
          }),
        }),
      ]),
    );
    const listed = messages.find((message) => message.id === 2)?.result?.tools;
    expect(listed.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "apply_accepted_recording_project_editorial",
      "apply_recording_profile",
      "create_recording_profile",
      "create_recording_project",
      "create_recording_session",
      "discard_recording_session",
      "get_recording_profile",
      "import_recording_project_media",
      "inspect_recording_project",
      "inspect_recording_project_preview",
      "inspect_recording_session",
      "judge_recording_project_preview",
      "list_recording_profiles",
      "propose_recording_project_editorial",
      "record_browser_event",
      "render_recording_project_final",
      "render_recording_project_preview",
      "revise_recording_project",
      "seal_recording_capture",
      "update_recording_profile",
    ]);
    for (const line of output.lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }, 30_000);
});
