import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const runtimeUrl = new URL("../../browser/capture-runtime.js", import.meta.url);

type Listener = (payload: unknown) => void;

class FakeSession {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> | undefined }> =
    [];
  public ackWaiter: (() => Promise<void>) | undefined;
  public onAck: (() => Promise<void>) | undefined;
  private readonly listeners = new Set<Listener>();

  public on(method: string, listener: Listener): void {
    if (method === "Page.screencastFrame") this.listeners.add(listener);
  }

  public off(method: string, listener: Listener): void {
    if (method === "Page.screencastFrame") this.listeners.delete(listener);
  }

  public async send(method: string, params?: Record<string, unknown>): Promise<void> {
    this.calls.push({ method, params });
    if (method === "Page.screencastFrameAck") {
      await this.onAck?.();
      await this.ackWaiter?.();
    }
  }

  public emit(payload: unknown): void {
    for (const listener of this.listeners) listener(payload);
  }
}

function fakePage(session: FakeSession, url = "https://allowed.example/demo") {
  return {
    url: () => url,
    context: () => ({ newCDPSession: async () => session }),
  };
}

async function fixtureConfig(): Promise<{ root: string; configPath: string }> {
  const prefix = await mkdtemp(join(tmpdir(), "recordly-browser-capture-prefix-"));
  const root = join(prefix, "run-001");
  const configPath = join(root, "capture-config.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      sessionId: "run-001",
      rootPrefix: prefix,
      rootPath: root,
      allowedOrigins: ["https://allowed.example"],
      format: "jpeg",
      quality: 80,
    }),
    "utf8",
  );
  return { root, configPath };
}

function frame(sessionId: number) {
  return {
    data: Buffer.from(`frame-${sessionId}`).toString("base64"),
    sessionId,
    metadata: { deviceWidth: 1440, deviceHeight: 900 },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: () => resolve?.() };
}

describe("browser CDP capture runtime", () => {
  it("persists, hashes, logs, and ACKs a frame only after its durable write", async () => {
    const { startBrowserCapture, stopBrowserCapture } = await import(runtimeUrl.href);
    const { root, configPath } = await fixtureConfig();
    const session = new FakeSession();
    const page = fakePage(session);
    let rawFilesAtAck: string[] = [];
    session.onAck = async () => {
      rawFilesAtAck = await readdir(join(root, "frames", "raw"));
    };
    await expect(startBrowserCapture(page, configPath)).resolves.toMatchObject({
      status: "running",
    });
    session.emit(frame(1));
    const stopped = await stopBrowserCapture(page, configPath);
    expect(stopped).toMatchObject({ status: "stopped", acceptedFrames: 1, ackedFrames: 1 });
    expect(session.calls.map((call) => call.method)).toEqual([
      "Page.startScreencast",
      "Page.screencastFrameAck",
      "Page.stopScreencast",
    ]);
    const rawFiles = await readdir(join(root, "frames", "raw"));
    expect(rawFiles).toEqual(["frame-000001.jpg"]);
    expect(rawFilesAtAck).toEqual(["frame-000001.jpg"]);
    expect(await readFile(join(root, "frames", "raw", rawFiles[0] ?? ""), "utf8")).toBe("frame-1");
    const rawEvents = await readFile(join(root, "capture-events.jsonl"), "utf8");
    expect(rawEvents).toContain('"sessionId":"run-001"');
    expect(rawEvents).not.toMatch(/cookies|query|headers|body/i);
    expect(JSON.parse(await readFile(join(root, "capture-summary.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      sessionId: "run-001",
      origin: "https://allowed.example",
      status: "stopped",
      receivedFrames: 1,
      acceptedFrames: 1,
      ackedFrames: 1,
      rejectedFrames: 0,
      degradationRequested: false,
    });
  });

  it("fails closed for duplicate starts, wrong pages, traversal, symlinked roots, and disallowed origins", async () => {
    const { startBrowserCapture, stopBrowserCapture } = await import(runtimeUrl.href);
    const { root, configPath } = await fixtureConfig();
    const session = new FakeSession();
    const page = fakePage(session);
    await startBrowserCapture(page, configPath);
    await expect(startBrowserCapture(page, configPath)).rejects.toThrow(/duplicate/i);
    await expect(stopBrowserCapture(fakePage(session), configPath)).rejects.toThrow(/session/i);
    await stopBrowserCapture(page, configPath);
    await expect(
      startBrowserCapture(fakePage(session, "https://blocked.example"), configPath),
    ).rejects.toThrow(/origin/i);
    const crossRoot = await fixtureConfig();
    await writeFile(
      crossRoot.configPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "run-001",
        rootPrefix: join(crossRoot.root, "not-the-parent"),
        rootPath: crossRoot.root,
        allowedOrigins: ["https://allowed.example"],
        format: "jpeg",
        quality: 80,
      }),
      "utf8",
    );
    await expect(startBrowserCapture(page, crossRoot.configPath)).rejects.toThrow(/rootPath/i);
    await expect(
      startBrowserCapture(page, join(root, "..", "capture-config.json")),
    ).rejects.toThrow();
    const linkedRoot = join(root, "frames");
    await rm(linkedRoot, { recursive: true, force: true });
    await symlink("/tmp", linkedRoot);
    await expect(startBrowserCapture(page, configPath)).rejects.toThrow(/symlink/i);
  });

  it("requires a safe sessionId that matches the session directory and rejects schema drift", async () => {
    const { startBrowserCapture } = await import(runtimeUrl.href);
    const { configPath } = await fixtureConfig();
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, sessionId: "other-session" }), "utf8");
    await expect(startBrowserCapture(fakePage(new FakeSession()), configPath)).rejects.toThrow(
      /sessionId/i,
    );
    await writeFile(configPath, JSON.stringify({ ...config, unexpected: true }), "utf8");
    await expect(startBrowserCapture(fakePage(new FakeSession()), configPath)).rejects.toThrow(
      /schema/i,
    );
  });

  it("requests degradation once and fails closed when a blocked writer exceeds the bounded queue", async () => {
    const { startBrowserCapture, stopBrowserCapture } = await import(runtimeUrl.href);
    const { configPath } = await fixtureConfig();
    const gate = deferred();
    const session = new FakeSession();
    session.ackWaiter = () => gate.promise;
    const page = fakePage(session);
    await startBrowserCapture(page, configPath);
    session.emit(frame(1));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    for (let frameId = 2; frameId <= 116; frameId += 1) session.emit(frame(frameId));
    gate.resolve();
    const stopped = await stopBrowserCapture(page, configPath);
    expect(stopped).toMatchObject({
      status: "failed",
      reason: "backpressure",
      degradationRequested: true,
    });
    expect(session.calls.filter((call) => call.method === "Page.startScreencast")).toHaveLength(2);
  });

  it("fails closed when acknowledgement latency exceeds 500ms", async () => {
    const { startBrowserCapture, stopBrowserCapture } = await import(runtimeUrl.href);
    const { configPath } = await fixtureConfig();
    const session = new FakeSession();
    session.ackWaiter = async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 510));
    };
    const page = fakePage(session);
    await startBrowserCapture(page, configPath);
    session.emit(frame(1));
    const stopped = await stopBrowserCapture(page, configPath);
    expect(stopped).toMatchObject({ status: "failed", reason: "ack_timeout", ackedFrames: 1 });
  }, 5_000);
});
