// biome-ignore-all lint/complexity/useLiteralKeys: CDP frame input is an untrusted dictionary.
import type { SessionEvent } from "../contracts/session-event.js";

const QUEUE_CAPACITY = 120;
const DEGRADE_OCCUPANCY = 0.8;
const FAIL_OCCUPANCY = 0.95;
const ACK_TIMEOUT_US = 500_000;

export type CdpNotificationListener = (method: string, params: unknown) => void;

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: CdpNotificationListener): () => void;
}

export type DurableFrame = {
  imagePath: string;
  sha256: string;
  width: number;
  height: number;
};

export type CapturedFrame = {
  cdpFrameId: number;
  payload: string;
  receivedAtUs: number;
  deviceWidth: number;
  deviceHeight: number;
};

export interface DurableFrameStore {
  enqueue(frame: CapturedFrame): Promise<DurableFrame>;
  flush(): Promise<void>;
}

export interface CaptureTelemetry {
  emit(event: SessionEvent): void;
}

export type CaptureFailureReason =
  | "ack_timeout"
  | "capture_backpressure"
  | "durable_enqueue_failed"
  | "malformed_frame";

export type CaptureHealthResult = {
  status: "running" | "stopped" | "failed";
  reason?: CaptureFailureReason;
  receivedFrames: number;
  acceptedFrames: number;
  rejectedFrames: number;
  degradationRequested: boolean;
};

export type CaptureAdapterOptions = {
  sessionId: string;
  transport: CdpTransport;
  store: DurableFrameStore;
  clockUs: () => number;
  telemetry: CaptureTelemetry;
  screencast?: Record<string, unknown>;
  degradedScreencast?: Record<string, unknown>;
};

type CaptureState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

type QueuedFrame = CapturedFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function parseScreencastFrame(value: unknown, receivedAtUs: number): QueuedFrame | undefined {
  if (!isRecord(value)) return undefined;
  const payload = asNonEmptyString(value["data"]);
  const cdpFrameId = asPositiveInteger(value["sessionId"]);
  const metadata = value["metadata"];
  if (!isRecord(metadata)) return undefined;
  const deviceWidth = asPositiveInteger(metadata["deviceWidth"]);
  const deviceHeight = asPositiveInteger(metadata["deviceHeight"]);
  if (
    payload === undefined ||
    cdpFrameId === undefined ||
    deviceWidth === undefined ||
    deviceHeight === undefined
  ) {
    return undefined;
  }
  return { cdpFrameId, payload, receivedAtUs, deviceWidth, deviceHeight };
}

function defaultScreencast(): Record<string, unknown> {
  return { format: "webp", quality: 90, maxWidth: 1440, maxHeight: 900 };
}

function defaultDegradedScreencast(): Record<string, unknown> {
  return { format: "webp", quality: 70, maxWidth: 1152, maxHeight: 720 };
}

/**
 * Browser CDP intake with a bounded, single-writer queue. The store owns persistence;
 * this adapter owns command order, receipt timing, and the ACK-after-durable-write rule.
 */
export class CaptureAdapter {
  private state: CaptureState = "idle";
  private readonly queue: QueuedFrame[] = [];
  private worker: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private captureStartedAtUs = 0;
  private lastReceiptAtUs = 0;
  private sequence = 0;
  private receivedFrames = 0;
  private acceptedFrames = 0;
  private rejectedFrames = 0;
  private degradationRequested = false;
  private failureReason: CaptureFailureReason | undefined;
  private stopRequested = false;
  private stopCommand: Promise<void> | undefined;

  public constructor(private readonly options: CaptureAdapterOptions) {}

  public async start(): Promise<void> {
    if (this.state !== "idle") throw new Error("capture can only start from idle");
    this.state = "starting";
    this.captureStartedAtUs = this.options.clockUs();
    this.lastReceiptAtUs = this.captureStartedAtUs;
    this.unsubscribe = this.options.transport.onNotification((method, params) => {
      if (method === "Page.screencastFrame") this.receiveFrame(params);
    });

    try {
      await this.options.transport.send(
        "Page.startScreencast",
        this.options.screencast ?? defaultScreencast(),
      );
      if (this.state === "starting") this.state = "running";
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.state = "failed";
      throw error;
    }
  }

  public async stop(): Promise<CaptureHealthResult> {
    if (this.state === "idle") throw new Error("capture has not started");
    if (this.state === "stopped") return this.health();

    if (!this.stopRequested) {
      this.stopRequested = true;
      if (this.state !== "failed") this.state = "stopping";
      this.stopCommand = this.options.transport.send("Page.stopScreencast").then(() => {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      });
    }
    await this.stopCommand;
    await this.flush();
    if (this.state === "stopping") this.state = "stopped";
    return this.health();
  }

  public async flush(): Promise<void> {
    await this.worker;
    await this.options.store.flush();
  }

  public health(): CaptureHealthResult {
    const result: CaptureHealthResult = {
      status: this.state === "failed" ? "failed" : this.state === "stopped" ? "stopped" : "running",
      receivedFrames: this.receivedFrames,
      acceptedFrames: this.acceptedFrames,
      rejectedFrames: this.rejectedFrames,
      degradationRequested: this.degradationRequested,
    };
    if (this.failureReason !== undefined) result.reason = this.failureReason;
    return result;
  }

  private receiveFrame(params: unknown): void {
    if (this.state !== "running" && this.state !== "stopping") return;
    this.receivedFrames += 1;
    const receivedAtUs = this.receiptTimestampUs();
    const frame = parseScreencastFrame(params, receivedAtUs);
    if (frame === undefined) {
      this.rejectedFrames += 1;
      this.fail("malformed_frame");
      return;
    }

    const occupancyAfterEnqueue = (this.queue.length + 1) / QUEUE_CAPACITY;
    if (occupancyAfterEnqueue > FAIL_OCCUPANCY) {
      this.rejectedFrames += 1;
      this.fail("capture_backpressure");
      return;
    }

    this.queue.push(frame);
    this.acceptedFrames += 1;
    if (occupancyAfterEnqueue > DEGRADE_OCCUPANCY && !this.degradationRequested) {
      this.degradationRequested = true;
      void this.requestDegradation();
    }
    this.startWorker();
  }

  private receiptTimestampUs(): number {
    const now = this.options.clockUs();
    const monotonicNow = Math.max(now, this.lastReceiptAtUs);
    this.lastReceiptAtUs = monotonicNow;
    return monotonicNow - this.captureStartedAtUs;
  }

  private startWorker(): void {
    if (this.worker !== undefined) return;
    this.worker = this.drainQueue().finally(() => {
      this.worker = undefined;
      if (this.queue.length > 0) this.startWorker();
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (frame === undefined) return;
      try {
        const durable = await this.options.store.enqueue(frame);
        const ackStartedAtUs = this.options.clockUs();
        await this.options.transport.send("Page.screencastFrameAck", {
          sessionId: frame.cdpFrameId,
        });
        const ackLatencyUs = Math.max(0, this.options.clockUs() - ackStartedAtUs);
        this.emit("frame", frame.receivedAtUs, {
          cdpSessionId: frame.cdpFrameId,
          frameId: frame.cdpFrameId,
          receivedAtUs: frame.receivedAtUs,
          imagePath: durable.imagePath,
          sha256: durable.sha256,
          width: durable.width,
          height: durable.height,
        });
        this.emit("capture_health", this.receiptTimestampUs(), {
          queueOccupancy: this.queue.length / QUEUE_CAPACITY,
          ackLatencyUs,
        });
        if (ackLatencyUs > ACK_TIMEOUT_US) this.fail("ack_timeout");
      } catch {
        this.rejectedFrames += 1;
        this.fail("durable_enqueue_failed");
      }
    }
  }

  private async requestDegradation(): Promise<void> {
    try {
      await this.options.transport.send(
        "Page.startScreencast",
        this.options.degradedScreencast ?? defaultDegradedScreencast(),
      );
    } catch {
      this.fail("capture_backpressure");
    }
  }

  private fail(reason: CaptureFailureReason): void {
    if (this.failureReason !== undefined) return;
    this.failureReason = reason;
    this.state = "failed";
    this.emit("capture_health", this.receiptTimestampUs(), {
      queueOccupancy: this.queue.length / QUEUE_CAPACITY,
      ackLatencyUs: 0,
    });
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.stopCommand = this.options.transport.send("Page.stopScreencast").then(() => {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      });
    }
  }

  private emit(type: SessionEvent["type"], tUs: number, data: Record<string, unknown>): void {
    this.sequence += 1;
    this.options.telemetry.emit({
      schemaVersion: 1,
      sessionId: this.options.sessionId,
      seq: this.sequence,
      tUs,
      type,
      data,
    });
  }
}
