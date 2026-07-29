import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { createSessionStoreService } from "../../mcp/session-store-service.js";
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

async function makeFrame(path: string, interior: "black" | "white"): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${interior}:s=320x180`,
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=12:c=red:t=fill,drawbox=x=iw-12:y=0:w=12:h=ih:c=green:t=fill,drawbox=x=0:y=ih-12:w=iw:h=12:c=blue:t=fill,drawbox=x=0:y=0:w=12:h=ih:c=yellow:t=fill",
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
    noObservedAction?: boolean;
    noVisibleResult?: boolean;
    lateAction?: boolean;
    observedType?: "click" | "scroll";
    observedPointer?: boolean;
    plannedTelemetry?: boolean;
    ownerToken?: string;
  } = {},
): Promise<{ artifactRoot: string; sessionId: string; sessionRoot: string }> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-sealed-render-"));
  roots.push(artifactRoot);
  const sessionId = "session-render-001";
  const sessionRoot = join(artifactRoot, sessionId);
  const frameRoot = join(sessionRoot, "frames", "raw");
  await mkdir(frameRoot, { recursive: true, mode: 0o700 });
  const beforePath = join(frameRoot, "fixture-before.jpg");
  const afterPath = join(frameRoot, "fixture-after.jpg");
  await makeFrame(beforePath, "black");
  await makeFrame(afterPath, options.noVisibleResult ? "black" : "white");
  const frameCount = 24;
  for (let index = 0; index < frameCount; index += 1) {
    await copyFile(
      index < 9 ? beforePath : afterPath,
      join(frameRoot, `frame-${String(index + 1).padStart(6, "0")}.jpg`),
    );
    await chmod(join(frameRoot, `frame-${String(index + 1).padStart(6, "0")}.jpg`), 0o600);
  }
  const state = options.state ?? "sealed";
  await writeFile(
    join(sessionRoot, "session.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      ownerToken: options.ownerToken ?? "test-owner",
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
      receivedFrames: frameCount,
      acceptedFrames: frameCount,
      ackedFrames: frameCount,
      rejectedFrames: 0,
      degradationRequested: false,
    })}\n`,
    { mode: 0o600 },
  );
  const lines: string[] = [];
  for (let index = 0; index < frameCount; index += 1) {
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
  if (!options.noObservedAction) {
    const type = options.observedType ?? "click";
    const observedEvents = [];
    if (options.observedPointer) {
      observedEvents.push({
        schemaVersion: 1,
        sessionId,
        seq: 1,
        type: "pointer",
        receiptOffsetUs: 100_000,
        data: { x: 120, y: 80, buttons: 0, cursor: "default" },
      });
    }
    observedEvents.push({
      schemaVersion: 1,
      sessionId,
      seq: options.observedPointer ? 2 : 1,
      type,
      receiptOffsetUs: options.lateAction ? 700_000 : 250_000,
      data:
        type === "click" ? { x: 160, y: 90, button: 0 } : { x: 0, y: 720, deltaX: 0, deltaY: 720 },
    });
    await writeFile(
      join(sessionRoot, "observed-events.jsonl"),
      `${observedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(sessionRoot, "telemetry.ndjson"),
    options.plannedTelemetry
      ? `${JSON.stringify({
          schemaVersion: 1,
          sessionId,
          seq: 0,
          tUs: 250_000,
          type: "pointer",
          data: { x: 160, y: 90, buttons: 0, source: "planned" },
        })}\n`
      : "",
    { mode: 0o600 },
  );
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
  it("accepts trusted pointer telemetry and exposes only presentation-safe cursor samples", async () => {
    const source = await fixture({ observedPointer: true });

    const rendered = await renderSealedSession(source);
    const manifest = JSON.parse(await readFile(rendered.manifestPath, "utf8"));

    expect(manifest.observedActions).toHaveLength(1);
    expect(manifest.cursorTrack).toEqual([{ x: 120, y: 80, state: "default", cfrFrameIndex: 3 }]);
    expect(JSON.stringify(manifest.cursorTrack)).not.toContain("receiptOffsetUs");
  }, 60_000);

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
    expect(JSON.stringify(manifest)).not.toContain("receiptOffsetUs");
    expect(manifest.timeline).toMatchObject({
      fps: 30,
      frameCount: 24,
      timingMode: "broker-receipt-offsets",
    });
    expect(manifest.observedActions).toEqual([{ type: "click", x: 160, y: 90, cfrFrameIndex: 7 }]);
    expect(manifest.render).toMatchObject({ pixelFormat: "yuv420p", colorRange: "tv" });
    expect(quality).toMatchObject({
      status: "approved",
      probe: {
        width: 1920,
        height: 1080,
        fps: 30,
        frameCount: 24,
        hasAudio: false,
        pixelFormat: "yuv420p",
        colorRange: "tv",
      },
      timing: { mode: "broker-receipt-offsets", eligibleForApproval: true },
      finalState: { present: true, sourceFrameId: 24 },
      actionAlignment: {
        status: "pass",
        visibleChangeThreshold: 0.02,
        finalHoldMinimumUs: 300000,
        events: [
          expect.objectContaining({
            type: "click",
            actionFrameIndex: 7,
            preFrameIndex: 7,
            resultFrameIndex: 9,
            visibleChange: expect.any(Number),
            finalHoldUs: 466667,
            status: "pass",
          }),
        ],
        proofScope: "temporal visible-result alignment; causal semantics are not asserted",
      },
      clipping: {
        status: "pass",
        borderPx: 12,
        expectedContentRect: { x: 90, y: 51, width: 1740, height: 978 },
        thresholds: {
          maxEdgeColorDelta: 0.18,
          maxCompositionColorDelta: 0.08,
          maxAspectError: 0.005,
        },
        samples: expect.arrayContaining([
          expect.objectContaining({ frameIndex: 0, edgesPresent: true }),
        ]),
      },
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
    [
      "planned telemetry without an observed action",
      { noObservedAction: true, plannedTelemetry: true },
    ],
    ["no decoded visible result", { noVisibleResult: true }],
    ["missing final-state hold", { lateAction: true }],
  ])(
    "blocks approval for %s",
    async (_label, options) => {
      const source = await fixture(options);

      const rendered = await renderSealedSession(source);
      const quality = JSON.parse(await readFile(rendered.qualityReportPath, "utf8"));

      expect(rendered.approved).toBe(false);
      expect(quality).toMatchObject({
        status: "blocked",
        actionAlignment: { status: "fail" },
      });
    },
    30_000,
  );

  it("aligns an observed scroll with nonzero delta and visible decoded result", async () => {
    const source = await fixture({ observedType: "scroll" });

    const rendered = await renderSealedSession(source);
    const manifest = JSON.parse(await readFile(rendered.manifestPath, "utf8"));

    expect(rendered.approved).toBe(true);
    expect(manifest.observedActions).toEqual([
      { type: "scroll", x: 0, y: 720, deltaX: 0, deltaY: 720, cfrFrameIndex: 7 },
    ]);
  }, 30_000);

  it("rejects observed action records outside the exact private schema", async () => {
    const source = await fixture({ observedType: "scroll" });
    const path = join(source.sessionRoot, "observed-events.jsonl");
    const event = JSON.parse((await readFile(path, "utf8")).trim()) as {
      data: Record<string, unknown> & { deltaY: number };
    };
    event.data.deltaY = 0;

    await writeFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });

    await expect(renderSealedSession(source)).rejects.toThrow(/nonzero/u);
  });

  it("shares the broker's 10,000-record observed persistence bound", async () => {
    const source = await fixture();
    const path = join(source.sessionRoot, "observed-events.jsonl");
    const line = (await readFile(path, "utf8")).trim();
    await writeFile(path, `${Array.from({ length: 10_001 }, () => line).join("\n")}\n`, {
      mode: 0o600,
    });

    await expect(renderSealedSession(source)).rejects.toThrow(/broker persistence bound/u);
  });

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

  it("rejects a frame whose ancestor directory is a symlink outside the verified session tree", async () => {
    const source = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "recordly-frame-escape-"));
    roots.push(outside);
    await copyFile(
      join(source.sessionRoot, "frames", "raw", "frame-000001.jpg"),
      join(outside, "frame-000001.jpg"),
    );
    await rm(join(source.sessionRoot, "frames"), { recursive: true, force: true });
    await symlink(outside, join(source.sessionRoot, "frames"));

    await expect(renderSealedSession(source)).rejects.toThrow(/ancestor.*non-symlink directory/u);
  });

  it("renders a real editable project through preview, revision, and final without recapturing", async () => {
    const ownerToken = "11111111-1111-4111-8111-111111111111";
    const source = await fixture({ ownerToken, observedPointer: true });
    const helperRoot = join(process.cwd(), ".playwright-mcp", "recordly-codex", source.sessionId);
    await mkdir(helperRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(source.sessionRoot, "capture-config.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-start.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-stop.mjs"), "export {};\n", { mode: 0o600 }),
    ]);
    await writeFile(join(source.artifactRoot, ".recordly-codex-owner-token"), `${ownerToken}\n`, {
      mode: 0o600,
    });
    try {
      const sealed = await renderSealedSession(source);
      const service = createSessionStoreService({ artifactRoot: source.artifactRoot });
      if (
        service.createProject === undefined ||
        service.reviseProject === undefined ||
        service.renderProject === undefined
      ) {
        throw new Error("project rendering service is unavailable");
      }
      const captureBefore = await readFile(join(source.sessionRoot, "capture-events.jsonl"));
      const created = await service.createProject({
        sessionId: source.sessionId,
        projectId: "service-flow",
      });
      expect(created.project.presentation.cursor.visible).toBe(true);
      const manifestPath = join(source.sessionRoot, "artifacts", "recording-manifest.json");
      const qualityPath = join(source.sessionRoot, "artifacts", "quality-report.json");
      const legacyManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      // biome-ignore lint/complexity/useLiteralKeys: Record index-signature test fixture.
      delete legacyManifest["cursorTrack"];
      const legacyManifestText = JSON.stringify(legacyManifest);
      const legacyQuality = JSON.parse(await readFile(qualityPath, "utf8")) as {
        artifactHashes: { manifestSha256: string };
      };
      legacyQuality.artifactHashes.manifestSha256 = createHash("sha256")
        .update(legacyManifestText)
        .digest("hex");
      await writeFile(manifestPath, legacyManifestText, { mode: 0o600 });
      await writeFile(qualityPath, JSON.stringify(legacyQuality), { mode: 0o600 });
      const sealedBefore = await Promise.all(
        sealed.artifactPaths.map(async (path) => ({
          path,
          content: await readFile(path),
          mtimeMs: (await lstat(path)).mtimeMs,
        })),
      );
      const secondProject = await service.createProject({
        sessionId: source.sessionId,
        projectId: "service-flow-second",
      });
      expect(secondProject.project.captureSources[0]?.sessionId).toBe(
        created.project.captureSources[0]?.sessionId,
      );
      expect(secondProject.project.presentation.cursor.visible).toBe(false);
      for (const artifact of sealedBefore) {
        expect(await readFile(artifact.path)).toEqual(artifact.content);
        expect((await lstat(artifact.path)).mtimeMs).toBe(artifact.mtimeMs);
      }
      await chmod(join(source.sessionRoot, "capture-events.jsonl"), 0o644);
      const preview = await service.renderProject({
        projectId: secondProject.project.projectId,
        revision: secondProject.project.revision,
        kind: "preview",
      });
      expect(preview.render).toMatchObject({ kind: "preview", format: "mp4" });
      await expect(
        service.renderProject({
          projectId: secondProject.project.projectId,
          revision: 99,
          kind: "preview",
        }),
      ).rejects.toThrow();
      const revised = await service.reviseProject({
        mode: "manual",
        project: {
          ...preview.project,
          revision: 1,
          output: { ...preview.project.output, format: "gif" },
          presentation: {
            ...preview.project.presentation,
            cursor: { ...preview.project.presentation.cursor, preset: "large" },
          },
        },
      });
      const secondPreview = await service.renderProject({
        projectId: revised.project.projectId,
        revision: revised.project.revision,
        kind: "preview",
      });
      const final = await service.renderProject({
        projectId: revised.project.projectId,
        revision: revised.project.revision,
        kind: "final",
      });
      for (const result of [preview, secondPreview, final]) {
        expect(result.render?.artifact).toMatch(
          /^projects\/renders\/service-flow-second-r\d+-(preview|final)\.(mp4|gif)$/u,
        );
        expect(result.render?.sha256).toMatch(/^[a-f0-9]{64}$/u);
        const path = join(source.artifactRoot, result.render?.artifact ?? "");
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
        expect(await sha256(path)).toBe(result.render?.sha256);
        await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          path,
          "-frames:v",
          "1",
          "-f",
          "null",
          "-",
        ]);
      }
      expect(preview.render?.format).toBe("mp4");
      expect(secondPreview.render?.format).toBe("gif");
      expect(final.render?.format).toBe("gif");
      expect(await readFile(join(source.sessionRoot, "capture-events.jsonl"))).toEqual(
        captureBefore,
      );
      expect((await lstat(join(source.sessionRoot, "capture-events.jsonl"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await rm(helperRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
