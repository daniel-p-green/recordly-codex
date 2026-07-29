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
const browserHelperRoot = join(process.cwd(), ".playwright-mcp", "recordly-codex");

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
  browserStartHelperPath: `${browserHelperRoot}/session-001/browser-start.mjs`,
  browserStopHelperPath: `${browserHelperRoot}/session-001/browser-stop.mjs`,
  captureConfigPath: "/tmp/recordly-codex/session-001/capture-config.json",
  artifactPaths: ["/tmp/recordly-codex/session-001/request.sanitized.json", "/private/secret.json"],
};

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
        `${browserHelperRoot}/${created.sessionId}/browser-start.mjs`,
      );
      expect(inspected.browserStopHelperPath).toBe(
        `${browserHelperRoot}/${created.sessionId}/browser-stop.mjs`,
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

  it("builds the stdio server, exposes five tools, and creates a recording through an SDK client", async () => {
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
        "create_recording_session",
        "discard_recording_session",
        "inspect_recording_session",
        "record_browser_event",
        "seal_recording_capture",
      ]);
      const created = toolOutputSchema.parse(
        await client
          .callTool({ name: "create_recording_session", arguments: createInput })
          .then((result) => result.structuredContent),
      );
      expect(created.ok).toBe(true);
      if (!created.ok || created.session === undefined) {
        throw new Error("expected a successful recording-session result");
      }
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

    expect(output.stderr).toBe("");
    expect(output.lines).not.toHaveLength(0);
    expect(output.lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, jsonrpc: "2.0" })]),
    );
    for (const line of output.lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }, 30_000);
});
