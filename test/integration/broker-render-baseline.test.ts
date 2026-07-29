import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createCaptureBroker } from "../../mcp/capture-broker.js";
import { resolveMediaExecutable } from "../../src/encoder/ffmpeg.js";
import { renderSealedSession } from "../../src/render/sealed-session.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function jpeg(path: string, color: "black" | "white"): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x180`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    path,
  ]);
}

describe("broker-to-renderer baseline evidence", () => {
  it("persists observed action evidence only after a durable baseline and renders it on the broker clock", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-broker-render-"));
    roots.push(artifactRoot);
    const sessionId = "broker-render-001";
    const sessionRoot = join(artifactRoot, sessionId);
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(sessionRoot, "session.json"),
      `${JSON.stringify({ schemaVersion: 1, sessionId, ownerToken: "test-owner", state: "sealed", createdAtUs: 1, sealedAtUs: 2 })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(sessionRoot, "request.sanitized.json"),
      `${JSON.stringify({ schemaVersion: 1, requestId: "request-001", url: "https://demo.example/workflow", objective: "Render broker evidence", viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, output: { width: 1920, height: 1080, fps: 30, format: "mp4" }, policy: { allowPrivateOrigin: false, allowedOrigins: ["https://demo.example"], maxAttempts: 2 } })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(sessionRoot, "telemetry.ndjson"), "", { mode: 0o600 });

    const first = join(sessionRoot, "first.jpg");
    const second = join(sessionRoot, "second.jpg");
    await jpeg(first, "black");
    await jpeg(second, "white");
    const bytes = await Promise.all([first, second].map(async (path) => readFile(path)));
    const samples = [1_000, 101_000, 334_333, 667_666];
    const broker = await createCaptureBroker({
      sessionId,
      root: sessionRoot,
      origin: "https://demo.example",
      clockUs: () => samples.shift() ?? 667_666,
      onPhase: async () => undefined,
    });
    try {
      const post = async (path: string, data: unknown, token?: string) =>
        fetch(`${broker.endpoint}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === undefined ? {} : { "x-recordly-capability": token }),
          },
          body: JSON.stringify(data),
        });
      const identity = { sessionId, url: "https://demo.example/workflow" };
      const token = ((await (await post("/claim", identity)).json()) as { token: string }).token;
      const frame = (data: Buffer, id: number) => ({
        ...identity,
        frame: {
          data: data.toString("base64"),
          sessionId: id,
          metadata: { deviceWidth: 320, deviceHeight: 180 },
        },
      });
      await expect(post("/frame", frame(bytes[0] as Buffer, 1), token)).resolves.toMatchObject({
        status: 200,
      });
      await expect(
        post(
          "/observed-event",
          {
            sessionId,
            origin: "https://demo.example",
            event: { type: "click", data: { x: 160, y: 90, button: 0 } },
          },
          token,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(post("/frame", frame(bytes[1] as Buffer, 2), token)).resolves.toMatchObject({
        status: 200,
      });
      await expect(post("/frame", frame(bytes[1] as Buffer, 3), token)).resolves.toMatchObject({
        status: 200,
      });
      await expect(
        post(
          "/stop",
          {
            ...identity,
            receivedFrames: 3,
            acceptedFrames: 3,
            ackedFrames: 3,
            rejectedFrames: 0,
            degradationRequested: false,
          },
          token,
        ),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await broker.close();
    }

    const rendered = await renderSealedSession({ artifactRoot, sessionId });
    expect(rendered.timingMode).toBe("broker-receipt-offsets");
    expect(rendered.artifactPaths).toHaveLength(3);
  }, 30_000);
});
