import { describe, expect, it, vi } from "vitest";

import { browserStartHelper, browserStopHelper } from "../../mcp/browser-helper.js";

const NONCE_A = "11".repeat(32);
const NONCE_B = "22".repeat(32);
const NONCE_STALE = "33".repeat(32);
const MARKER_A = "aa".repeat(32);
const MARKER_B = "bb".repeat(32);
const MARKER_C = "cc".repeat(32);

function observedEnvelope(nonce: string, event: Record<string, unknown>): string {
  return JSON.stringify({ kind: "event", nonce, event });
}

function markerForEpoch(epoch: unknown): string {
  return epoch === 1 ? MARKER_A : epoch === 2 ? MARKER_B : MARKER_C;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: () => resolve?.() };
}

function deferredValue<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type CdpParams = {
  contextId?: unknown;
  executionContextId?: unknown;
  expression?: unknown;
  name?: unknown;
  payload?: unknown;
  [key: string]: unknown;
};

function findLastCallIndex(
  calls: Array<{ method: string; params?: CdpParams }>,
  predicate: (call: { method: string; params?: CdpParams }) => boolean,
): number {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call !== undefined && predicate(call)) return index;
  }
  return -1;
}

describe("Browser observed-event helper", () => {
  it("arms once per document identity and deduplicates active and pending loader events", async () => {
    const input = {
      sessionId: "session-arm-001",
      endpoint: "http://127.0.0.1:43210",
      origin: "https://recordly.dev",
      bindingName: "__recordly_observed_arm_9b6e",
    };
    const calls: Array<{ method: string; params?: CdpParams }> = [];
    const requests: Array<{ path: string; data: Record<string, unknown> }> = [];
    const cdpListeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
    const nextDocumentWorld = deferredValue<{ executionContextId: number }>();
    let isolatedWorldCreations = 0;
    let injectEvaluationException = false;
    let rejectObserverChallenge = false;
    let initialSecurityOrigin = "https://recordly.dev";
    let currentMarker = MARKER_A;
    const session = {
      on: (event: string, listener: (payload: Record<string, unknown>) => void) => {
        const listeners = cdpListeners.get(event) ?? new Set();
        listeners.add(listener);
        cdpListeners.set(event, listeners);
      },
      off: (event: string, listener: (payload: Record<string, unknown>) => void) => {
        cdpListeners.get(event)?.delete(listener);
      },
      emit: (event: string, payload: CdpParams) => {
        const targetEvent = event === "Runtime.bindingCalled" ? "Runtime.consoleAPICalled" : event;
        const targetPayload =
          event === "Runtime.bindingCalled"
            ? {
                type: "debug",
                args: [
                  { type: "string", value: currentMarker },
                  { type: "string", value: payload.payload },
                ],
                executionContextId: payload.executionContextId,
              }
            : payload;
        for (const listener of cdpListeners.get(targetEvent) ?? []) listener(targetPayload);
      },
      send: async (method: string, params?: CdpParams) => {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "Page.enable") {
          session.emit("Page.frameNavigated", {
            frame: {
              id: "enabled-main-frame",
              loaderId: "loader-enabled",
              url: "https://recordly.dev/workflow",
              securityOrigin: "https://recordly.dev",
            },
          });
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: "enabled-main-frame",
                loaderId: "loader-enabled",
                url: "https://recordly.dev/workflow",
                securityOrigin: initialSecurityOrigin,
              },
            },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          isolatedWorldCreations += 1;
          if (isolatedWorldCreations === 1) return { executionContextId: 42 };
          if (isolatedWorldCreations === 2) return nextDocumentWorld.promise;
          return { executionContextId: 41 + isolatedWorldCreations };
        }
        if (
          method === "Runtime.evaluate" &&
          typeof params?.expression === "string" &&
          params.expression.includes("settleWheel")
        ) {
          session.emit("Runtime.consoleAPICalled", {
            type: "debug",
            args: [
              { type: "string", value: currentMarker },
              {
                type: "string",
                value: JSON.stringify({
                  kind: "ready",
                  nonce: isolatedWorldCreations === 2 ? NONCE_B : NONCE_A,
                }),
              },
            ],
            executionContextId: 41 + isolatedWorldCreations,
          });
          return injectEvaluationException
            ? {
                exceptionDetails: { text: "isolated console failed" },
                result: { type: "string", value: NONCE_A },
              }
            : {
                result: {
                  type: "string",
                  value: isolatedWorldCreations === 2 ? NONCE_A : NONCE_B,
                },
              };
        }
        return {};
      },
    };
    const page = {
      request: {
        post: async (url: string, options: { data: Record<string, unknown> }) => {
          const path = new URL(url).pathname;
          requests.push({ path, data: options.data });
          if (path === "/observer-challenge") {
            if (rejectObserverChallenge) {
              return {
                ok: () => false,
                json: async () => ({ ok: false }),
              };
            }
            currentMarker = markerForEpoch(options.data["documentEpoch"]);
            return {
              ok: () => true,
              json: async () => ({ ok: true, marker: currentMarker }),
            };
          }
          const body =
            path === "/claim"
              ? { ok: true, token: "runtime-only-token" }
              : path === "/stop"
                ? { ok: true, status: "stopped" }
                : { ok: true, accepted: true };
          return { ok: () => true, json: async () => body };
        },
      },
      url: () => "https://recordly.dev/workflow",
      waitForTimeout: () => new Promise<void>(() => undefined),
      context: () => ({ newCDPSession: async () => session }),
    };
    const start = Function(`return (${browserStartHelper(input)})`)() as (
      value: unknown,
    ) => Promise<unknown>;
    const stop = Function(`return (${browserStopHelper(input)})`)() as (
      value: unknown,
    ) => Promise<unknown>;

    let startSettled = false;
    const starting = start(page).finally(() => {
      startSettled = true;
    });
    await flushAsyncWork();
    expect(startSettled).toBe(false);
    expect(calls.filter((call) => call.method === "Page.createIsolatedWorld")).toEqual([]);
    expect(calls.filter((call) => call.method === "Runtime.addBinding")).toEqual([]);
    expect(calls.filter((call) => call.method === "Runtime.evaluate")).toEqual([]);
    expect(calls.filter((call) => call.method === "Runtime.removeBinding")).toEqual([]);

    session.emit("Page.screencastFrame", {
      data: Buffer.from("baseline").toString("base64"),
      sessionId: 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await flushAsyncWork();
    await expect(starting).resolves.toEqual({ status: "running", observedReady: true });
    expect(calls.filter((call) => call.method === "Page.createIsolatedWorld")).toEqual([
      {
        method: "Page.createIsolatedWorld",
        params: {
          frameId: "enabled-main-frame",
          worldName: "recordly-observed-session-arm-001",
          grantUniveralAccess: false,
        },
      },
    ]);
    expect(
      calls.filter(
        (call) =>
          call.method === "Runtime.evaluate" &&
          call.params?.contextId === 42 &&
          typeof call.params.expression === "string" &&
          call.params.expression.includes("settleWheel"),
      ),
    ).toHaveLength(1);

    session.emit("Page.frameNavigated", {
      frame: {
        id: "enabled-main-frame",
        loaderId: "loader-enabled",
        url: "https://recordly.dev/workflow",
        securityOrigin: "https://recordly.dev",
      },
    });
    await flushAsyncWork();
    expect(isolatedWorldCreations).toBe(1);
    expect(calls.filter((call) => call.method === "Runtime.removeBinding")).toHaveLength(0);
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 999,
      payload: observedEnvelope(NONCE_A, {
        type: "click",
        data: { x: 8, y: 9, button: 0 },
      }),
    });
    await flushAsyncWork();
    expect(requests.filter((request) => request.path === "/observed-event")).toEqual([
      {
        path: "/observed-event",
        data: {
          sessionId: input.sessionId,
          origin: "https://recordly.dev",
          event: { type: "click", data: { x: 8, y: 9, button: 0 } },
        },
      },
    ]);

    session.emit("Page.frameNavigated", {
      frame: {
        id: "enabled-main-frame",
        loaderId: "loader-next",
        url: "https://recordly.dev/next",
        securityOrigin: "https://recordly.dev",
      },
    });
    session.emit("Page.frameNavigated", {
      frame: {
        id: "enabled-main-frame",
        loaderId: "loader-next",
        url: "https://recordly.dev/next",
        securityOrigin: "https://recordly.dev",
      },
    });
    await flushAsyncWork();
    expect(isolatedWorldCreations).toBe(2);
    expect(calls.filter((call) => call.method === "Runtime.removeBinding")).toHaveLength(0);
    nextDocumentWorld.resolve({ executionContextId: 43 });
    await flushAsyncWork();
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 42,
      payload: observedEnvelope(NONCE_A, {
        type: "click",
        data: { x: 10, y: 11, button: 0 },
      }),
    });
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 999,
      payload: observedEnvelope(NONCE_B, {
        type: "click",
        data: { x: 12, y: 13, button: 0 },
      }),
    });
    await flushAsyncWork();
    expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(2);
    expect(
      requests.filter((request) => request.path === "/observed-event").at(-1)?.data,
    ).toMatchObject({ event: { type: "click", data: { x: 12, y: 13, button: 0 } } });

    session.emit("Page.frameNavigated", {
      frame: {
        id: "enabled-main-frame",
        loaderId: "loader-enabled",
        url: "https://recordly.dev/workflow",
        securityOrigin: "https://recordly.dev",
      },
    });
    await flushAsyncWork();
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 43,
      payload: observedEnvelope(NONCE_B, {
        type: "scroll",
        data: { x: 0, y: 10, deltaX: 0, deltaY: 10 },
      }),
    });
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 44,
      payload: observedEnvelope(NONCE_A, {
        type: "click",
        data: { x: 14, y: 15, button: 0 },
      }),
    });
    await flushAsyncWork();
    expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(3);
    expect(
      requests
        .filter((request) => request.path === "/observer-challenge")
        .map((request) => ({
          documentEpoch: request.data["documentEpoch"],
          documentUrl: request.data["documentUrl"],
        })),
    ).toEqual([
      { documentEpoch: 1, documentUrl: "https://recordly.dev/workflow" },
      { documentEpoch: 2, documentUrl: "https://recordly.dev/next" },
      { documentEpoch: 3, documentUrl: "https://recordly.dev/workflow" },
    ]);

    const challengeCountBeforeCrossOrigin = requests.filter(
      (request) => request.path === "/observer-challenge",
    ).length;
    const installCountBeforeCrossOrigin = calls.filter(
      (call) => call.method === "Page.createIsolatedWorld",
    ).length;
    const eventCountBeforeCrossOrigin = requests.filter(
      (request) => request.path === "/observed-event",
    ).length;
    session.emit("Page.frameNavigated", {
      frame: {
        id: "enabled-main-frame",
        loaderId: "loader-cross-origin",
        url: "https://other.example/attempted-bypass",
        securityOrigin: "https://other.example",
      },
    });
    await flushAsyncWork();
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 44,
      payload: observedEnvelope(NONCE_A, {
        type: "click",
        data: { x: 16, y: 17, button: 0 },
      }),
    });
    await flushAsyncWork();
    expect(requests.filter((request) => request.path === "/observer-challenge")).toHaveLength(
      challengeCountBeforeCrossOrigin,
    );
    expect(calls.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(
      installCountBeforeCrossOrigin,
    );
    expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(
      eventCountBeforeCrossOrigin,
    );
    await expect(stop(page)).resolves.toMatchObject({ status: "stopped" });
    expect(requests.find((request) => request.path === "/stop")?.data).toMatchObject({
      observedEventFailure: true,
    });

    for (const malformedPayload of [
      JSON.stringify({ event: { type: "click", data: { x: 1, y: 2, button: 0 } } }),
      "{not-json",
    ]) {
      const restarting = start(page);
      await flushAsyncWork();
      session.emit("Page.screencastFrame", {
        data: Buffer.from("baseline").toString("base64"),
        sessionId: isolatedWorldCreations + 1,
        metadata: { deviceWidth: 1440, deviceHeight: 900 },
      });
      await expect(restarting).resolves.toEqual({ status: "running", observedReady: true });
      const observedCount = requests.filter((request) => request.path === "/observed-event").length;
      session.emit("Runtime.bindingCalled", {
        name: input.bindingName,
        executionContextId: 999,
        payload: malformedPayload,
      });
      await flushAsyncWork();
      await expect(stop(page)).resolves.toMatchObject({ status: "stopped" });
      expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(
        observedCount,
      );
      expect(requests.filter((request) => request.path === "/stop").at(-1)?.data).toMatchObject({
        observedEventFailure: true,
      });
    }

    injectEvaluationException = true;
    const rejectedRestart = start(page);
    await flushAsyncWork();
    session.emit("Page.screencastFrame", {
      data: Buffer.from("baseline").toString("base64"),
      sessionId: isolatedWorldCreations + 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await expect(rejectedRestart).rejects.toThrow("recordly isolated observer evaluation failed");
    expect(
      (page as Record<string, unknown>)[`__recordlyCapture_${input.sessionId}`],
    ).toBeUndefined();

    injectEvaluationException = false;
    rejectObserverChallenge = true;
    const rejectedChallengeRestart = start(page);
    await flushAsyncWork();
    session.emit("Page.screencastFrame", {
      data: Buffer.from("baseline").toString("base64"),
      sessionId: isolatedWorldCreations + 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await expect(rejectedChallengeRestart).rejects.toThrow(
      "recordly capture broker rejected request",
    );
    expect(
      (page as Record<string, unknown>)[`__recordlyCapture_${input.sessionId}`],
    ).toBeUndefined();

    rejectObserverChallenge = false;
    initialSecurityOrigin = "https://other.example";
    const challengeCountBeforeInitialMismatch = requests.filter(
      (request) => request.path === "/observer-challenge",
    ).length;
    const installCountBeforeInitialMismatch = calls.filter(
      (call) => call.method === "Page.createIsolatedWorld",
    ).length;
    const rejectedInitialOrigin = start(page);
    await flushAsyncWork();
    session.emit("Page.screencastFrame", {
      data: Buffer.from("baseline").toString("base64"),
      sessionId: isolatedWorldCreations + 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await expect(rejectedInitialOrigin).rejects.toThrow(
      "recordly main-frame document identity unavailable",
    );
    expect(requests.filter((request) => request.path === "/observer-challenge")).toHaveLength(
      challengeCountBeforeInitialMismatch,
    );
    expect(calls.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(
      installCountBeforeInitialMismatch,
    );
  });

  it("keeps only the newest isolated world active when navigation wins the first-frame race", async () => {
    const input = {
      sessionId: "session-race-001",
      endpoint: "http://127.0.0.1:43210",
      origin: "https://recordly.dev",
      bindingName: "__recordly_observed_race_9b6e",
    };
    const firstWorld = deferredValue<{ executionContextId: number }>();
    const latestWorld = deferredValue<{ executionContextId: number }>();
    const stopWorld = deferredValue<{ executionContextId: number }>();
    const calls: Array<{ method: string; params?: CdpParams }> = [];
    const requests: Array<{ path: string; data: Record<string, unknown> }> = [];
    const cdpListeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
    let isolatedWorldCreations = 0;
    let currentMarker = MARKER_A;
    const session = {
      on: (event: string, listener: (payload: Record<string, unknown>) => void) => {
        const listeners = cdpListeners.get(event) ?? new Set();
        listeners.add(listener);
        cdpListeners.set(event, listeners);
      },
      off: (event: string, listener: (payload: Record<string, unknown>) => void) => {
        cdpListeners.get(event)?.delete(listener);
      },
      send: async (method: string, params?: CdpParams) => {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: "first-frame",
                loaderId: "loader-first",
                url: "https://recordly.dev/first",
                securityOrigin: "https://recordly.dev",
              },
            },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          isolatedWorldCreations += 1;
          if (isolatedWorldCreations === 1) return firstWorld.promise;
          if (isolatedWorldCreations === 2) return latestWorld.promise;
          if (isolatedWorldCreations === 3) return stopWorld.promise;
          throw new Error("unexpected isolated world creation");
        }
        if (
          method === "Runtime.evaluate" &&
          typeof params?.expression === "string" &&
          params.expression.includes("settleWheel")
        ) {
          session.emit("Runtime.consoleAPICalled", {
            type: "debug",
            args: [
              { type: "string", value: currentMarker },
              { type: "string", value: JSON.stringify({ kind: "ready", nonce: NONCE_B }) },
            ],
            executionContextId: params.contextId,
          });
          return { result: { type: "string", value: NONCE_B } };
        }
        return {};
      },
      emit: (event: string, payload: CdpParams) => {
        const targetEvent = event === "Runtime.bindingCalled" ? "Runtime.consoleAPICalled" : event;
        const targetPayload =
          event === "Runtime.bindingCalled"
            ? {
                type: "debug",
                args: [
                  { type: "string", value: currentMarker },
                  { type: "string", value: payload.payload },
                ],
                executionContextId: payload.executionContextId,
              }
            : payload;
        for (const listener of cdpListeners.get(targetEvent) ?? []) listener(targetPayload);
      },
    };
    const page = {
      request: {
        post: async (url: string, options: { data: Record<string, unknown> }) => {
          const path = new URL(url).pathname;
          requests.push({ path, data: options.data });
          if (path === "/observer-challenge") {
            currentMarker = markerForEpoch(options.data["documentEpoch"]);
            return {
              ok: () => true,
              json: async () => ({ ok: true, marker: currentMarker }),
            };
          }
          const body =
            path === "/claim"
              ? { ok: true, token: "runtime-only-token" }
              : path === "/stop"
                ? { ok: true, status: "stopped" }
                : { ok: true, accepted: true };
          return { ok: () => true, json: async () => body };
        },
      },
      url: () => "https://recordly.dev/workflow",
      waitForTimeout: () => new Promise<void>(() => undefined),
      context: () => ({ newCDPSession: async () => session }),
    };
    const start = Function(`return (${browserStartHelper(input)})`)() as (
      value: unknown,
    ) => Promise<unknown>;
    const stop = Function(`return (${browserStopHelper(input)})`)() as (
      value: unknown,
    ) => Promise<unknown>;

    let startSettled = false;
    const starting = start(page).finally(() => {
      startSettled = true;
    });
    await flushAsyncWork();
    session.emit("Page.screencastFrame", {
      data: Buffer.from("first").toString("base64"),
      sessionId: 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await flushAsyncWork();
    expect(isolatedWorldCreations).toBe(1);

    session.emit("Page.frameNavigated", {
      frame: {
        id: "latest-frame",
        loaderId: "loader-latest",
        url: "https://recordly.dev/latest",
        securityOrigin: "https://recordly.dev",
      },
    });
    firstWorld.resolve({ executionContextId: 101 });
    await flushAsyncWork();
    expect(startSettled).toBe(false);
    latestWorld.resolve({ executionContextId: 102 });
    await flushAsyncWork();
    await expect(starting).resolves.toEqual({ status: "running", observedReady: true });

    expect(calls.filter((call) => call.method === "Runtime.addBinding")).toEqual([]);
    const staleCleanupIndex = calls.findIndex(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params?.contextId === 101 &&
        typeof call.params.expression === "string" &&
        call.params.expression.includes("const cleanup ="),
    );
    const latestInstallIndex = calls.findIndex(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params?.contextId === 102 &&
        typeof call.params.expression === "string" &&
        call.params.expression.includes("settleWheel"),
    );
    expect(staleCleanupIndex).toBeGreaterThanOrEqual(0);
    expect(latestInstallIndex).toBeGreaterThan(staleCleanupIndex);

    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 101,
      payload: observedEnvelope(NONCE_STALE, {
        type: "click",
        data: { x: 1, y: 2, button: 0 },
      }),
    });
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 102,
      payload: observedEnvelope(NONCE_B, {
        type: "click",
        data: { x: 3, y: 4, button: 0 },
      }),
    });
    await flushAsyncWork();
    expect(requests.filter((request) => request.path === "/observed-event")).toEqual([
      {
        path: "/observed-event",
        data: {
          sessionId: input.sessionId,
          origin: "https://recordly.dev",
          event: { type: "click", data: { x: 3, y: 4, button: 0 } },
        },
      },
    ]);

    session.emit("Page.frameNavigated", {
      frame: {
        id: "stop-race-frame",
        loaderId: "loader-stop-race",
        url: "https://recordly.dev/stop-race",
        securityOrigin: "https://recordly.dev",
      },
    });
    await flushAsyncWork();
    expect(isolatedWorldCreations).toBe(3);
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 102,
      payload: observedEnvelope(NONCE_B, {
        type: "click",
        data: { x: 5, y: 6, button: 0 },
      }),
    });
    await flushAsyncWork();

    const stopping = stop(page);
    await flushAsyncWork();
    expect(requests.some((request) => request.path === "/stop")).toBe(false);
    stopWorld.resolve({ executionContextId: 103 });
    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    expect(requests.find((request) => request.path === "/stop")?.data).toMatchObject({
      observedEventFailure: true,
    });
    expect(calls.filter((call) => call.method === "Runtime.addBinding")).toEqual([]);
    const stopCleanupIndex = findLastCallIndex(
      calls,
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params?.contextId === 103 &&
        typeof call.params.expression === "string" &&
        call.params.expression.includes("const cleanup ="),
    );
    const stopScreencastIndex = findLastCallIndex(
      calls,
      (call) => call.method === "Page.stopScreencast",
    );
    expect(stopCleanupIndex).toBeGreaterThan(latestInstallIndex);
    expect(stopScreencastIndex).toBeGreaterThan(stopCleanupIndex);
    expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(1);
  });

  it.each(["Page.createIsolatedWorld", "Runtime.evaluate", "ready-handshake"] as const)(
    "fails startup and tears down capture when %s stalls observer readiness",
    async (stalledMethod) => {
      vi.useFakeTimers();
      try {
        const input = {
          sessionId: "session-timeout-001",
          endpoint: "http://127.0.0.1:43210",
          origin: "https://recordly.dev",
          bindingName: "__recordly_observed_timeout_9b6e",
        };
        const calls: Array<{ method: string; params?: CdpParams }> = [];
        const requests: Array<{ path: string; data: Record<string, unknown> }> = [];
        const cdpListeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
        const stalledStage = deferredValue<Record<string, unknown>>();
        const stalledTeardown = new Promise<never>(() => undefined);
        let detached = false;
        let currentMarker = MARKER_A;
        const session = {
          on: (event: string, listener: (payload: Record<string, unknown>) => void) => {
            const listeners = cdpListeners.get(event) ?? new Set();
            listeners.add(listener);
            cdpListeners.set(event, listeners);
          },
          off: (event: string, listener: (payload: Record<string, unknown>) => void) => {
            cdpListeners.get(event)?.delete(listener);
          },
          emit: (event: string, payload: CdpParams) => {
            const targetEvent =
              event === "Runtime.bindingCalled" ? "Runtime.consoleAPICalled" : event;
            const targetPayload =
              event === "Runtime.bindingCalled"
                ? {
                    type: "debug",
                    args: [
                      { type: "string", value: currentMarker },
                      { type: "string", value: payload.payload },
                    ],
                    executionContextId: payload.executionContextId,
                  }
                : payload;
            for (const listener of cdpListeners.get(targetEvent) ?? []) listener(targetPayload);
          },
          detach: async () => {
            detached = true;
          },
          send: async (method: string, params?: CdpParams) => {
            calls.push({ method, ...(params === undefined ? {} : { params }) });
            if (method === "Page.getFrameTree") {
              return {
                frameTree: {
                  frame: {
                    id: "timeout-main-frame",
                    loaderId: "loader-timeout",
                    url: "https://recordly.dev/timeout",
                    securityOrigin: "https://recordly.dev",
                  },
                },
              };
            }
            if (method === "Page.createIsolatedWorld") {
              if (stalledMethod === method) return stalledStage.promise;
              return { executionContextId: 301 };
            }
            if (
              method === "Runtime.evaluate" &&
              stalledMethod === method &&
              typeof params?.expression === "string" &&
              params.expression.includes("settleWheel")
            ) {
              session.emit("Runtime.consoleAPICalled", {
                type: "debug",
                args: [
                  { type: "string", value: currentMarker },
                  { type: "string", value: JSON.stringify({ kind: "ready", nonce: NONCE_A }) },
                ],
                executionContextId: params.contextId,
              });
              return stalledStage.promise;
            }
            if (
              method === "Runtime.evaluate" &&
              typeof params?.expression === "string" &&
              params.expression.includes("settleWheel")
            ) {
              if (stalledMethod !== "ready-handshake") {
                session.emit("Runtime.consoleAPICalled", {
                  type: "debug",
                  args: [
                    { type: "string", value: currentMarker },
                    { type: "string", value: JSON.stringify({ kind: "ready", nonce: NONCE_A }) },
                  ],
                  executionContextId: params.contextId,
                });
              }
              return { result: { type: "string", value: NONCE_B } };
            }
            if (method === "Page.stopScreencast") {
              return stalledTeardown;
            }
            return {};
          },
        };
        const page = {
          request: {
            post: async (url: string, options: { data: Record<string, unknown> }) => {
              const path = new URL(url).pathname;
              requests.push({ path, data: options.data });
              if (path === "/observer-challenge") {
                currentMarker = markerForEpoch(options.data["documentEpoch"]);
                return {
                  ok: () => true,
                  json: async () => ({ ok: true, marker: currentMarker }),
                };
              }
              if (path === "/fail") return stalledTeardown;
              const body =
                path === "/claim"
                  ? { ok: true, token: "runtime-only-token" }
                  : { ok: true, accepted: true };
              return { ok: () => true, json: async () => body };
            },
          },
          url: () => "https://recordly.dev/workflow",
          waitForTimeout: (milliseconds: number) =>
            new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)),
          context: () => ({ newCDPSession: async () => session }),
        } as Record<string, unknown> & {
          request: { post: (...args: never[]) => Promise<unknown> };
          url: () => string;
        };
        const start = Function(
          "setTimeout",
          "clearTimeout",
          `return (${browserStartHelper(input)})`,
        )(undefined, undefined) as (value: unknown) => Promise<unknown>;

        const starting = start(page);
        let outcome: { status: "resolved" } | { status: "rejected"; error: unknown } | undefined;
        void starting.then(
          () => {
            outcome = { status: "resolved" };
          },
          (error: unknown) => {
            outcome = { status: "rejected", error };
          },
        );
        await vi.advanceTimersByTimeAsync(0);
        session.emit("Page.screencastFrame", {
          data: Buffer.from("baseline").toString("base64"),
          sessionId: 1,
          metadata: { deviceWidth: 1440, deviceHeight: 900 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(
          calls.some((call) =>
            stalledMethod === "ready-handshake"
              ? call.method === "Runtime.evaluate" &&
                typeof call.params?.expression === "string" &&
                call.params.expression.includes("settleWheel")
              : call.method === stalledMethod,
          ),
        ).toBe(true);

        await vi.advanceTimersByTimeAsync(12_000);
        expect(outcome?.status).toBe("rejected");
        expect(outcome).toMatchObject({
          error: expect.objectContaining({
            message: "recordly observed-event readiness timed out",
          }),
        });
        expect(requests.some((request) => request.path === "/fail")).toBe(true);
        expect(calls).toContainEqual({ method: "Page.stopScreencast" });
        expect(detached).toBe(true);
        expect([...cdpListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
        expect(page[`__recordlyCapture_${input.sessionId}`]).toBeUndefined();

        const addBindingCount = calls.filter((call) => call.method === "Runtime.addBinding").length;
        const observerEvaluationCount = calls.filter(
          (call) =>
            call.method === "Runtime.evaluate" &&
            typeof call.params?.expression === "string" &&
            call.params.expression.includes("settleWheel"),
        ).length;
        stalledStage.resolve(
          stalledMethod === "Page.createIsolatedWorld" ? { executionContextId: 301 } : {},
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.filter((call) => call.method === "Runtime.addBinding")).toHaveLength(
          addBindingCount,
        );
        expect(
          calls.filter(
            (call) =>
              call.method === "Runtime.evaluate" &&
              typeof call.params?.expression === "string" &&
              call.params.expression.includes("settleWheel"),
          ),
        ).toHaveLength(observerEvaluationCount);
        session.emit("Runtime.bindingCalled", {
          name: input.bindingName,
          executionContextId: 301,
          payload: JSON.stringify({ type: "click", data: { x: 1, y: 2, button: 0 } }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(requests.some((request) => request.path === "/observed-event")).toBe(false);
        expect(page[`__recordlyCapture_${input.sessionId}`]).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("uses a context-scoped isolated-world binding that target page JavaScript cannot call", async () => {
    const input = {
      sessionId: "session-001",
      endpoint: "http://127.0.0.1:43210",
      origin: "https://recordly.dev",
      bindingName: "__recordly_observed_test_9b6e",
    };
    const startSource = browserStartHelper(input);
    const stopSource = browserStopHelper(input);
    expect(`${startSource}\n${stopSource}`).not.toMatch(
      /Runtime\.(?:addBinding|removeBinding|bindingCalled)|discardConsoleEntries/u,
    );
    expect(startSource).toContain("Runtime.consoleAPICalled");
    expect(startSource).toContain("Page.createIsolatedWorld");
    expect(startSource).toContain("page.waitForTimeout(10000)");
    expect(startSource).toContain("page.waitForTimeout(250)");
    expect(startSource).not.toContain("clearTimeout(timeout)");
    expect(startSource).not.toContain("setTimeout(() => reject");
    expect(startSource).toContain("Runtime.consoleAPICalled");
    expect(startSource).not.toContain("page.exposeBinding");
    expect(startSource).not.toContain("page.evaluate");
    expect(startSource).toContain("/observed-event");
    expect(`${startSource}\n${stopSource}`).not.toContain("new URL");
    expect(startSource).toContain("addEventListener('click'");
    expect(startSource).toContain("addEventListener('wheel'");
    expect(startSource).toContain("event.isTrusted");
    expect(startSource).not.toContain("addEventListener('scroll'");
    expect(startSource).toContain("wheelAttempts++ >= 119");
    expect(startSource).toContain("setTimeout(settleWheel, 16)");
    expect(startSource).toContain("clearTimeout(wheelTimer)");
    expect(stopSource).not.toContain("Runtime.removeBinding");
    expect(stopSource).toContain("observedPending");
    expect(stopSource).toContain("Promise.allSettled(capture.state.observedPending)");
    expect(`${startSource}\n${stopSource}`).not.toMatch(
      /textContent|outerHTML|innerHTML|selector|localStorage|document\\.cookie|[0-9a-f]{64}/iu,
    );

    const requests: Array<{
      path: string;
      headers: Record<string, string>;
      data: Record<string, unknown>;
    }> = [];
    const pageListeners = new Map<string, Set<() => void>>();
    const observedGate = deferred();
    let holdObserved = false;
    const cdpListeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
    const calls: Array<{ method: string; params?: CdpParams }> = [];
    let nextContextId = 40;
    let destroyOldContextDuringCleanup = false;
    let currentMarker = MARKER_A;
    const session = {
      on: (event: string, listener: (payload: Record<string, unknown>) => void) => {
        const current = cdpListeners.get(event) ?? new Set();
        current.add(listener);
        cdpListeners.set(event, current);
      },
      off: (event: string, listener: (payload: Record<string, unknown>) => void) => {
        cdpListeners.get(event)?.delete(listener);
      },
      send: async (method: string, params?: CdpParams) => {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: "main-frame",
                loaderId: "loader-main",
                url: "https://recordly.dev/private?must-not-persist=true",
                securityOrigin: "https://recordly.dev",
              },
            },
          };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: ++nextContextId };
        if (
          method === "Runtime.evaluate" &&
          destroyOldContextDuringCleanup &&
          params?.contextId === 41 &&
          typeof params.expression === "string" &&
          params.expression.includes("const cleanup =")
        ) {
          throw new Error("Cannot find context with specified id");
        }
        if (
          method === "Runtime.evaluate" &&
          typeof params?.expression === "string" &&
          params.expression.includes("settleWheel")
        ) {
          const nonce = params.contextId === 41 ? NONCE_A : NONCE_B;
          session.emit("Runtime.consoleAPICalled", {
            type: "debug",
            args: [
              { type: "string", value: currentMarker },
              { type: "string", value: JSON.stringify({ kind: "ready", nonce }) },
            ],
            executionContextId: params.contextId,
          });
          session.emit("Runtime.consoleAPICalled", {
            type: "debug",
            args: [
              { type: "string", value: currentMarker },
              {
                type: "string",
                value: JSON.stringify({
                  kind: "ready",
                  nonce: nonce === NONCE_A ? NONCE_B : NONCE_A,
                }),
              },
            ],
            executionContextId: params.contextId,
          });
          return {
            result: {
              type: "string",
              value: nonce === NONCE_A ? NONCE_B : NONCE_A,
            },
          };
        }
        return {};
      },
      emit: (event: string, payload: CdpParams) => {
        const targetEvent = event === "Runtime.bindingCalled" ? "Runtime.consoleAPICalled" : event;
        const targetPayload =
          event === "Runtime.bindingCalled"
            ? {
                type: "debug",
                args: [
                  { type: "string", value: currentMarker },
                  { type: "string", value: payload.payload },
                ],
                executionContextId: payload.executionContextId,
              }
            : payload;
        for (const listener of cdpListeners.get(targetEvent) ?? []) listener(targetPayload);
      },
    };
    const page = {
      request: {
        post: async (
          url: string,
          options: { headers: Record<string, string>; data: Record<string, unknown> },
        ) => {
          const path = new URL(url).pathname;
          requests.push({ path, ...options });
          if (path === "/observer-challenge") {
            currentMarker = markerForEpoch(options.data["documentEpoch"]);
            return {
              ok: () => true,
              json: async () => ({ ok: true, marker: currentMarker }),
            };
          }
          if (path === "/observed-event" && holdObserved) await observedGate.promise;
          const body =
            path === "/claim"
              ? { ok: true, token: "runtime-only-token" }
              : path === "/stop"
                ? {
                    ok: true,
                    status: "stopped",
                    receivedFrames: 0,
                    acceptedFrames: 0,
                    ackedFrames: 0,
                    rejectedFrames: 0,
                    degradationRequested: false,
                  }
                : { ok: true, accepted: true };
          return { ok: () => true, json: async () => body };
        },
      },
      url: () => "https://recordly.dev/private?must-not-persist=true",
      waitForTimeout: () => new Promise<void>(() => undefined),
      context: () => ({
        newCDPSession: async () => session,
      }),
      on: (event: string, listener: () => void) => {
        const current = pageListeners.get(event) ?? new Set();
        current.add(listener);
        pageListeners.set(event, current);
      },
      off: (event: string, listener: () => void) => {
        pageListeners.get(event)?.delete(listener);
      },
    } as Record<string, unknown> & {
      request: { post: (...args: never[]) => Promise<unknown> };
      url: () => string;
    };
    const start = Function("URL", `return (${startSource})`)(undefined) as (
      value: unknown,
    ) => Promise<unknown>;
    const stop = Function("URL", `return (${stopSource})`)(undefined) as (
      value: unknown,
    ) => Promise<unknown>;

    const starting = start(page);
    await flushAsyncWork();
    session.emit("Page.screencastFrame", {
      data: Buffer.from("baseline").toString("base64"),
      sessionId: 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await expect(starting).resolves.toEqual({ status: "running", observedReady: true });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "Runtime.evaluate",
          params: expect.objectContaining({ contextId: 41 }),
        }),
      ]),
    );
    const isolatedExpression = calls.find(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params?.contextId === 41 &&
        typeof call.params.expression === "string" &&
        call.params.expression.includes("settleWheel"),
    )?.params?.expression;
    if (typeof isolatedExpression !== "string") throw new Error("missing isolated observer");
    const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
    let mainWorldConsoleCalls = 0;
    const fakeWindow = {
      scrollX: 0,
      scrollY: 0,
      console: {
        debug: () => {
          mainWorldConsoleCalls += 1;
        },
      },
      addEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) =>
        listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    const callbacks = new Map<number, () => void>();
    let nextCallback = 0;
    const deliveries: Array<Record<string, unknown>> = [];
    const consoleMarkers: string[] = [];
    const isolatedGlobal: Record<string, unknown> = {};
    let requestedCryptoBytes = 0;
    const evaluateIsolated = Function(
      "window",
      "globalThis",
      "crypto",
      "console",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "setTimeout",
      "clearTimeout",
      `return ${isolatedExpression}`,
    ) as (...args: unknown[]) => unknown;
    const evaluatedNonce = evaluateIsolated(
      fakeWindow,
      isolatedGlobal,
      {
        getRandomValues: (bytes: Uint8Array) => {
          requestedCryptoBytes = bytes.length;
          for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
          return bytes;
        },
      },
      {
        debug: (marker: string, payload: string) => {
          consoleMarkers.push(marker);
          deliveries.push(JSON.parse(payload) as Record<string, unknown>);
        },
      },
      (callback: () => void) => {
        const id = ++nextCallback;
        callbacks.set(id, callback);
        return id;
      },
      (id: number) => callbacks.delete(id),
      (callback: () => void) => {
        const id = ++nextCallback;
        callbacks.set(id, callback);
        return id;
      },
      (id: number) => callbacks.delete(id),
    );
    expect(requestedCryptoBytes).toBe(32);
    expect(evaluatedNonce).toBeUndefined();
    expect(Object.keys(isolatedGlobal)).toEqual(["__recordlyCleanup_session-001"]);
    const flushOne = () => {
      const next = callbacks.entries().next().value as [number, () => void] | undefined;
      if (next !== undefined) {
        callbacks.delete(next[0]);
        next[1]();
      }
    };
    listeners.get("wheel")?.({ isTrusted: true });
    for (let index = 0; index < 9; index += 1) flushOne();
    expect(deliveries).toEqual([
      {
        kind: "ready",
        nonce: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      },
    ]);
    fakeWindow.scrollY = 1440;
    flushOne();
    flushOne();
    expect(deliveries).toEqual([
      {
        kind: "ready",
        nonce: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      },
      {
        kind: "event",
        nonce: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        event: { type: "scroll", data: { x: 0, y: 1440, deltaX: 0, deltaY: 1440 } },
      },
    ]);
    expect(consoleMarkers).toEqual([MARKER_A, MARKER_A]);
    expect(mainWorldConsoleCalls).toBe(0);
    listeners.get("wheel")?.({ isTrusted: true });
    expect(callbacks.size).toBeGreaterThan(0);
    const cleanup = isolatedGlobal["__recordlyCleanup_session-001"];
    if (typeof cleanup !== "function") throw new Error("missing isolated cleanup");
    cleanup();
    expect(callbacks).toHaveLength(0);
    expect(listeners).toHaveLength(0);
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 999,
      payload: observedEnvelope(NONCE_STALE, {
        type: "click",
        data: { x: 999, y: 999, button: 0 },
      }),
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(requests.some((request) => request.path === "/observed-event")).toBe(false);
    for (let index = 0; index < 10_000; index += 1) {
      session.emit("Runtime.consoleAPICalled", {
        type: "debug",
        args: [
          { type: "string", value: `unmatched-marker-${index}` },
          { type: "string", value: "{}" },
        ],
        executionContextId: 1,
      });
    }
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(requests.some((request) => request.path === "/observed-event")).toBe(false);
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 41,
      payload: observedEnvelope(NONCE_A, {
        type: "click",
        data: { x: 10, y: 20, button: 0 },
      }),
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const observed = requests.find((request) => request.path === "/observed-event");
    expect(observed).toMatchObject({
      headers: { "x-recordly-capability": "runtime-only-token" },
      data: {
        sessionId: "session-001",
        origin: "https://recordly.dev",
        event: { type: "click", data: { x: 10, y: 20, button: 0 } },
      },
    });
    expect(JSON.stringify(observed?.data)).not.toContain("private");
    expect(JSON.stringify(observed?.data)).not.toContain("runtime-only-token");
    expect(JSON.stringify(observed?.data)).not.toContain(input.bindingName);
    expect(JSON.stringify(observed?.data)).not.toContain(NONCE_A);
    expect(JSON.stringify(page[`__recordlyCapture_${input.sessionId}`])).not.toContain(
      input.bindingName,
    );

    destroyOldContextDuringCleanup = true;
    session.emit("Page.frameNavigated", {
      frame: {
        id: "main-frame-after-navigation",
        loaderId: "loader-after-navigation",
        url: "https://recordly.dev/after-navigation",
        securityOrigin: "https://recordly.dev",
      },
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const cleanupIndex = calls.findIndex(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params?.contextId === 41 &&
        typeof call.params.expression === "string" &&
        call.params.expression.includes("const cleanup ="),
    );
    const rebindIndex = calls.findIndex(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params?.contextId === 42 &&
        typeof call.params.expression === "string" &&
        call.params.expression.includes("settleWheel"),
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(rebindIndex).toBeGreaterThan(cleanupIndex);
    session.emit("Runtime.consoleAPICalled", {
      type: "debug",
      args: [
        { type: "string", value: MARKER_A },
        {
          type: "string",
          value: observedEnvelope(NONCE_A, {
            type: "click",
            data: { x: 70, y: 80, button: 0 },
          }),
        },
      ],
      executionContextId: 41,
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(1);

    holdObserved = true;
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 42,
      payload: observedEnvelope(NONCE_B, {
        type: "scroll",
        data: { x: 0, y: 720, deltaX: 0, deltaY: 720 },
      }),
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const stopping = stop(page);
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(requests.some((request) => request.path === "/stop")).toBe(false);
    observedGate.resolve();
    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    expect(calls.some((call) => call.method === "Runtime.removeBinding")).toBe(false);
    session.emit("Runtime.bindingCalled", {
      name: input.bindingName,
      executionContextId: 42,
      payload: observedEnvelope(NONCE_B, {
        type: "click",
        data: { x: 11, y: 22, button: 0 },
      }),
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(requests.filter((request) => request.path === "/observed-event")).toHaveLength(2);
    expect(pageListeners.get("load")?.size ?? 0).toBe(0);
  });
});
