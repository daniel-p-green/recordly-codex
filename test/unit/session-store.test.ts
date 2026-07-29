import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  isBrokerCaptureFrameEvent,
  type SessionFileSystem,
  SessionStore,
} from "../../src/session/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const request = (requestId = "request-001") => ({
  schemaVersion: 1,
  requestId,
  url: "https://demo.example/products",
  objective: "Show the product search flow.",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
  policy: {
    allowPrivateOrigin: false,
    allowedOrigins: ["https://demo.example"],
    maxAttempts: 2,
  },
});

const frameEvent = (sessionId: string, seq = 1, tUs = 0) => ({
  schemaVersion: 1,
  sessionId,
  seq,
  tUs,
  type: "frame" as const,
  data: {
    cdpSessionId: 1,
    frameId: seq,
    receivedAtUs: tUs,
    imagePath: `frames/raw/${String(seq).padStart(6, "0")}.webp`,
    sha256: "a".repeat(64),
    width: 1440,
    height: 900,
  },
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recordly-codex-session-store-"));
  temporaryRoots.push(root);
  return root;
}

function nodeFileSystem(): SessionFileSystem {
  return {
    mkdir: async (path, options) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path, options);
    },
    chmod: async (path, mode) => {
      const { chmod } = await import("node:fs/promises");
      await chmod(path, mode);
    },
    readFile: async (path) => readFile(path, "utf8"),
    writeFile: async (path, content, options) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, content, options);
    },
    rename: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
    lstat: async (path) => {
      const { lstat } = await import("node:fs/promises");
      const stat = await lstat(path);
      return {
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
        isSymbolicLink: () => stat.isSymbolicLink(),
      };
    },
    rm: async (path, options) => {
      await rm(path, options);
    },
  };
}

function store(
  root: string,
  ids: readonly string[],
  ownerToken = "test-process-owner",
): SessionStore {
  let index = 0;
  return new SessionStore({
    root,
    browserHelperRoot: join(root, "browser-helpers"),
    ownerToken,
    runtimeModulePath: pathToFileURL(join(root, "runtime-fixture.mjs")).href,
    clockUs: () => 123_456,
    idSource: () => ids[index++] ?? "unexpected-id",
    fileSystem: nodeFileSystem(),
  });
}

describe("SessionStore", () => {
  it("labels broker receipt timing while preserving legacy raw evidence for inspection and sealing", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-001"]);
    const created = await sessions.createSession(request());
    await sessions.appendEvent("session-001", frameEvent("session-001"));
    const brokerFrame = {
      sessionId: "session-001",
      type: "frame" as const,
      frameId: 1,
      receiptOffsetUs: 0,
      imagePath: "frames/raw/frame-000001.jpg",
      sha256: "a".repeat(64),
      width: 1440,
      height: 900,
    };
    expect(isBrokerCaptureFrameEvent(brokerFrame)).toBe(true);
    await writeFile(created.paths.rawCaptureEvents, `${JSON.stringify(brokerFrame)}\n`, {
      mode: 0o600,
    });
    await expect(sessions.inspect("session-001")).resolves.toMatchObject({
      rawCaptureTiming: "broker-receipt-offsets",
    });
    const { receiptOffsetUs: _legacyOffset, ...legacyFrame } = brokerFrame;
    await writeFile(created.paths.rawCaptureEvents, `${JSON.stringify(legacyFrame)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      created.paths.captureSummary,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-001",
        origin: "https://demo.example",
        status: "stopped",
        receivedFrames: 1,
        acceptedFrames: 1,
        ackedFrames: 1,
        rejectedFrames: 0,
        degradationRequested: false,
      }),
      { mode: 0o600 },
    );
    await expect(sessions.inspect("session-001")).resolves.toMatchObject({
      rawCaptureTiming: "legacy",
    });
    await expect(sessions.seal("session-001")).resolves.toMatchObject({
      state: "sealed",
      rawCaptureTiming: "legacy",
    });
  });

  it("creates contained private artifacts and browser-runtime config with importable wrappers", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-001"]);

    const created = await sessions.createSession(request());

    expect(created).toMatchObject({ sessionId: "session-001", state: "active" });
    expect(created.paths.root).toBe(join(root, "session-001"));
    expect(JSON.parse(await readFile(created.paths.request, "utf8"))).toEqual(request());
    expect((await stat(created.paths.root)).mode & 0o077).toBe(0);
    expect((await stat(created.paths.request)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(created.paths.captureConfig, "utf8"))).toEqual({
      schemaVersion: 1,
      sessionId: "session-001",
      rootPrefix: root,
      rootPath: created.paths.root,
      allowedOrigins: ["https://demo.example"],
      format: "jpeg",
      quality: 90,
    });
    expect(created.paths.captureConfig).toBe(join(root, "session-001", "capture-config.json"));
    expect(created.paths.startWrapper).toBe(
      join(root, "browser-helpers", "session-001", "browser-start.mjs"),
    );
    expect(created.paths.stopWrapper).toBe(
      join(root, "browser-helpers", "session-001", "browser-stop.mjs"),
    );
    expect((await stat(join(root, "browser-helpers"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "browser-helpers", "session-001"))).mode & 0o777).toBe(0o700);
    expect((await stat(created.paths.startWrapper)).mode & 0o777).toBe(0o600);
    expect(created.paths.rawCaptureEvents).toBe(join(root, "session-001", "capture-events.jsonl"));
    await writeFile(
      join(root, "runtime-fixture.mjs"),
      [
        "export async function startBrowserCapture(page, configPath) {",
        "  globalThis.__recordlyWrapperCalls.push({ operation: 'start', page, configPath });",
        "}",
        "export async function stopBrowserCapture(page, configPath) {",
        "  globalThis.__recordlyWrapperCalls.push({ operation: 'stop', page, configPath });",
        "}",
      ].join("\n"),
      { mode: 0o600 },
    );
    const fakePage = { label: "browser-page" };
    const runtimeCalls: unknown[] = [];
    (
      globalThis as typeof globalThis & { __recordlyWrapperCalls: unknown[] }
    ).__recordlyWrapperCalls = runtimeCalls;
    const startSource = await readFile(created.paths.startWrapper, "utf8");
    const stopSource = await readFile(created.paths.stopWrapper, "utf8");
    const start = await import(
      `data:text/javascript,export default (${encodeURIComponent(startSource)})`
    );
    const stop = await import(
      `data:text/javascript,export default (${encodeURIComponent(stopSource)})`
    );
    expect(runtimeCalls).toEqual([]);
    await start.default(fakePage);
    await stop.default(fakePage);
    expect(runtimeCalls).toEqual([
      { operation: "start", page: fakePage, configPath: created.paths.captureConfig },
      { operation: "stop", page: fakePage, configPath: created.paths.captureConfig },
    ]);
    delete (globalThis as typeof globalThis & { __recordlyWrapperCalls?: unknown })
      .__recordlyWrapperCalls;
    await expect(sessions.createSession({ ...request(), url: "file:///private" })).rejects.toThrow(
      /HTTP\(S\)/i,
    );
    await expect(
      store(root, ["../escape"]).createSession(request("request-escape")),
    ).rejects.toThrow(/safe/i);
  });

  it("resumes canonical event evidence after a store restart and rejects cross-session or non-monotonic appends", async () => {
    const root = await createRoot();
    const first = store(root, ["session-001"]);
    await first.createSession(request());
    await first.appendEvent("session-001", frameEvent("session-001"));

    const resumed = store(root, []);
    expect(await resumed.inspect("session-001")).toMatchObject({
      sessionId: "session-001",
      state: "active",
      eventCount: 1,
      frameCount: 1,
    });
    await resumed.appendEvent("session-001", {
      schemaVersion: 1,
      sessionId: "session-001",
      seq: 2,
      tUs: 10,
      type: "marker",
      data: { id: "after-restart" },
    });
    await expect(
      resumed.appendEvent("session-001", frameEvent("other-session", 3, 20)),
    ).rejects.toThrow(/session/i);
    await expect(
      resumed.appendEvent("session-001", frameEvent("session-001", 2, 20)),
    ).rejects.toThrow(/sequence/i);
    await expect(
      resumed.appendEvent("session-001", {
        schemaVersion: 1,
        sessionId: "session-001",
        seq: 3,
        tUs: 20,
        type: "marker",
        data: { id: "unknown-field", rawDom: "must not persist" },
      }),
    ).rejects.toThrow(/unknown field/i);
    expect(await resumed.inspect("session-001")).toMatchObject({ eventCount: 2, frameCount: 1 });
  });

  it("seals only after a matching successful browser summary and never overwrites it", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-001", "session-002"]);
    const created = await sessions.createSession(request());
    await sessions.appendEvent("session-001", frameEvent("session-001"));
    await expect(sessions.seal("session-001")).rejects.toThrow(/capture summary/i);
    await writeFile(
      created.paths.captureSummary,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "wrong-session",
        origin: "https://demo.example",
        status: "stopped",
        receivedFrames: 3,
        acceptedFrames: 3,
        ackedFrames: 3,
        rejectedFrames: 0,
        degradationRequested: false,
      }),
      { mode: 0o600 },
    );
    await expect(sessions.seal("session-001")).rejects.toThrow(/summary session/i);
    await writeFile(
      created.paths.captureSummary,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-001",
        origin: "https://demo.example",
        status: "failed",
        receivedFrames: 3,
        acceptedFrames: 3,
        ackedFrames: 3,
        rejectedFrames: 0,
        degradationRequested: true,
        reason: "capture_backpressure",
      }),
      { mode: 0o600 },
    );
    await expect(sessions.seal("session-001")).rejects.toThrow(/successful stopped/i);
    for (const counts of [
      { acceptedFrames: 0, ackedFrames: 0, rejectedFrames: 0 },
      { acceptedFrames: 3, ackedFrames: 2, rejectedFrames: 0 },
      { acceptedFrames: 3, ackedFrames: 3, rejectedFrames: 1 },
    ]) {
      await writeFile(
        created.paths.captureSummary,
        JSON.stringify({
          schemaVersion: 1,
          sessionId: "session-001",
          origin: "https://demo.example",
          status: "stopped",
          receivedFrames: 3,
          ...counts,
          degradationRequested: false,
        }),
        { mode: 0o600 },
      );
      await expect(sessions.seal("session-001")).rejects.toThrow(/complete frame evidence/i);
      await expect(sessions.inspect("session-001")).resolves.toMatchObject({ state: "active" });
    }
    const successfulSummary = JSON.stringify({
      schemaVersion: 1,
      sessionId: "session-001",
      origin: "https://demo.example",
      status: "stopped",
      receivedFrames: 3,
      acceptedFrames: 3,
      ackedFrames: 3,
      rejectedFrames: 0,
      degradationRequested: false,
    });
    await writeFile(created.paths.captureSummary, successfulSummary, { mode: 0o600 });

    expect(await sessions.seal("session-001")).toMatchObject({ state: "sealed", frameCount: 3 });
    expect(await readFile(created.paths.captureSummary, "utf8")).toBe(successfulSummary);
    await expect(sessions.seal("session-001")).rejects.toThrow(/active/i);
    await expect(
      sessions.appendEvent("session-001", frameEvent("session-001", 2, 10)),
    ).rejects.toThrow(/active/i);
  });

  it("keeps concurrent session state isolated", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-a", "session-b"]);
    const [left, right] = await Promise.all([
      sessions.createSession(request("request-a")),
      sessions.createSession(request("request-b")),
    ]);
    await Promise.all([
      sessions.appendEvent(left.sessionId, frameEvent(left.sessionId)),
      sessions.appendEvent(right.sessionId, frameEvent(right.sessionId)),
    ]);

    expect(await sessions.inspect(left.sessionId)).toMatchObject({ eventCount: 1, frameCount: 1 });
    expect(await sessions.inspect(right.sessionId)).toMatchObject({ eventCount: 1, frameCount: 1 });
    expect(left.paths.root).not.toBe(right.paths.root);
  });

  it("refuses traversal and symlink paths during discard", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-001"]);
    const created = await sessions.createSession(request());
    await expect(sessions.discard("../outside")).rejects.toThrow(/ID must be safe/i);

    const outside = await createRoot();
    await rm(created.paths.root, { recursive: true, force: true });
    await symlink(outside, created.paths.root);
    await expect(sessions.discard("session-001")).rejects.toThrow(/symbolic link/i);
  });

  it("keeps helper entrypoints out of private evidence and removes them with the session", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-001"]);
    const created = await sessions.createSession(request());

    await expect(access(join(created.paths.root, "browser-start.mjs"))).rejects.toThrow();
    await expect(access(created.paths.startWrapper)).resolves.toBeUndefined();
    await sessions.discard("session-001");

    await expect(access(created.paths.root)).rejects.toThrow();
    await expect(access(join(root, "browser-helpers", "session-001"))).rejects.toThrow();
  });

  it("rejects symlinked browser helper roots before creating private session evidence", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const helperRoot = join(root, "browser-helpers");
    await symlink(outside, helperRoot);
    const sessions = new SessionStore({
      root,
      browserHelperRoot: helperRoot,
      ownerToken: "test-process-owner",
      runtimeModulePath: pathToFileURL(join(root, "runtime-fixture.mjs")).href,
      clockUs: () => 123_456,
      idSource: () => "session-001",
      fileSystem: nodeFileSystem(),
    });

    await expect(sessions.createSession(request())).rejects.toThrow(/symbolic link/i);
    await expect(access(join(root, "session-001"))).rejects.toThrow();
  });

  it("does not discard a session created by another process owner", async () => {
    const root = await createRoot();
    await store(root, ["session-001"], "owner-a").createSession(request());

    await expect(store(root, [], "owner-b").discard("session-001")).rejects.toThrow(/not owned/i);
  });

  it("rejects symlink and non-regular evidence before inspection or discard", async () => {
    const evidence = [
      "metadata",
      "request",
      "telemetry",
      "captureConfig",
      "startWrapper",
      "stopWrapper",
    ] as const;
    for (const evidenceName of evidence) {
      const root = await createRoot();
      const sessions = store(root, ["session-001"]);
      const created = await sessions.createSession(request());
      const outside = join(await createRoot(), `${evidenceName}.json`);
      await writeFile(outside, "outside", { mode: 0o600 });
      await rm(created.paths[evidenceName], { force: true });
      await symlink(outside, created.paths[evidenceName]);

      await expect(sessions.inspect("session-001")).rejects.toThrow(/symbolic link/i);
      await expect(sessions.discard("session-001")).rejects.toThrow(/symbolic link/i);
    }

    for (const evidenceName of evidence) {
      const root = await createRoot();
      const sessions = store(root, ["session-001"]);
      const created = await sessions.createSession(request());
      await rm(created.paths[evidenceName], { force: true });
      await mkdir(created.paths[evidenceName], { mode: 0o700 });

      await expect(sessions.inspect("session-001")).rejects.toThrow(/regular file/i);
      await expect(sessions.discard("session-001")).rejects.toThrow(/regular file/i);
    }
  });

  it("rejects symlink or non-regular capture summaries before inspect or seal", async () => {
    const root = await createRoot();
    const sessions = store(root, ["session-001"]);
    const created = await sessions.createSession(request());
    const outside = join(await createRoot(), "capture-summary.json");
    await writeFile(outside, "outside", { mode: 0o600 });
    await symlink(outside, created.paths.captureSummary);

    await expect(sessions.inspect("session-001")).rejects.toThrow(/symbolic link/i);
    await expect(sessions.seal("session-001")).rejects.toThrow(/symbolic link/i);
    await rm(created.paths.captureSummary, { force: true });
    await mkdir(created.paths.captureSummary, { mode: 0o700 });

    await expect(sessions.inspect("session-001")).rejects.toThrow(/regular file/i);
    await expect(sessions.seal("session-001")).rejects.toThrow(/regular file/i);
  });
});
