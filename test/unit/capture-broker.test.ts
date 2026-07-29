import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCaptureBroker } from "../../mcp/capture-broker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function broker(
  input: {
    clockUs?: () => number;
    maxCaptureSeconds?: number;
    maxAcceptedFrames?: number;
    maxAcceptedBytes?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "recordly-codex-broker-"));
  roots.push(root);
  const phases: string[] = [];
  const instance = await createCaptureBroker({
    sessionId: "session-001",
    root,
    origin: "https://recordly.dev",
    ...(input.clockUs === undefined ? {} : { clockUs: input.clockUs }),
    ...(input.maxCaptureSeconds === undefined
      ? {}
      : { maxCaptureSeconds: input.maxCaptureSeconds }),
    ...(input.maxAcceptedFrames === undefined
      ? {}
      : { maxAcceptedFrames: input.maxAcceptedFrames }),
    ...(input.maxAcceptedBytes === undefined ? {} : { maxAcceptedBytes: input.maxAcceptedBytes }),
    onPhase: async (phase) => {
      phases.push(phase);
    },
  });
  const post = async (path: string, data: unknown, token?: string) =>
    fetch(`${instance.endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { "x-recordly-capability": token }),
      },
      body: JSON.stringify(data),
    });
  return { root, phases, instance, post };
}

const identity = { sessionId: "session-001", url: "https://recordly.dev/" };
const observedIdentity = { sessionId: "session-001", origin: "https://recordly.dev" };

function framePayload(sessionId: number) {
  return {
    ...identity,
    frame: {
      data: Buffer.from(`safe frame ${sessionId}`).toString("base64"),
      sessionId,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    },
  };
}

describe("loopback capture broker", () => {
  it("issues bounded fresh observer challenges only after a durable baseline without persisting markers", async () => {
    const { root, phases, instance, post } = await broker();
    const logs = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    try {
      const challenge = (
        documentEpoch: unknown,
        token?: string,
        documentUrl = "https://recordly.dev/workflows/approved?view=recording#capture",
      ) => post("/observer-challenge", { ...observedIdentity, documentEpoch, documentUrl }, token);

      expect((await challenge(1)).status).toBe(403);
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      expect((await challenge(1, "wrong")).status).toBe(403);
      expect(
        (
          await post(
            "/observer-challenge",
            {
              ...observedIdentity,
              sessionId: "other",
              documentEpoch: 1,
              documentUrl: "https://recordly.dev/approved",
            },
            token,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            "/observer-challenge",
            {
              ...observedIdentity,
              origin: "https://other.example",
              documentEpoch: 1,
              documentUrl: "https://recordly.dev/approved",
            },
            token,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            "/observer-challenge",
            {
              ...observedIdentity,
              documentEpoch: 1,
              documentUrl: "https://recordly.dev/approved",
              extra: true,
            },
            token,
          )
        ).status,
      ).toBe(400);
      expect((await challenge(1.5, token)).status).toBe(400);
      expect((await challenge(1, token)).status).toBe(409);
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });

      const markers: string[] = [];
      const approved = await challenge(1, token);
      expect(approved.status).toBe(200);
      const approvedResult = (await approved.json()) as { ok: boolean; marker: string };
      expect(approvedResult.marker).toMatch(/^[0-9a-f]{64}$/u);
      markers.push(approvedResult.marker);

      for (const documentUrl of [
        "https://other.example/workflow",
        "https://user:pass@recordly.dev/workflow",
        "javascript:alert(1)",
        "about:blank",
        "data:text/html,recordly",
        "not a URL",
      ]) {
        const rejected = await challenge(2, token, documentUrl);
        expect(rejected.status).toBe(documentUrl.startsWith("https://other.example") ? 403 : 400);
        expect(await rejected.json()).toEqual({ ok: false });
      }

      for (const documentEpoch of Array.from({ length: 31 }, (_, index) => index + 2)) {
        const response = await challenge(documentEpoch, token);
        expect(response.status).toBe(200);
        const result = (await response.json()) as { ok: boolean; marker: string };
        expect(result.ok).toBe(true);
        expect(result.marker).toMatch(/^[0-9a-f]{64}$/u);
        markers.push(result.marker);
      }
      expect(new Set(markers)).toHaveLength(32);
      expect((await challenge(33, token)).status).toBe(429);
      expect(phases.at(-1)).toBe("failed");
      expect((await challenge(34, token)).status).toBe(409);

      await expect(
        post(
          "/stop",
          {
            ...identity,
            receivedFrames: 1,
            acceptedFrames: 1,
            ackedFrames: 1,
            rejectedFrames: 0,
            degradationRequested: false,
          },
          token,
        ),
      ).resolves.toMatchObject({ status: 200 });
      const evidence = await Promise.all([
        readFile(join(root, "capture-summary.json"), "utf8"),
        readFile(join(root, "capture-events.jsonl"), "utf8"),
        readFile(join(root, "observed-events.jsonl"), "utf8"),
      ]);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
      for (const marker of markers) expect(evidence.join("\n")).not.toContain(marker);
    } finally {
      for (const log of logs) log.mockRestore();
      await instance.close();
    }
  });

  it("rejects observed events before a durable baseline frame, then aligns later events", async () => {
    const samples = [100, 200, 300, 400, 450, 500];
    const { phases, instance, post } = await broker({ clockUs: () => samples.shift() ?? 300 });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await expect(
        post(
          "/observed-event",
          {
            ...observedIdentity,
            event: { type: "click", data: { x: 10, y: 20, button: 0 } },
          },
          token,
        ),
      ).resolves.toMatchObject({ status: 409 });
      expect(phases.at(-1)).toBe("failed");
    } finally {
      await instance.close();
    }

    const aligned = await broker({ clockUs: () => samples.shift() ?? 300 });
    try {
      const claim = await aligned.post("/claim", identity);
      const alignedToken = ((await claim.json()) as { token: string }).token;
      await expect(aligned.post("/frame", framePayload(1), alignedToken)).resolves.toMatchObject({
        status: 200,
      });
      await expect(
        aligned.post(
          "/observed-event",
          {
            ...observedIdentity,
            event: { type: "click", data: { x: 10, y: 20, button: 0 } },
          },
          alignedToken,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(aligned.post("/frame", framePayload(2), alignedToken)).resolves.toMatchObject({
        status: 200,
      });

      const frames = (await readFile(join(aligned.root, "capture-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { receiptOffsetUs: number });
      const observedEvents = (await readFile(join(aligned.root, "observed-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(frames.map((event) => event.receiptOffsetUs)).toEqual([0, 100]);
      expect(observedEvents).toEqual([
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 1,
          type: "click",
          receiptOffsetUs: 50,
          data: { x: 10, y: 20, button: 0 },
        },
      ]);
      expect((await lstat(join(aligned.root, "observed-events.jsonl"))).mode & 0o777).toBe(0o600);
    } finally {
      await aligned.instance.close();
    }
  });

  it("coalesces bounded scroll observations and fails closed for malformed or flooding pages", async () => {
    const samples = Array.from({ length: 140 }, (_, index) => 1_000 + index);
    const { root, phases, instance, post } = await broker({
      clockUs: () => samples.shift() ?? 2_000,
    });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });
      for (const event of [
        { type: "scroll", data: { x: 0, y: 100, deltaX: 0, deltaY: 100 } },
        { type: "scroll", data: { x: 0, y: 180, deltaX: 0, deltaY: 80 } },
      ]) {
        await expect(
          post("/observed-event", { ...observedIdentity, event }, token),
        ).resolves.toMatchObject({ status: 200 });
      }
      await expect(post("/frame", framePayload(2), token)).resolves.toMatchObject({ status: 200 });
      const scroll = JSON.parse(
        (await readFile(join(root, "observed-events.jsonl"), "utf8")).trim(),
      ) as Record<string, unknown>;
      expect(scroll).toMatchObject({
        seq: 1,
        type: "scroll",
        data: { x: 0, y: 180, deltaX: 0, deltaY: 180 },
      });
      const malformed = await post(
        "/observed-event",
        {
          ...observedIdentity,
          event: { type: "click", data: { x: 1_000_001, y: 0, button: 0 } },
        },
        token,
      );
      expect(malformed.status).toBe(400);
      expect(phases.at(-1)).toBe("failed");
    } finally {
      await instance.close();
    }
  });

  it("coalesces privacy-bounded pointer observations and drains the final sample on stop", async () => {
    const samples = [1_000, 1_010, 1_020, 1_030];
    const { root, phases, instance, post } = await broker({
      clockUs: () => samples.shift() ?? 1_040,
    });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });
      for (const event of [
        { type: "pointer", data: { x: 10, y: 20, buttons: 0, cursor: "default" } },
        { type: "pointer", data: { x: 40, y: 60, buttons: 1, cursor: "pressed" } },
      ]) {
        await expect(
          post("/observed-event", { ...observedIdentity, event }, token),
        ).resolves.toMatchObject({
          status: 200,
        });
      }
      await expect(
        post(
          "/stop",
          {
            ...identity,
            receivedFrames: 1,
            acceptedFrames: 1,
            ackedFrames: 1,
            rejectedFrames: 0,
            degradationRequested: false,
          },
          token,
        ),
      ).resolves.toMatchObject({ status: 200, statusText: "OK" });
      const events = (await readFile(join(root, "observed-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toEqual([
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 1,
          type: "pointer",
          receiptOffsetUs: 20,
          data: { x: 40, y: 60, buttons: 1, cursor: "pressed" },
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/selector|text|url|cookie|storage|style/i);

      expect(phases.at(-1)).toBe("stopped");
    } finally {
      await instance.close();
    }
  });

  it("fails closed for malformed pointer state and pointer floods", async () => {
    let sample = 5_000;
    const { phases, instance, post } = await broker({ clockUs: () => sample++ });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });
      const malformed = await post(
        "/observed-event",
        {
          ...observedIdentity,
          event: {
            type: "pointer",
            data: { x: 1, y: 2, buttons: 0, cursor: "url(https://attacker.example/cursor)" },
          },
        },
        token,
      );
      expect(malformed.status).toBe(400);
      expect(phases.at(-1)).toBe("failed");
    } finally {
      await instance.close();
    }

    let floodSample = 8_000;
    const flooded = await broker({ clockUs: () => floodSample++ });
    try {
      const claim = await flooded.post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await flooded.post("/frame", framePayload(1), token);
      const pointer = {
        ...observedIdentity,
        event: { type: "pointer", data: { x: 1, y: 2, buttons: 0, cursor: "default" } },
      };
      for (let index = 0; index < 120; index += 1) {
        expect((await flooded.post("/observed-event", pointer, token)).status).toBe(200);
      }
      expect((await flooded.post("/observed-event", pointer, token)).status).toBe(429);
      expect(flooded.phases.at(-1)).toBe("failed");
    } finally {
      await flooded.instance.close();
    }
  });

  it("fails closed when observed-event rate exceeds the bounded broker window", async () => {
    let sample = 5_000;
    const { phases, instance, post } = await broker({ clockUs: () => sample++ });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });
      const click = {
        ...observedIdentity,
        event: { type: "click", data: { x: 1, y: 2, button: 0 } },
      };
      for (let index = 0; index < 120; index += 1) {
        expect((await post("/observed-event", click, token)).status).toBe(200);
      }
      expect((await post("/observed-event", click, token)).status).toBe(429);
      expect(phases.at(-1)).toBe("failed");
    } finally {
      await instance.close();
    }
  });

  it("rejects a zero-delta scroll as a non-action", async () => {
    const { phases, instance, post } = await broker();
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });
      const response = await post(
        "/observed-event",
        {
          ...observedIdentity,
          event: { type: "scroll", data: { x: 0, y: 0, deltaX: 0, deltaY: 0 } },
        },
        token,
      );
      expect(response.status).toBe(400);
      expect(phases.at(-1)).toBe("failed");
    } finally {
      await instance.close();
    }
  });

  it("rejects observed-event identity/auth/body abuse and symlinked persistence", async () => {
    const { root, instance, post } = await broker();
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      const click = {
        ...observedIdentity,
        event: { type: "click", data: { x: 1, y: 2, button: 0 } },
      };
      expect((await post("/observed-event", click)).status).toBe(403);
      expect((await post("/observed-event", click, "wrong")).status).toBe(403);
      expect(
        (await post("/observed-event", { ...click, origin: "https://other.example" }, token))
          .status,
      ).toBe(403);
      const oversized = await post(
        "/observed-event",
        { ...click, padding: "x".repeat(5_000) },
        token,
      );
      expect(oversized.status).toBe(413);

      const observedPath = join(root, "observed-events.jsonl");
      const outside = join(root, "outside.jsonl");
      await writeFile(outside, "outside\n", { mode: 0o600 });
      await rm(observedPath);
      await symlink(outside, observedPath);
      await expect(post("/frame", framePayload(1), token)).resolves.toMatchObject({ status: 200 });
      expect((await post("/observed-event", click, token)).status).toBe(500);
      expect(await readFile(outside, "utf8")).toBe("outside\n");
    } finally {
      await instance.close();
    }
  });

  it("persists strictly monotonic receipt offsets from the broker clock, never page timing", async () => {
    const samples = [2_000, 2_000, 1_999];
    const { root, instance, post } = await broker({ clockUs: () => samples.shift() ?? 1_999 });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      for (const sessionId of [1, 2, 3]) {
        const response = await post(
          "/frame",
          {
            ...identity,
            frame: {
              data: Buffer.from(`safe frame ${sessionId}`).toString("base64"),
              sessionId,
              metadata: { deviceWidth: 1440, deviceHeight: 900 },
            },
          },
          token,
        );
        expect(response.status).toBe(200);
      }
      const events = (await readFile(join(root, "capture-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { receiptOffsetUs: unknown; receivedAtUs?: unknown });
      expect(events.map((event) => event.receiptOffsetUs)).toEqual([0, 1, 2]);
      expect(events.every((event) => !("receivedAtUs" in event))).toBe(true);
    } finally {
      await instance.close();
    }
  });

  it("fails closed when the local receipt clock is invalid", async () => {
    const samples = [100, -1];
    const { phases, root, instance, post } = await broker({
      clockUs: () => samples.shift() ?? -1,
    });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      const response = await post(
        "/frame",
        {
          ...identity,
          frame: {
            data: Buffer.from("safe frame").toString("base64"),
            sessionId: 1,
            metadata: { deviceWidth: 1440, deviceHeight: 900 },
          },
        },
        token,
      );
      expect(response.status).toBe(500);
      expect(phases).toEqual(["claimed", "failed"]);
      await expect(readFile(join(root, "capture-events.jsonl"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await instance.close();
    }
  });

  it("accepts only a token-authorized matching-origin session and atomically persists evidence", async () => {
    const { root, phases, instance, post } = await broker();
    try {
      const claim = await post("/claim", identity);
      expect(claim.status).toBe(200);
      const token = ((await claim.json()) as { token: string }).token;
      expect(token).toMatch(/^[0-9a-f]{64}$/u);
      const frame = {
        ...identity,
        frame: {
          data: Buffer.from("safe frame").toString("base64"),
          sessionId: 1,
          metadata: { deviceWidth: 1440, deviceHeight: 900 },
        },
      };
      await expect(post("/frame", frame, token)).resolves.toMatchObject({ status: 200 });
      const stopped = await post(
        "/stop",
        {
          ...identity,
          receivedFrames: 1,
          acceptedFrames: 1,
          ackedFrames: 1,
          rejectedFrames: 0,
          degradationRequested: false,
        },
        token,
      );
      expect(stopped.status).toBe(200);
      expect(phases).toEqual(["claimed", "running", "stopped"]);
      expect(await readFile(join(root, "frames", "raw", "frame-000001.jpg"), "utf8")).toBe(
        "safe frame",
      );
      expect(JSON.parse(await readFile(join(root, "capture-summary.json"), "utf8"))).toMatchObject({
        status: "stopped",
        acceptedFrames: 1,
        ackedFrames: 1,
      });
      const persistedEvidence = await Promise.all([
        readFile(join(root, "capture-summary.json"), "utf8"),
        readFile(join(root, "capture-events.jsonl"), "utf8"),
      ]);
      expect(persistedEvidence.join("\n")).not.toContain(token);
    } finally {
      await instance.close();
    }
  });

  it("rejects claim replay, pre-claim calls, wrong identity, and oversized bodies", async () => {
    const { instance, post } = await broker();
    try {
      expect((await post("/frame", { ...identity, frame: {} })).status).toBe(403);
      expect((await post("/stop", identity)).status).toBe(403);
      expect((await post("/claim", { ...identity, sessionId: "other" })).status).toBe(400);
      expect((await post("/claim", { ...identity, url: "https://other.example" })).status).toBe(
        403,
      );
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      expect((await post("/claim", identity)).status).toBe(409);
      expect((await post("/frame", { ...identity, frame: {} }, "wrong")).status).toBe(403);
      const declared = await fetch(`${instance.endpoint}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...identity, padding: "x".repeat(9 * 1024 * 1024) }),
      });
      expect(declared.status).toBe(413);
      const streamed = await fetch(`${instance.endpoint}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: Readable.from(["x".repeat(8 * 1024 * 1024 + 1)]),
        duplex: "half",
      });
      expect(streamed.status).toBe(413);
      const stopped = await post(
        "/stop",
        {
          ...identity,
          receivedFrames: 0,
          acceptedFrames: 0,
          ackedFrames: 0,
          rejectedFrames: 0,
          degradationRequested: false,
        },
        token,
      );
      expect(stopped.status).toBe(200);
      expect((await post("/claim", identity)).status).toBe(409);
    } finally {
      await instance.close();
    }
  });

  it("fails closed with a persisted budget_exceeded summary before accepting over-budget frames", async () => {
    const samples = [1_000, 1_000, 2_000_001];
    const { root, phases, instance, post } = await broker({
      clockUs: () => samples.shift() ?? 2_000_001,
      maxCaptureSeconds: 1,
      maxAcceptedFrames: 1,
      maxAcceptedBytes: 64,
    });
    try {
      const claim = await post("/claim", identity);
      const token = ((await claim.json()) as { token: string }).token;
      expect((await post("/frame", framePayload(1), token)).status).toBe(200);
      expect((await post("/frame", framePayload(2), token)).status).toBe(429);
      expect(phases.at(-1)).toBe("failed");
      expect(JSON.parse(await readFile(join(root, "capture-summary.json"), "utf8"))).toMatchObject({
        status: "failed",
        reason: "budget_exceeded",
        acceptedFrames: 1,
      });
      expect(instance.status()).toMatchObject({
        phase: "failed",
        reason: "budget_exceeded",
        acceptedFrames: 1,
      });
      expect((await post("/frame", framePayload(3), token)).status).toBe(429);
    } finally {
      await instance.close();
    }
  });

  it("expires a claimed capture before its first frame when the broker-owned deadline passes", async () => {
    const samples = [1_000, 1_001_001];
    const { root, instance, post } = await broker({
      clockUs: () => samples.shift() ?? 1_001_001,
      maxCaptureSeconds: 1,
    });
    try {
      const token = (
        (await post("/claim", identity).then((response) => response.json())) as {
          token: string;
        }
      ).token;
      expect((await post("/frame", framePayload(1), token)).status).toBe(429);
      expect(JSON.parse(await readFile(join(root, "capture-summary.json"), "utf8"))).toMatchObject({
        status: "failed",
        reason: "budget_exceeded",
        acceptedFrames: 0,
      });
    } finally {
      await instance.close();
    }
  });

  it("rejects stop after the broker-owned deadline even when no later frame arrives", async () => {
    const samples = [1_000, 1_100, 1_001_101];
    const { root, instance, post } = await broker({
      clockUs: () => samples.shift() ?? 1_001_101,
      maxCaptureSeconds: 1,
    });
    try {
      const token = (
        (await post("/claim", identity).then((response) => response.json())) as {
          token: string;
        }
      ).token;
      expect((await post("/frame", framePayload(1), token)).status).toBe(200);
      const stopped = await post(
        "/stop",
        {
          ...identity,
          receivedFrames: 1,
          acceptedFrames: 1,
          ackedFrames: 1,
          rejectedFrames: 0,
          degradationRequested: false,
        },
        token,
      );
      expect(stopped.status).toBe(429);
      expect(JSON.parse(await readFile(join(root, "capture-summary.json"), "utf8"))).toMatchObject({
        status: "failed",
        reason: "budget_exceeded",
        acceptedFrames: 1,
      });
      expect(instance.status()).toMatchObject({
        phase: "failed",
        reason: "budget_exceeded",
        acceptedFrames: 1,
      });
    } finally {
      await instance.close();
    }
  });

  it("enforces receipt-time and accepted-byte budgets independently of the frame cap", async () => {
    const timed = await broker({
      clockUs: (() => {
        const values = [1_000, 1_001, 1_001_001];
        return () => values.shift() ?? 1_001_001;
      })(),
      maxCaptureSeconds: 1,
      maxAcceptedFrames: 4,
      maxAcceptedBytes: 1_000,
    });
    try {
      const token = (
        (await timed.post("/claim", identity).then((response) => response.json())) as {
          token: string;
        }
      ).token;
      expect((await timed.post("/frame", framePayload(1), token)).status).toBe(200);
      expect((await timed.post("/frame", framePayload(2), token)).status).toBe(429);
      expect(
        JSON.parse(await readFile(join(timed.root, "capture-summary.json"), "utf8")),
      ).toMatchObject({
        reason: "budget_exceeded",
        acceptedFrames: 1,
      });
    } finally {
      await timed.instance.close();
    }

    const byteBounded = await broker({ maxAcceptedFrames: 4, maxAcceptedBytes: 1 });
    try {
      const token = (
        (await byteBounded.post("/claim", identity).then((response) => response.json())) as {
          token: string;
        }
      ).token;
      expect((await byteBounded.post("/frame", framePayload(1), token)).status).toBe(429);
      expect(
        JSON.parse(await readFile(join(byteBounded.root, "capture-summary.json"), "utf8")),
      ).toMatchObject({ reason: "budget_exceeded", acceptedFrames: 0 });
    } finally {
      await byteBounded.instance.close();
    }
  });

  it("fails closed when concurrent frame submissions race a capture budget", async () => {
    const { root, instance, post } = await broker({ maxAcceptedFrames: 1 });
    try {
      const token = (
        (await post("/claim", identity).then((response) => response.json())) as {
          token: string;
        }
      ).token;
      const responses = await Promise.all(
        [1, 2].map((sequence) => post("/frame", framePayload(sequence), token)),
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
      expect(JSON.parse(await readFile(join(root, "capture-summary.json"), "utf8"))).toMatchObject({
        status: "failed",
        reason: "budget_exceeded",
        acceptedFrames: 1,
      });
    } finally {
      await instance.close();
    }
  });
});
