// biome-ignore-all lint/complexity/useLiteralKeys: broker payloads are untrusted dictionary data.
import { createHash, randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { appendFile, lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

// A 1440×900 RGB source is 3.9 MiB before JPEG compression; 8 MiB permits a
// high-quality base64 payload while bounding a single hostile request.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVED_BODY_BYTES = 4 * 1024;
const MAX_OBSERVER_CHALLENGE_BODY_BYTES = 1024;
const QUEUE_CAPACITY = 120;
const DEGRADE_OCCUPANCY = 0.8;
const OBSERVED_RATE_LIMIT = 120;
const OBSERVED_RATE_WINDOW_US = 1_000_000;
const OBSERVED_EVENT_CAP = 10_000;
const OBSERVER_CHALLENGE_CAP = 32;
const SCROLL_COALESCE_US = 16_667;
const MAX_COORDINATE = 1_000_000;

type CaptureCounts = {
  receivedFrames: number;
  acceptedFrames: number;
  ackedFrames: number;
  rejectedFrames: number;
  degradationRequested: boolean;
};

type BrokerInput = {
  sessionId: string;
  root: string;
  origin: string;
  /** Local monotonic microseconds, injectable only to make receipt-order evidence deterministic in tests. */
  clockUs?: () => number;
  onPhase: (phase: "ready" | "claimed" | "running" | "stopped" | "failed") => Promise<void>;
};

type ObservedClick = {
  type: "click";
  data: { x: number; y: number; button: 0 | 1 | 2 };
};

type ObservedScroll = {
  type: "scroll";
  data: { x: number; y: number; deltaX: number; deltaY: number };
};

type ObservedInput = ObservedClick | ObservedScroll;

type PendingObserved = {
  receiptAtUs: number;
  event: ObservedInput;
};

export type BrokerObservedEvent = {
  schemaVersion: 1;
  sessionId: string;
  seq: number;
  type: "click" | "scroll";
  receiptOffsetUs: number;
  data: Record<string, number>;
};

export type CaptureBroker = {
  endpoint: string;
  close(): Promise<void>;
};

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function body(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maximumBytes) throw new Error("body_too_large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -MAX_COORDINATE &&
    value <= MAX_COORDINATE
    ? value
    : undefined;
}

function observedInput(value: unknown): ObservedInput | undefined {
  const event = object(value);
  if (event === undefined || !exactKeys(event, ["type", "data"])) return undefined;
  const data = object(event["data"]);
  if (data === undefined) return undefined;
  if (event["type"] === "click" && exactKeys(data, ["x", "y", "button"])) {
    const x = boundedNumber(data["x"]);
    const y = boundedNumber(data["y"]);
    const button = data["button"];
    if (x !== undefined && y !== undefined && (button === 0 || button === 1 || button === 2)) {
      return { type: "click", data: { x, y, button } };
    }
  }
  if (event["type"] === "scroll" && exactKeys(data, ["x", "y", "deltaX", "deltaY"])) {
    const x = boundedNumber(data["x"]);
    const y = boundedNumber(data["y"]);
    const deltaX = boundedNumber(data["deltaX"]);
    const deltaY = boundedNumber(data["deltaY"]);
    if (
      x !== undefined &&
      y !== undefined &&
      deltaX !== undefined &&
      deltaY !== undefined &&
      (deltaX !== 0 || deltaY !== 0)
    ) {
      return { type: "scroll", data: { x, y, deltaX, deltaY } };
    }
  }
  return undefined;
}

function notFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function ensureObservedEventsFile(root: string): Promise<string> {
  const path = join(root, "observed-events.jsonl");
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o600) {
      throw new Error("observed_events_path_unsafe");
    }
  } catch (error) {
    if (!notFound(error)) throw error;
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
  }
  return path;
}

async function appendPrivateLine(path: string, value: unknown): Promise<void> {
  const handle = await open(
    path,
    fileConstants.O_WRONLY |
      fileConstants.O_APPEND |
      fileConstants.O_NOFOLLOW |
      fileConstants.O_NONBLOCK,
  );
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o777) !== 0o600) {
      throw new Error("observed_events_path_unsafe");
    }
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positive(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function counts(value: Record<string, unknown>): CaptureCounts | undefined {
  const keys = ["receivedFrames", "acceptedFrames", "ackedFrames", "rejectedFrames"] as const;
  const parsed = keys.map((key) => value[key]);
  if (!parsed.every((item) => Number.isSafeInteger(item) && (item as number) >= 0))
    return undefined;
  if (typeof value["degradationRequested"] !== "boolean") return undefined;
  return {
    receivedFrames: parsed[0] as number,
    acceptedFrames: parsed[1] as number,
    ackedFrames: parsed[2] as number,
    rejectedFrames: parsed[3] as number,
    degradationRequested: value["degradationRequested"],
  };
}

export async function createCaptureBroker(input: BrokerInput): Promise<CaptureBroker> {
  await mkdir(join(input.root, "frames", "raw"), { recursive: true, mode: 0o700 });
  const observedEventsPath = await ensureObservedEventsFile(input.root);
  const clockUs = input.clockUs ?? (() => Number(process.hrtime.bigint() / 1_000n));
  const receiptClockUs = (): number => {
    const value = clockUs();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_broker_clock");
    return value;
  };
  let phase: "ready" | "claimed" | "running" | "stopped" | "failed" = "ready";
  let capability: string | undefined;
  let pendingWrites = 0;
  let persistenceTail = Promise.resolve();
  let frameId = 0;
  let firstAcceptedReceiptUs: number | undefined;
  let hasDurableBaselineFrame = false;
  let lastReceiptOffsetUs = -1;
  let lastObservedOffsetUs = -1;
  let observedSequence = 0;
  let observedRequestCount = 0;
  let observedRateWindowStartUs = -1;
  let observedRateReceiptUs = -1;
  let observedRateCount = 0;
  let observerChallengesIssued = 0;
  let pendingScroll: PendingObserved | undefined;
  let failureReason: string | undefined;
  const observed: CaptureCounts = {
    receivedFrames: 0,
    acceptedFrames: 0,
    ackedFrames: 0,
    rejectedFrames: 0,
    degradationRequested: false,
  };
  const setPhase = async (next: typeof phase, reason?: string): Promise<void> => {
    phase = next;
    failureReason = reason;
    await input.onPhase(next);
  };
  const captureFailed = (): boolean => phase === "failed";
  const observedRateAllowed = (receiptAtUs: number): boolean => {
    const effectiveReceiptUs = Math.max(receiptAtUs, observedRateReceiptUs);
    observedRateReceiptUs = effectiveReceiptUs;
    if (
      observedRateWindowStartUs < 0 ||
      effectiveReceiptUs - observedRateWindowStartUs >= OBSERVED_RATE_WINDOW_US
    ) {
      observedRateWindowStartUs = effectiveReceiptUs;
      observedRateCount = 0;
    }
    observedRateCount += 1;
    observedRequestCount += 1;
    return (
      observedRateCount <= OBSERVED_RATE_LIMIT && observedRequestCount <= OBSERVED_EVENT_CAP * 2
    );
  };
  const persistObservedDirect = async (pending: PendingObserved): Promise<void> => {
    if (firstAcceptedReceiptUs === undefined) throw new Error("frame_clock_unavailable");
    if (observedSequence >= OBSERVED_EVENT_CAP) throw new Error("observed_event_cap");
    observedSequence += 1;
    const receiptOffsetUs = Math.max(
      0,
      pending.receiptAtUs - firstAcceptedReceiptUs,
      lastObservedOffsetUs + 1,
    );
    lastObservedOffsetUs = receiptOffsetUs;
    const event: BrokerObservedEvent = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      seq: observedSequence,
      type: pending.event.type,
      receiptOffsetUs,
      data: { ...pending.event.data },
    };
    await appendPrivateLine(observedEventsPath, event);
  };
  const scheduleObservedPersistence = (pending: PendingObserved): Promise<void> => {
    const persist = persistenceTail.then(async () => {
      if (phase !== "claimed" && phase !== "running") {
        throw new Error("capture_not_running");
      }
      await persistObservedDirect(pending);
    });
    const guarded = persist.catch(async (error: unknown) => {
      if (phase !== "failed") await setPhase("failed", "observed_event_persist_failed");
      throw error;
    });
    persistenceTail = guarded.then(
      () => undefined,
      () => undefined,
    );
    return guarded;
  };
  const queueObserved = async (pending: PendingObserved): Promise<void> => {
    if (firstAcceptedReceiptUs === undefined) {
      throw new Error("frame_clock_unavailable");
    }
    await scheduleObservedPersistence(pending);
  };
  const flushPendingScroll = async (): Promise<void> => {
    const pending = pendingScroll;
    pendingScroll = undefined;
    if (pending !== undefined) await queueObserved(pending);
  };
  const writeSummary = async (finalCounts: CaptureCounts): Promise<void> => {
    const temporary = join(input.root, `.capture-summary-${Date.now()}.tmp`);
    const summary = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      origin: input.origin,
      status: phase === "stopped" ? "stopped" : "failed",
      ...finalCounts,
      ...(failureReason === undefined ? {} : { reason: failureReason }),
    };
    await writeFile(temporary, `${JSON.stringify(summary)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(input.root, "capture-summary.json"));
  };
  const server: Server = createServer(async (request, response) => {
    if (
      !isLoopback(request) ||
      request.method !== "POST" ||
      request.headers["content-type"] !== "application/json"
    ) {
      json(response, 404, { ok: false });
      return;
    }
    const isObservedEvent = request.url === "/observed-event";
    const isObserverChallenge = request.url === "/observer-challenge";
    let receiptAtUs: number | undefined;
    if (request.url === "/frame" || isObservedEvent) {
      try {
        receiptAtUs = receiptClockUs();
      } catch {
        if (phase === "claimed" || phase === "running") {
          await setPhase("failed", "invalid_broker_clock");
        }
        json(response, 500, { ok: false });
        return;
      }
    }
    const maximumBodyBytes = isObservedEvent
      ? MAX_OBSERVED_BODY_BYTES
      : isObserverChallenge
        ? MAX_OBSERVER_CHALLENGE_BODY_BYTES
        : MAX_BODY_BYTES;
    const declaredLength = request.headers["content-length"];
    if (
      declaredLength !== undefined &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBodyBytes)
    ) {
      json(response, 413, { ok: false });
      request.resume();
      return;
    }
    let payload: Record<string, unknown> | undefined;
    try {
      payload = object(await body(request, maximumBodyBytes));
    } catch (error) {
      json(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
        ok: false,
      });
      return;
    }
    if (payload?.["sessionId"] !== input.sessionId) return json(response, 400, { ok: false });
    if (isObservedEvent || isObserverChallenge) {
      const expectedKeys = isObservedEvent
        ? ["sessionId", "origin", "event"]
        : ["sessionId", "origin", "documentEpoch", "documentUrl"];
      if (!exactKeys(payload, expectedKeys)) {
        json(response, 400, { ok: false });
        return;
      }
      if (payload["origin"] !== input.origin) {
        json(response, 403, { ok: false });
        return;
      }
      if (isObserverChallenge && !Number.isSafeInteger(payload["documentEpoch"])) {
        json(response, 400, { ok: false });
        return;
      }
      if (isObserverChallenge) {
        if (typeof payload["documentUrl"] !== "string") {
          json(response, 400, { ok: false });
          return;
        }
        let documentUrl: URL;
        try {
          documentUrl = new URL(payload["documentUrl"]);
        } catch {
          json(response, 400, { ok: false });
          return;
        }
        if (
          (documentUrl.protocol !== "http:" && documentUrl.protocol !== "https:") ||
          documentUrl.username !== "" ||
          documentUrl.password !== ""
        ) {
          json(response, 400, { ok: false });
          return;
        }
        if (documentUrl.origin !== input.origin || documentUrl.origin !== payload["origin"]) {
          json(response, 403, { ok: false });
          return;
        }
      }
    } else {
      if (typeof payload["url"] !== "string") return json(response, 400, { ok: false });
      let origin: string;
      try {
        origin = new URL(payload["url"]).origin;
      } catch {
        json(response, 400, { ok: false });
        return;
      }
      if (origin !== input.origin) {
        json(response, 403, { ok: false });
        return;
      }
    }
    if (request.url === "/claim") {
      if (phase !== "ready") return json(response, 409, { ok: false });
      capability = randomBytes(32).toString("hex");
      await setPhase("claimed");
      json(response, 200, { ok: true, token: capability });
      return;
    }
    if (capability === undefined || request.headers["x-recordly-capability"] !== capability) {
      json(response, 403, { ok: false });
      return;
    }
    if (request.url === "/fail") {
      if (phase !== "claimed" && phase !== "running") return json(response, 409, { ok: false });
      await setPhase("failed", "browser_start_failed");
      json(response, 200, { ok: true });
      return;
    }
    if (isObserverChallenge) {
      if (phase !== "claimed" && phase !== "running") return json(response, 409, { ok: false });
      if (!hasDurableBaselineFrame) return json(response, 409, { ok: false });
      if (observerChallengesIssued >= OBSERVER_CHALLENGE_CAP) {
        await setPhase("failed", "observer_challenge_cap");
        json(response, 429, { ok: false });
        return;
      }
      observerChallengesIssued += 1;
      json(response, 200, { ok: true, marker: randomBytes(32).toString("hex") });
      return;
    }
    if (isObservedEvent) {
      if (phase !== "claimed" && phase !== "running") return json(response, 409, { ok: false });
      if (firstAcceptedReceiptUs === undefined) {
        await setPhase("failed", "observed_event_before_baseline");
        json(response, 409, { ok: false });
        return;
      }
      const event = observedInput(payload["event"]);
      if (event === undefined) {
        await setPhase("failed", "malformed_observed_event");
        json(response, 400, { ok: false });
        return;
      }
      if (receiptAtUs === undefined || !observedRateAllowed(receiptAtUs)) {
        await setPhase("failed", "observed_event_flood");
        json(response, 429, { ok: false });
        return;
      }
      try {
        if (event.type === "scroll") {
          const previous = pendingScroll;
          if (
            previous?.event.type === "scroll" &&
            receiptAtUs - previous.receiptAtUs <= SCROLL_COALESCE_US
          ) {
            const deltaX = boundedNumber(previous.event.data.deltaX + event.data.deltaX);
            const deltaY = boundedNumber(previous.event.data.deltaY + event.data.deltaY);
            if (deltaX === undefined || deltaY === undefined) {
              await setPhase("failed", "observed_event_flood");
              json(response, 429, { ok: false });
              return;
            }
            pendingScroll = {
              receiptAtUs,
              event: {
                type: "scroll",
                data: { x: event.data.x, y: event.data.y, deltaX, deltaY },
              },
            };
          } else {
            await flushPendingScroll();
            pendingScroll = { receiptAtUs, event };
          }
        } else {
          await flushPendingScroll();
          await queueObserved({ receiptAtUs, event });
        }
        json(response, 200, { ok: true, accepted: true });
      } catch {
        if (!captureFailed()) await setPhase("failed", "observed_event_persist_failed");
        json(response, 500, { ok: false });
      }
      return;
    }
    if (request.url === "/frame") {
      observed.receivedFrames += 1;
      if ((phase !== "claimed" && phase !== "running") || pendingWrites >= QUEUE_CAPACITY) {
        observed.rejectedFrames += 1;
        if (phase === "claimed" || phase === "running") await setPhase("failed", "backpressure");
        json(response, 429, { ok: false });
        return;
      }
      const frame = object(payload["frame"]);
      const encoded = frame?.["data"];
      const cdpFrameId = positive(frame?.["sessionId"]);
      const metadata = object(frame?.["metadata"]);
      const width = positive(metadata?.["deviceWidth"]);
      const height = positive(metadata?.["deviceHeight"]);
      if (
        typeof encoded !== "string" ||
        encoded.length > 32 * 1024 * 1024 ||
        cdpFrameId === undefined ||
        width === undefined ||
        height === undefined ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
      ) {
        observed.rejectedFrames += 1;
        await setPhase("failed", "malformed_frame");
        json(response, 400, { ok: false });
        return;
      }
      pendingWrites += 1;
      const receiptTimestampUs = receiptAtUs;
      if (receiptTimestampUs === undefined) {
        pendingWrites -= 1;
        await setPhase("failed", "invalid_broker_clock");
        json(response, 500, { ok: false });
        return;
      }
      try {
        await flushPendingScroll();
      } catch {
        pendingWrites -= 1;
        if (!captureFailed()) await setPhase("failed", "observed_event_persist_failed");
        json(response, 500, { ok: false });
        return;
      }
      const persist = persistenceTail.then(async () => {
        if (phase !== "claimed" && phase !== "running") {
          throw new Error("capture_not_running");
        }
        frameId += 1;
        const receiptOffsetUs =
          firstAcceptedReceiptUs === undefined
            ? 0
            : Math.max(receiptTimestampUs - firstAcceptedReceiptUs, lastReceiptOffsetUs + 1);
        if (firstAcceptedReceiptUs === undefined) firstAcceptedReceiptUs = receiptTimestampUs;
        lastReceiptOffsetUs = receiptOffsetUs;
        const bytes = Buffer.from(encoded, "base64");
        const imagePath = `frames/raw/frame-${String(frameId).padStart(6, "0")}.jpg`;
        const destination = join(input.root, imagePath);
        const temporary = `${destination}.${frameId}.tmp`;
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
        await appendFile(
          join(input.root, "capture-events.jsonl"),
          `${JSON.stringify({ sessionId: input.sessionId, type: "frame", frameId, receiptOffsetUs, imagePath, sha256: createHash("sha256").update(bytes).digest("hex"), width, height })}\n`,
          "utf8",
        );
        hasDurableBaselineFrame = true;
        observed.acceptedFrames += 1;
        if (phase === "claimed") await setPhase("running");
        const degrade = pendingWrites / QUEUE_CAPACITY > DEGRADE_OCCUPANCY;
        observed.degradationRequested ||= degrade;
        return degrade;
      });
      const persisted = persist.catch(async (error: unknown) => {
        if (phase !== "failed") await setPhase("failed", "durable_write_failed");
        throw error;
      });
      persistenceTail = persisted.then(
        () => undefined,
        () => undefined,
      );
      try {
        const degrade = await persisted;
        json(response, 200, { ok: true, degrade });
      } catch {
        observed.rejectedFrames += 1;
        json(response, 500, { ok: false });
      } finally {
        pendingWrites -= 1;
      }
      return;
    }
    if (request.url === "/stop") {
      const finalCounts = counts(payload);
      if (finalCounts === undefined || phase === "ready" || phase === "stopped") {
        json(response, 400, { ok: false });
        return;
      }
      try {
        await flushPendingScroll();
        await persistenceTail;
      } catch {
        if (phase !== "failed") await setPhase("failed", "observed_event_persist_failed");
      }
      if (payload["observedEventFailure"] === true && phase !== "failed") {
        await setPhase("failed", "observed_event_delivery_failed");
      }
      observed.ackedFrames = finalCounts.ackedFrames;
      observed.degradationRequested ||= finalCounts.degradationRequested;
      if (
        phase === "running" &&
        observed.acceptedFrames > 0 &&
        observed.acceptedFrames === finalCounts.acceptedFrames &&
        finalCounts.ackedFrames === observed.acceptedFrames &&
        finalCounts.rejectedFrames === 0 &&
        observed.rejectedFrames === 0
      ) {
        await setPhase("stopped");
      } else if (phase === "claimed" || phase === "running") {
        await setPhase("failed", "incomplete_capture");
      }
      await writeSummary({
        ...observed,
        receivedFrames: Math.max(observed.receivedFrames, finalCounts.receivedFrames),
      });
      json(response, 200, { ok: true, status: phase, ...observed });
      return;
    }
    json(response, 404, { ok: false });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("capture broker address unavailable");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (phase === "claimed" || phase === "running") {
        await setPhase("failed", "broker_interrupted");
      }
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    },
  };
}
