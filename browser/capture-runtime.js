import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const STATE_SYMBOL = Symbol.for("recordly.codex.browser-capture-runtime.v1");
const QUEUE_CAPACITY = 120;
const DEGRADE_OCCUPANCY = 0.8;
const FAIL_OCCUPANCY = 0.95;
const ACK_TIMEOUT_US = 500_000;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function registry() {
  const current = globalThis[STATE_SYMBOL];
  if (current !== undefined) return current;
  const created = { byConfigPath: new Map(), byRootPath: new Set() };
  globalThis[STATE_SYMBOL] = created;
  return created;
}

function asObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function safeString(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new TypeError(`${label} must be safe bounded text`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function isContained(prefix, target) {
  const path = relative(prefix, target);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${"/"}`) && !isAbsolute(path);
}

async function assertDirectory(path, label) {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
}

async function containedDirectory(rootPath, child) {
  const path = resolve(rootPath, child);
  if (!isContained(rootPath, path)) throw new Error("capture artifact path escaped its root");
  const segments = relative(rootPath, path).split("/");
  let current = rootPath;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await lstat(current);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        await mkdir(current);
      } else {
        throw error;
      }
    }
    await assertDirectory(current, "capture artifact directory");
  }
  return path;
}

async function loadConfig(configPath) {
  const canonicalConfigPath = resolve(safeString(configPath, "config path", 1024));
  if (!canonicalConfigPath.endsWith("/capture-config.json")) {
    throw new Error("config path must use the capture-config.json filename");
  }
  const configStatus = await lstat(canonicalConfigPath);
  if (configStatus.isSymbolicLink() || !configStatus.isFile()) {
    throw new Error("config path must be a regular non-symlink file");
  }
  const config = asObject(
    JSON.parse(await readFile(canonicalConfigPath, "utf8")),
    "capture config",
  );
  const keys = [
    "schemaVersion",
    "sessionId",
    "rootPrefix",
    "rootPath",
    "allowedOrigins",
    "format",
    "quality",
  ];
  if (
    Object.keys(config).length !== keys.length ||
    Object.keys(config).some((key) => !keys.includes(key))
  ) {
    throw new Error("capture config has an invalid schema");
  }
  if (config.schemaVersion !== 1) throw new Error("capture config schemaVersion must equal 1");
  const sessionId = safeString(config.sessionId, "sessionId", 128);
  if (!sessionIdPattern.test(sessionId)) throw new Error("sessionId must be safe");
  const rootPrefix = resolve(safeString(config.rootPrefix, "rootPrefix", 1024));
  const rootPath = resolve(safeString(config.rootPath, "rootPath", 1024));
  if (rootPrefix === resolve("/") || !isContained(rootPrefix, rootPath)) {
    throw new Error("rootPath must be contained by a non-root rootPrefix");
  }
  if (canonicalConfigPath !== join(rootPath, "capture-config.json")) {
    throw new Error("config path must be contained at the capture root");
  }
  if (basename(rootPath) !== sessionId) {
    throw new Error("sessionId must match the capture session directory name");
  }
  await assertDirectory(rootPrefix, "rootPrefix");
  await assertDirectory(rootPath, "rootPath");
  const [canonicalPrefix, canonicalRoot] = await Promise.all([
    realpath(rootPrefix),
    realpath(rootPath),
  ]);
  if (!isContained(canonicalPrefix, canonicalRoot))
    throw new Error("canonical capture root escaped its prefix");
  const origins = config.allowedOrigins;
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 20) {
    throw new Error("allowedOrigins must be a bounded non-empty list");
  }
  const allowedOrigins = origins.map((origin) => {
    const parsed = new URL(safeString(origin, "allowed origin"));
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) {
      throw new Error("allowed origins must be canonical HTTP(S) origins");
    }
    return parsed.origin;
  });
  if (new Set(allowedOrigins).size !== allowedOrigins.length)
    throw new Error("allowedOrigins cannot contain duplicates");
  if (config.format !== "jpeg" && config.format !== "png")
    throw new Error("format must be jpeg or png");
  const quality = positiveInteger(config.quality, "quality");
  if (quality > 100) throw new Error("quality must be at most 100");
  return {
    canonicalConfigPath,
    sessionId,
    rootPath: canonicalRoot,
    allowedOrigins,
    format: config.format,
    quality,
  };
}

function status(state) {
  return {
    status: state.status,
    receivedFrames: state.receivedFrames,
    acceptedFrames: state.acceptedFrames,
    ackedFrames: state.ackedFrames,
    rejectedFrames: state.rejectedFrames,
    degradationRequested: state.degradationRequested,
    ...(state.failureReason === undefined ? {} : { reason: state.failureReason }),
  };
}

function nowUs() {
  return Number(process.hrtime.bigint() / 1000n);
}

function frameFromPayload(payload, receivedAtUs) {
  const value = asObject(payload, "screencast frame");
  const data = safeString(value.data, "screencast data", 32 * 1024 * 1024);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
    throw new Error("screencast data must be base64");
  }
  const cdpFrameId = positiveInteger(value.sessionId, "screencast sessionId");
  const metadata = asObject(value.metadata, "screencast metadata");
  return {
    data: Buffer.from(data, "base64"),
    cdpFrameId,
    width: positiveInteger(metadata.deviceWidth, "screencast deviceWidth"),
    height: positiveInteger(metadata.deviceHeight, "screencast deviceHeight"),
    receivedAtUs,
  };
}

async function appendEvent(state, event) {
  await appendFile(state.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function durableWrite(state, frame) {
  state.nextFrameId += 1;
  const extension = state.config.format === "jpeg" ? "jpg" : "png";
  const imagePath = `frames/raw/frame-${String(state.nextFrameId).padStart(6, "0")}.${extension}`;
  const outputPath = join(state.config.rootPath, imagePath);
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, frame.data, { flag: "wx" });
  await rename(temporaryPath, outputPath);
  return {
    frameId: state.nextFrameId,
    imagePath,
    sha256: createHash("sha256").update(frame.data).digest("hex"),
  };
}

function fail(state, reason) {
  if (state.status === "failed") return;
  state.status = "failed";
  state.failureReason = reason;
  state.session.off("Page.screencastFrame", state.listener);
}

function startWorker(state) {
  if (state.worker !== undefined || state.status === "failed") return;
  state.worker = (async () => {
    while (state.queue.length > 0 && state.status !== "failed") {
      const frame = state.queue.shift();
      if (frame === undefined) return;
      try {
        const durable = await durableWrite(state, frame);
        const ackStartedAtUs = nowUs();
        await state.session.send("Page.screencastFrameAck", { sessionId: frame.cdpFrameId });
        const ackLatencyUs = Math.max(0, nowUs() - ackStartedAtUs);
        state.ackedFrames += 1;
        await appendEvent(state, {
          sessionId: state.config.sessionId,
          type: "frame",
          tUs: frame.receivedAtUs,
          frameId: durable.frameId,
          imagePath: durable.imagePath,
          sha256: durable.sha256,
          width: frame.width,
          height: frame.height,
        });
        await appendEvent(state, {
          sessionId: state.config.sessionId,
          type: "capture_health",
          tUs: Math.max(state.lastReceiptAtUs, frame.receivedAtUs),
          queueOccupancy: state.queue.length / QUEUE_CAPACITY,
          ackLatencyUs,
        });
        if (ackLatencyUs > ACK_TIMEOUT_US) fail(state, "ack_timeout");
      } catch {
        state.rejectedFrames += 1;
        fail(state, "durable_or_ack_failed");
      }
    }
  })().finally(() => {
    state.worker = undefined;
    if (state.queue.length > 0 && state.status !== "failed") startWorker(state);
  });
}

function receiveFrame(state, payload) {
  if (state.status !== "running") return status(state);
  state.receivedFrames += 1;
  const receipt = Math.max(nowUs(), state.lastReceiptAtUs);
  state.lastReceiptAtUs = receipt;
  let frame;
  try {
    frame = frameFromPayload(payload, receipt - state.startedAtUs);
  } catch {
    state.rejectedFrames += 1;
    fail(state, "malformed_frame");
    return status(state);
  }
  const occupancy = (state.queue.length + 1) / QUEUE_CAPACITY;
  if (occupancy > FAIL_OCCUPANCY) {
    state.rejectedFrames += 1;
    fail(state, "backpressure");
    return status(state);
  }
  state.queue.push(frame);
  state.acceptedFrames += 1;
  if (occupancy > DEGRADE_OCCUPANCY && !state.degradationRequested) {
    state.degradationRequested = true;
    void state.session
      .send("Page.startScreencast", {
        format: state.config.format,
        quality: Math.max(1, Math.floor(state.config.quality * 0.7)),
        maxWidth: 1152,
        maxHeight: 720,
      })
      .catch(() => fail(state, "degradation_failed"));
  }
  startWorker(state);
  return status(state);
}

async function writeSummary(state) {
  const summaryPath = join(state.config.rootPath, "capture-summary.json");
  const temporaryPath = `${summaryPath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      sessionId: state.config.sessionId,
      origin: state.origin,
      ...status(state),
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await rename(temporaryPath, summaryPath);
}

export async function startBrowserCapture(page, configPath) {
  const config = await loadConfig(configPath);
  const current = registry();
  if (
    current.byConfigPath.has(config.canonicalConfigPath) ||
    current.byRootPath.has(config.rootPath)
  ) {
    throw new Error("duplicate browser capture start is not allowed");
  }
  const origin = new URL(safeString(page?.url?.(), "current page URL", 2048)).origin;
  if (!config.allowedOrigins.includes(origin))
    throw new Error("current page origin is not allowed");
  const rawDirectory = await containedDirectory(config.rootPath, "frames/raw");
  const eventsPath = join(config.rootPath, "capture-events.jsonl");
  const session = await page.context().newCDPSession(page);
  const state = {
    config,
    page,
    session,
    origin,
    rawDirectory,
    eventsPath,
    status: "starting",
    receivedFrames: 0,
    acceptedFrames: 0,
    ackedFrames: 0,
    rejectedFrames: 0,
    degradationRequested: false,
    failureReason: undefined,
    queue: [],
    worker: undefined,
    nextFrameId: 0,
    startedAtUs: nowUs(),
    lastReceiptAtUs: 0,
    listener: undefined,
  };
  state.lastReceiptAtUs = state.startedAtUs;
  state.listener = (payload) => receiveFrame(state, payload);
  current.byConfigPath.set(config.canonicalConfigPath, state);
  current.byRootPath.add(config.rootPath);
  session.on("Page.screencastFrame", state.listener);
  try {
    await session.send("Page.startScreencast", {
      format: config.format,
      quality: config.quality,
      maxWidth: 1440,
      maxHeight: 900,
    });
    state.status = "running";
    return status(state);
  } catch (error) {
    session.off("Page.screencastFrame", state.listener);
    current.byConfigPath.delete(config.canonicalConfigPath);
    current.byRootPath.delete(config.rootPath);
    throw error;
  }
}

export async function stopBrowserCapture(page, configPath) {
  const canonicalConfigPath = resolve(safeString(configPath, "config path", 1024));
  const state = registry().byConfigPath.get(canonicalConfigPath);
  if (state === undefined) throw new Error("no active browser capture session for config path");
  if (state.page !== page) throw new Error("wrong browser page session for capture stop");
  if (state.stopPromise !== undefined) return state.stopPromise;
  state.stopPromise = (async () => {
    state.session.off("Page.screencastFrame", state.listener);
    await state.worker;
    await state.session.send("Page.stopScreencast");
    if (state.status !== "failed") {
      if (
        state.acceptedFrames === 0 ||
        state.ackedFrames !== state.acceptedFrames ||
        state.rejectedFrames !== 0
      ) {
        fail(state, "incomplete_capture");
      } else {
        state.status = "stopped";
      }
    }
    await writeSummary(state);
    registry().byConfigPath.delete(state.config.canonicalConfigPath);
    registry().byRootPath.delete(state.config.rootPath);
    return status(state);
  })();
  return state.stopPromise;
}
