import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createCaptureBroker } from "../../mcp/capture-broker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function broker(clockUs?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "recordly-codex-broker-"));
  roots.push(root);
  const phases: string[] = [];
  const instance = await createCaptureBroker({
    sessionId: "session-001",
    root,
    origin: "https://recordly.dev",
    ...(clockUs === undefined ? {} : { clockUs }),
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

describe("loopback capture broker", () => {
  it("persists strictly monotonic receipt offsets from the broker clock, never page timing", async () => {
    const samples = [2_000, 2_000, 1_999];
    const { root, instance, post } = await broker(() => samples.shift() ?? 1_999);
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
    const { phases, root, instance, post } = await broker(() => -1);
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
});
