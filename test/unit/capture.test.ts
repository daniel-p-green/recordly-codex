import { describe, expect, it } from "vitest";

import {
  CaptureAdapter,
  type CdpNotificationListener,
  type CdpTransport,
  type DurableFrameStore,
} from "../../src/capture/index.js";
import { validateSessionEvents } from "../../src/contracts/index.js";

type Command = { method: string; params?: Record<string, unknown> };

class FakeCdp implements CdpTransport {
  public readonly commands: Command[] = [];
  public onSend: ((method: string) => void) | undefined;
  public failMethod: string | undefined;
  private listener: CdpNotificationListener | undefined;
  public ackDelayUs = 0;

  public async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push(params === undefined ? { method } : { method, params });
    this.onSend?.(method);
    if (method === this.failMethod) throw new Error(`${method} failed`);
    if (method === "Page.screencastFrameAck" && this.ackDelayUs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.ackDelayUs / 1_000));
    }
    return {};
  }

  public onNotification(listener: CdpNotificationListener): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public notify(method: string, params: unknown): void {
    this.listener?.(method, params);
  }
}

class FakeStore implements DurableFrameStore {
  public readonly frames: Array<{ cdpFrameId: number; payload: string }> = [];
  public fail = false;

  public async enqueue(frame: { cdpFrameId: number; payload: string }) {
    if (this.fail) throw new Error("write failed");
    this.frames.push(frame);
    return {
      imagePath: `frames/raw/${String(frame.cdpFrameId).padStart(6, "0")}.webp`,
      sha256: "a".repeat(64),
      width: 1440,
      height: 900,
    };
  }

  public async flush(): Promise<void> {}
}

function frame(sessionId = 1) {
  return {
    data: "c2FuaXRpemVkLWZyYW1l",
    sessionId,
    metadata: { deviceWidth: 1440, deviceHeight: 900 },
  };
}

function makeClock(values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("CaptureAdapter", () => {
  it("fails closed during startup and rejects invalid lifecycle transitions", async () => {
    const unavailableCdp = new FakeCdp();
    unavailableCdp.failMethod = "Page.startScreencast";
    const unavailable = new CaptureAdapter({
      sessionId: "session-001",
      transport: unavailableCdp,
      store: new FakeStore(),
      clockUs: () => 0,
      telemetry: { emit: () => undefined },
    });
    await expect(unavailable.start()).rejects.toThrow(/startScreencast failed/i);
    unavailableCdp.notify("Page.screencastFrame", frame());
    expect(unavailable.health()).toMatchObject({ status: "failed", receivedFrames: 0 });

    const cdp = new FakeCdp();
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store: new FakeStore(),
      clockUs: () => 0,
      telemetry: { emit: () => undefined },
    });
    await expect(capture.stop()).rejects.toThrow(/has not started/i);
    await capture.start();
    await expect(capture.start()).rejects.toThrow(/only start from idle/i);
    await capture.stop();
    await expect(capture.stop()).resolves.toMatchObject({ status: "stopped" });
  });

  it("counts non-object CDP notifications as malformed rather than acknowledging them", async () => {
    const cdp = new FakeCdp();
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store: new FakeStore(),
      clockUs: () => 0,
      telemetry: { emit: () => undefined },
    });

    await capture.start();
    cdp.notify("Page.screencastFrame", null);
    await capture.flush();

    expect(capture.health()).toMatchObject({
      status: "failed",
      reason: "malformed_frame",
      receivedFrames: 1,
      rejectedFrames: 1,
    });
    expect(cdp.commands.map((command) => command.method)).not.toContain("Page.screencastFrameAck");
  });

  it("starts before accepting frames, durably enqueues before ACK, and emits ordered telemetry", async () => {
    const cdp = new FakeCdp();
    const store = new FakeStore();
    const telemetry: unknown[] = [];
    let persistedFramesAtAck = -1;
    cdp.onSend = (method) => {
      if (method === "Page.screencastFrameAck") persistedFramesAtAck = store.frames.length;
    };
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store,
      clockUs: makeClock([1_000, 1_010, 1_020, 1_030]),
      telemetry: { emit: (event) => telemetry.push(event) },
    });

    await capture.start();
    cdp.notify("Page.screencastFrame", frame(7));
    await capture.flush();

    expect(cdp.commands.map((command) => command.method)).toEqual([
      "Page.startScreencast",
      "Page.screencastFrameAck",
    ]);
    expect(store.frames).toEqual([
      expect.objectContaining({ cdpFrameId: 7, payload: "c2FuaXRpemVkLWZyYW1l" }),
    ]);
    expect(persistedFramesAtAck).toBe(1);
    expect(telemetry).toEqual([
      expect.objectContaining({ type: "frame", seq: 1, tUs: 10 }),
      expect.objectContaining({
        type: "capture_health",
        seq: 2,
        tUs: 30,
        data: expect.objectContaining({ queueOccupancy: 0, ackLatencyUs: 10 }),
      }),
    ]);
    expect(validateSessionEvents(telemetry)).toHaveLength(2);
  });

  it("clamps decreasing clock readings so received frame telemetry stays monotonic", async () => {
    const cdp = new FakeCdp();
    const telemetry: unknown[] = [];
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store: new FakeStore(),
      clockUs: makeClock([1_000, 1_050, 1_040, 1_060, 1_070, 1_080, 1_090, 1_100, 1_110]),
      telemetry: { emit: (event) => telemetry.push(event) },
    });

    await capture.start();
    cdp.notify("Page.screencastFrame", frame(1));
    cdp.notify("Page.screencastFrame", frame(2));
    await capture.flush();

    expect(
      (telemetry as Array<{ type: string; tUs: number }>)
        .filter((event) => event.type === "frame")
        .map((event) => event.tUs),
    ).toEqual([50, 50]);
  });

  it("does not ACK a frame when durable enqueue fails and records the failed capture health", async () => {
    const cdp = new FakeCdp();
    const store = new FakeStore();
    store.fail = true;
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store,
      clockUs: makeClock([0, 10, 20]),
      telemetry: { emit: () => undefined },
    });

    await capture.start();
    cdp.notify("Page.screencastFrame", frame());
    await capture.flush();

    expect(cdp.commands.map((command) => command.method)).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast",
    ]);
    expect(capture.health()).toMatchObject({ status: "failed", reason: "durable_enqueue_failed" });
    expect(capture.health().rejectedFrames).toBe(1);
  });

  it("rejects malformed frames without ACKing or silently counting them as accepted", async () => {
    const cdp = new FakeCdp();
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store: new FakeStore(),
      clockUs: () => 0,
      telemetry: { emit: () => undefined },
    });

    await capture.start();
    cdp.notify("Page.screencastFrame", { sessionId: "bad", data: 12 });
    await capture.flush();

    expect(cdp.commands.map((command) => command.method)).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast",
    ]);
    expect(capture.health()).toMatchObject({
      status: "failed",
      reason: "malformed_frame",
      receivedFrames: 1,
      acceptedFrames: 0,
      rejectedFrames: 1,
    });
  });

  it("requests degradation once above 80% capacity and fails closed above 95% without silent drops", async () => {
    const cdp = new FakeCdp();
    let release: (() => void) | undefined;
    let firstWrite = true;
    const store: DurableFrameStore = {
      enqueue: async (_value) => {
        if (firstWrite) {
          firstWrite = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {
          imagePath: "frames/raw/000001.webp",
          sha256: "a".repeat(64),
          width: 1440,
          height: 900,
        };
      },
      flush: async () => undefined,
    };
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store,
      clockUs: () => 0,
      telemetry: { emit: () => undefined },
    });

    await capture.start();
    for (let frameId = 1; frameId <= 116; frameId += 1)
      cdp.notify("Page.screencastFrame", frame(frameId));

    expect(
      cdp.commands.filter((command) => command.method === "Page.startScreencast"),
    ).toHaveLength(2);
    expect(capture.health()).toMatchObject({
      status: "failed",
      reason: "capture_backpressure",
      receivedFrames: 116,
      acceptedFrames: 115,
      rejectedFrames: 1,
      degradationRequested: true,
    });
    release?.();
    await capture.flush();
  });

  it("fails closed when an ACK exceeds 500ms and stop flushes accepted frames before ending the lifecycle", async () => {
    const cdp = new FakeCdp();
    const store = new FakeStore();
    const capture = new CaptureAdapter({
      sessionId: "session-001",
      transport: cdp,
      store,
      clockUs: makeClock([0, 0, 0, 600_001, 600_001]),
      telemetry: { emit: () => undefined },
    });

    await capture.start();
    cdp.notify("Page.screencastFrame", frame());
    await capture.stop();

    expect(store.frames).toHaveLength(1);
    expect(cdp.commands.map((command) => command.method)).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast",
      "Page.screencastFrameAck",
    ]);
    expect(capture.health()).toMatchObject({ status: "failed", reason: "ack_timeout" });
  });
});
