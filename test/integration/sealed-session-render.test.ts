import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { resolveMediaExecutable } from "../../src/encoder/ffmpeg.js";
import { renderSealedSession, SealedSessionRenderError } from "../../src/render/sealed-session.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
type MutableCaptureEvent = Record<string, unknown> & {
  width?: unknown;
  receiptOffsetUs?: unknown;
};

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function makeFrame(path: string, color: string): Promise<void> {
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

async function fixture(
  options: {
    state?: "active" | "sealed";
    timing?: "receipt" | "legacy";
    corruptHash?: boolean;
  } = {},
): Promise<{ artifactRoot: string; sessionId: string; sessionRoot: string }> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-sealed-render-"));
  roots.push(artifactRoot);
  const sessionId = "session-render-001";
  const sessionRoot = join(artifactRoot, sessionId);
  const frameRoot = join(sessionRoot, "frames", "raw");
  await mkdir(frameRoot, { recursive: true, mode: 0o700 });
  const colors = ["red", "green", "blue"];
  for (let index = 0; index < colors.length; index += 1) {
    await makeFrame(
      join(frameRoot, `frame-${String(index + 1).padStart(6, "0")}.jpg`),
      colors[index] as string,
    );
  }
  const state = options.state ?? "sealed";
  await writeFile(
    join(sessionRoot, "session.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      ownerToken: "test-owner",
      state,
      createdAtUs: 100,
      ...(state === "sealed" ? { sealedAtUs: 200 } : {}),
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(sessionRoot, "request.sanitized.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      requestId: "request-render-001",
      url: "https://demo.example/private/path",
      objective: "Show a sanitized workflow.",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
      policy: {
        allowPrivateOrigin: false,
        allowedOrigins: ["https://demo.example"],
        maxAttempts: 2,
      },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(sessionRoot, "capture-summary.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      origin: "https://demo.example",
      status: "stopped",
      receivedFrames: 3,
      acceptedFrames: 3,
      ackedFrames: 3,
      rejectedFrames: 0,
      degradationRequested: false,
    })}\n`,
    { mode: 0o600 },
  );
  const lines: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const frameId = index + 1;
    const imagePath = `frames/raw/frame-${String(frameId).padStart(6, "0")}.jpg`;
    const digest = await sha256(join(sessionRoot, imagePath));
    lines.push(
      JSON.stringify({
        sessionId,
        type: "frame",
        frameId,
        imagePath,
        sha256: options.corruptHash && index === 1 ? "0".repeat(64) : digest,
        width: 320,
        height: 180,
        ...(options.timing === "legacy" ? {} : { receiptOffsetUs: index * 33_333 }),
      }),
    );
  }
  await writeFile(join(sessionRoot, "capture-events.jsonl"), `${lines.join("\n")}\n`, {
    mode: 0o600,
  });
  await writeFile(join(sessionRoot, "telemetry.ndjson"), "", { mode: 0o600 });
  return { artifactRoot, sessionId, sessionRoot };
}

async function mutateCaptureEvent(
  sessionRoot: string,
  index: number,
  mutate: (event: MutableCaptureEvent) => void,
): Promise<void> {
  const path = join(sessionRoot, "capture-events.jsonl");
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const event = JSON.parse(lines[index] as string) as MutableCaptureEvent;
  mutate(event);
  lines[index] = JSON.stringify(event);
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sealed session renderer", () => {
  it("renders receipt-timed evidence to a private, quality-approved CFR delivery", async () => {
    const source = await fixture();

    const rendered = await renderSealedSession(source);
    const manifest = JSON.parse(await readFile(rendered.manifestPath, "utf8"));
    const quality = JSON.parse(await readFile(rendered.qualityReportPath, "utf8"));

    expect(rendered.artifactPaths).toEqual([
      rendered.videoPath,
      rendered.manifestPath,
      rendered.qualityReportPath,
    ]);
    expect(rendered.artifactPaths.every((path) => path.startsWith(`${source.sessionRoot}/`))).toBe(
      true,
    );
    expect(manifest.target).toEqual({ origin: "https://demo.example" });
    expect(JSON.stringify(manifest)).not.toContain("/private/path");
    expect(JSON.stringify(manifest)).not.toContain("frames/raw");
    expect(manifest.timeline).toMatchObject({
      fps: 30,
      frameCount: 3,
      timingMode: "broker-receipt-offsets",
    });
    expect(quality).toMatchObject({
      status: "approved",
      probe: {
        width: 1920,
        height: 1080,
        fps: 30,
        frameCount: 3,
        hasAudio: false,
        pixelFormat: "yuv420p",
      },
      timing: { mode: "broker-receipt-offsets", eligibleForApproval: true },
      finalState: { present: true, sourceFrameId: 3 },
    });
    const videoStat = await lstat(rendered.videoPath);
    expect(videoStat.size).toBeGreaterThan(0);
    expect(videoStat.mode & 0o777).toBe(0o600);
    expect(
      (await lstat(join(source.sessionRoot, "artifacts", "qa", "opening.ppm"))).mode & 0o777,
    ).toBe(0o600);
  }, 30_000);

  it("renders missing legacy timestamps only as a non-approved candidate", async () => {
    const source = await fixture({ timing: "legacy" });

    const rendered = await renderSealedSession(source);
    const quality = JSON.parse(await readFile(rendered.qualityReportPath, "utf8"));

    expect(quality).toMatchObject({
      status: "candidate",
      timing: { mode: "legacy_ordered_cfr", eligibleForApproval: false },
    });
  }, 30_000);

  it.each([
    ["unsealed evidence", { state: "active" as const }, /sealed/u],
    ["hash mismatch", { corruptHash: true }, /hash/u],
  ])("fails closed for %s", async (_label, options, expected) => {
    const source = await fixture(options);

    await expect(renderSealedSession(source)).rejects.toThrow(expected);
    await expect(
      lstat(join(source.sessionRoot, "artifacts", "recording.mp4")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "mixed geometry",
      (event: MutableCaptureEvent) => {
        event.width = 319;
      },
      /geometry/u,
    ],
    [
      "partial receipt timing",
      (event: MutableCaptureEvent) => {
        delete event.receiptOffsetUs;
      },
      /receipt timing/u,
    ],
    [
      "non-monotonic receipt timing",
      (event: MutableCaptureEvent) => {
        event.receiptOffsetUs = 0;
      },
      /strictly increasing/u,
    ],
  ])("fails closed for %s", async (_label, mutate, expected) => {
    const source = await fixture();
    await mutateCaptureEvent(source.sessionRoot, 1, mutate);

    await expect(renderSealedSession(source)).rejects.toThrow(expected);
  });

  it("rejects a session path outside the supplied artifact root", async () => {
    const source = await fixture();

    await expect(
      renderSealedSession({ artifactRoot: source.sessionRoot, sessionId: ".." }),
    ).rejects.toBeInstanceOf(SealedSessionRenderError);
  });
});
