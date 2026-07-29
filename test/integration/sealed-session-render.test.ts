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
import { parsePpm } from "../support/ppm.js";

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

async function makeFrame(
  path: string,
  interior: "black" | "white",
  options: { dimensions?: "320x180" | "947x900"; thinRightScrollbar?: boolean } = {},
): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  const dimensions = options.dimensions ?? "320x180";
  const scrollbar = options.thinRightScrollbar ? ",drawbox=x=iw-3:y=0:w=3:h=ih:c=white:t=fill" : "";
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${interior}:s=${dimensions}`,
    "-vf",
    `drawbox=x=0:y=0:w=iw:h=12:c=red:t=fill,drawbox=x=iw-12:y=0:w=12:h=ih:c=green:t=fill,drawbox=x=0:y=ih-12:w=iw:h=12:c=blue:t=fill,drawbox=x=0:y=0:w=12:h=ih:c=yellow:t=fill${scrollbar}`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    path,
  ]);
}

async function makeTemporalVisual(path: string, first: string, second: string): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${first}:s=64x32:r=30:d=0.4`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${second}:s=64x32:r=30:d=0.4`,
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    path,
  ]);
}

async function makeImportAudio(path: string): Promise<void> {
  const codec = path.endsWith(".mp3") ? "libmp3lame" : path.endsWith(".m4a") ? "aac" : "pcm_s16le";
  await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=0.4",
    "-c:a",
    codec,
    "-y",
    path,
  ]);
}

async function decodePpm(
  inputPath: string,
  timeSeconds: number,
  outputPath: string,
): Promise<Buffer> {
  await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(timeSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-vcodec",
    "ppm",
    "-y",
    outputPath,
  ]);
  return readFile(outputPath);
}

function dominantColorCount(frame: ReturnType<typeof parsePpm>, color: "red" | "blue"): number {
  let count = 0;
  for (let y = 0; y < Math.min(300, frame.height); y += 1) {
    for (let x = Math.floor(frame.width * 0.7); x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 3;
      const red = frame.pixels[offset] ?? 0;
      const blue = frame.pixels[offset + 2] ?? 0;
      if (color === "red" ? red > blue + 60 : blue > red + 60) count += 1;
    }
  }
  return count;
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
    thinRightScrollbar?: boolean;
    frameIntervalUs?: number;
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
  const frameDimensions = options.thinRightScrollbar ? "947x900" : "320x180";
  await makeFrame(beforePath, "black", {
    dimensions: frameDimensions,
    ...(options.thinRightScrollbar ? { thinRightScrollbar: true } : {}),
  });
  await makeFrame(afterPath, options.noVisibleResult ? "black" : "white", {
    dimensions: frameDimensions,
    ...(options.thinRightScrollbar ? { thinRightScrollbar: true } : {}),
  });
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
        width: options.thinRightScrollbar ? 947 : 320,
        height: options.thinRightScrollbar ? 900 : 180,
        ...(options.timing === "legacy"
          ? {}
          : { receiptOffsetUs: index * (options.frameIntervalUs ?? 33_333) }),
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
  it("recomputes owner-bound editorial proposals from sealed evidence before one automated zoom revision", async () => {
    const ownerToken = "44444444-4444-4444-8444-444444444444";
    const source = await fixture({ ownerToken, frameIntervalUs: 50_000 });
    const helperRoot = join(source.artifactRoot, "browser-helpers", source.sessionId);
    await mkdir(helperRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(source.sessionRoot, "capture-config.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-start.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-stop.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(source.artifactRoot, ".recordly-codex-owner-token"), `${ownerToken}\n`, {
        mode: 0o600,
      }),
    ]);
    await renderSealedSession(source);
    const manifest = JSON.parse(
      await readFile(join(source.sessionRoot, "artifacts", "recording-manifest.json"), "utf8"),
    ) as { timeline: { slots: Array<{ sourceFrameId: number }> } };
    expect(manifest.timeline.slots.length).toBeGreaterThan(24);
    expect(new Set(manifest.timeline.slots.map((slot) => slot.sourceFrameId)).size).toBeLessThan(
      manifest.timeline.slots.length,
    );
    const service = createSessionStoreService({ artifactRoot: source.artifactRoot });
    if (
      service.createProject === undefined ||
      service.reviseProject === undefined ||
      service.proposeEditorial === undefined ||
      service.applyAcceptedEditorialProposal === undefined
    ) {
      throw new Error("editorial service is unavailable");
    }
    const created = await service.createProject({
      sessionId: source.sessionId,
      projectId: "editorial-service-flow",
    });
    const v2 = await service.reviseProject({
      mode: "manual",
      project: { ...created.project, revision: 1 },
    });
    if (v2.project.schemaVersion !== 2) throw new Error("project did not migrate to V2");
    const proposal = await service.proposeEditorial({
      projectId: v2.project.projectId,
      projectRevision: v2.project.revision,
    });
    const repeated = await service.proposeEditorial({
      projectId: v2.project.projectId,
      projectRevision: v2.project.revision,
    });
    const accepted = proposal.zoomProposals[0];
    if (accepted === undefined) throw new Error("sealed evidence produced no zoom proposal");
    expect(repeated).toEqual(proposal);
    expect(JSON.stringify(proposal)).not.toContain(source.artifactRoot);
    expect(JSON.stringify(proposal)).not.toContain("frames/raw");
    expect(proposal.reviewTrimProposals.every((item) => item.action === "review-trim")).toBe(true);
    await expect(
      service.applyAcceptedEditorialProposal({
        projectId: v2.project.projectId,
        projectRevision: v2.project.revision,
        proposalSha256: "0".repeat(64),
        acceptedZoomProposalIds: [accepted.id],
      }),
    ).rejects.toThrow();
    const applied = await service.applyAcceptedEditorialProposal({
      projectId: v2.project.projectId,
      projectRevision: v2.project.revision,
      proposalSha256: proposal.proposalSha256,
      acceptedZoomProposalIds: [accepted.id],
    });
    expect(applied.project).toMatchObject({
      revision: 2,
      revisionPolicy: { automatedRevisionCount: 1 },
      zoomProposals: [expect.objectContaining({ id: accepted.id })],
    });
  }, 60_000);

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

  it("accepts a resampled thin right-edge scrollbar without masking clipping", async () => {
    const source = await fixture({ thinRightScrollbar: true });

    const rendered = await renderSealedSession(source);
    const quality = JSON.parse(await readFile(rendered.qualityReportPath, "utf8"));

    expect(rendered.approved).toBe(true);
    expect(quality.clipping).toMatchObject({
      status: "pass",
      expectedContentRect: { x: 444, y: 50, width: 1032, height: 980 },
      samples: expect.arrayContaining([
        expect.objectContaining({
          frameIndex: 0,
          edgesPresent: true,
          maxEdgeColorDelta: expect.any(Number),
        }),
      ]),
    });
  }, 60_000);

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
    const helperRoot = join(source.artifactRoot, "browser-helpers", source.sessionId);
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
        service.inspectProject === undefined ||
        service.reviseProject === undefined ||
        service.renderProject === undefined ||
        service.judgePreview === undefined
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
      const legacyFinal = await service.renderProject({
        projectId: secondProject.project.projectId,
        revision: secondProject.project.revision,
        kind: "final",
      });
      expect(legacyFinal.render).toMatchObject({ kind: "final", format: "mp4" });
      await expect(
        service.renderProject({
          projectId: secondProject.project.projectId,
          revision: 99,
          kind: "preview",
        }),
      ).rejects.toThrow();
      const judgmentProject = await service.createProject({
        sessionId: source.sessionId,
        projectId: "service-flow-judgment",
      });
      const judgmentPreview = await service.renderProject({
        projectId: judgmentProject.project.projectId,
        revision: judgmentProject.project.revision,
        kind: "preview",
      });
      await expect(
        service.judgePreview({
          projectId: judgmentProject.project.projectId,
          revision: judgmentProject.project.revision,
          projectSha256: judgmentPreview.projectSha256,
          previewArtifactSha256: "0".repeat(64),
          verdict: "revise",
          issues: [],
        }),
      ).rejects.toThrow(/unavailable/i);
      await service.judgePreview({
        projectId: judgmentProject.project.projectId,
        revision: judgmentProject.project.revision,
        projectSha256: judgmentPreview.projectSha256,
        previewArtifactSha256: judgmentPreview.render?.sha256 ?? "",
        verdict: "revise",
        issues: [
          {
            code: "framing",
            severity: "major",
            region: "presentation",
            startUs: 0,
            endUs: 1,
            evidence: "The framing needs adjustment.",
          },
        ],
      });
      await expect(
        service.renderProject({
          projectId: judgmentProject.project.projectId,
          revision: judgmentProject.project.revision,
          kind: "final",
        }),
      ).rejects.toThrow(/accepted|judgment/i);
      const rejectedProject = await service.createProject({
        sessionId: source.sessionId,
        projectId: "service-flow-rejected",
      });
      const rejectedPreview = await service.renderProject({
        projectId: rejectedProject.project.projectId,
        revision: rejectedProject.project.revision,
        kind: "preview",
      });
      await service.judgePreview({
        projectId: rejectedProject.project.projectId,
        revision: rejectedProject.project.revision,
        projectSha256: rejectedPreview.projectSha256,
        previewArtifactSha256: rejectedPreview.render?.sha256 ?? "",
        verdict: "reject",
        issues: [
          {
            code: "unusable",
            severity: "blocking",
            region: "output",
            startUs: 0,
            endUs: 1,
            evidence: "The preview cannot be approved.",
          },
        ],
      });
      await expect(
        service.renderProject({
          projectId: rejectedProject.project.projectId,
          revision: rejectedProject.project.revision,
          kind: "final",
        }),
      ).rejects.toThrow(/accepted|judgment/i);
      const revised = await service.reviseProject({
        mode: "manual",
        project: {
          ...judgmentPreview.project,
          revision: 1,
          output: { ...preview.project.output, format: "gif" },
          presentation: {
            ...preview.project.presentation,
            cursor: { ...preview.project.presentation.cursor, preset: "large" },
          },
        },
      });
      const acceptedPreview = await service.renderProject({
        projectId: revised.project.projectId,
        revision: revised.project.revision,
        kind: "preview",
      });
      const judgment = await service.judgePreview({
        projectId: revised.project.projectId,
        revision: revised.project.revision,
        projectSha256: acceptedPreview.projectSha256,
        previewArtifactSha256: acceptedPreview.render?.sha256 ?? "",
        verdict: "accept",
        issues: [],
      });
      expect(judgment.previewJudgment).toMatchObject({
        status: "current",
        verdict: "accept",
        remainingAutomatedRevisionBudget: 4,
      });
      const previewPath = join(source.artifactRoot, acceptedPreview.render?.artifact ?? "");
      await writeFile(previewPath, "tampered-preview\n", { mode: 0o600 });
      const stale = await service.inspectProject({ projectId: revised.project.projectId });
      expect(stale.previewJudgment).toMatchObject({ status: "stale", verdict: "accept" });
      await expect(
        service.renderProject({
          projectId: revised.project.projectId,
          revision: revised.project.revision,
          kind: "final",
        }),
      ).rejects.toThrow(/accepted|judgment/i);
      for (const result of [preview, legacyFinal, judgmentPreview]) {
        expect(result.render?.artifact).toMatch(
          /^projects\/renders\/service-flow(?:-second|-judgment)-r\d+-(preview|final)\.(mp4|gif)$/u,
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
      expect(acceptedPreview.render?.format).toBe("gif");
      expect(await readFile(join(source.sessionRoot, "capture-events.jsonl"))).toEqual(
        captureBefore,
      );
      expect((await lstat(join(source.sessionRoot, "capture-events.jsonl"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await rm(helperRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("imports decoded V2 visual media and publishes it only after its private handle disposes cleanly", async () => {
    const ownerToken = "22222222-2222-4222-8222-222222222222";
    const source = await fixture({ ownerToken });
    const helperRoot = join(source.artifactRoot, "browser-helpers", source.sessionId);
    const authorizedRoot = join(source.artifactRoot, "authorized-media");
    const visualPath = join(authorizedRoot, "temporal.mp4");
    const replacementPath = join(authorizedRoot, "replacement.mp4");
    await mkdir(helperRoot, { recursive: true, mode: 0o700 });
    await mkdir(authorizedRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(source.sessionRoot, "capture-config.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-start.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-stop.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(source.artifactRoot, ".recordly-codex-owner-token"), `${ownerToken}\n`, {
        mode: 0o600,
      }),
    ]);
    await makeTemporalVisual(visualPath, "red", "blue");
    await makeTemporalVisual(replacementPath, "green", "yellow");
    try {
      await renderSealedSession(source);
      const service = createSessionStoreService({
        artifactRoot: source.artifactRoot,
        authorizedImportRoot: authorizedRoot,
      });
      if (
        service.createProject === undefined ||
        service.reviseProject === undefined ||
        service.inspectProject === undefined ||
        service.renderProject === undefined ||
        service.importProjectMedia === undefined
      ) {
        throw new Error("project media service is unavailable");
      }
      const created = await service.createProject({
        sessionId: source.sessionId,
        projectId: "temporal-visual",
      });
      const imported = await service.importProjectMedia({
        projectId: created.project.projectId,
        revision: created.project.revision,
        fileName: "temporal.mp4",
      });
      expect(imported).toMatchObject({
        mediaId: expect.stringMatching(/^media_[a-f0-9]{32}$/u),
        kind: "video",
        extension: "mp4",
        width: 64,
        height: 32,
        fps: 30,
      });
      if (imported.kind !== "video" || imported.fps === undefined) {
        throw new Error("imported visual media was not a decoded video");
      }
      expect(JSON.stringify(imported)).not.toContain(authorizedRoot);
      const migrated = await service.reviseProject({
        mode: "manual",
        project: { ...created.project, revision: created.project.revision + 1 },
      });
      if (migrated.project.schemaVersion !== 2) throw new Error("project did not migrate to V2");
      const clip = migrated.project.timeline.clips[0];
      if (clip === undefined) throw new Error("fixture project has no clip");
      const withVisual = await service.reviseProject({
        mode: "manual",
        project: {
          ...migrated.project,
          revision: migrated.project.revision + 1,
          media: {
            assets: [
              ...migrated.project.media.assets,
              {
                id: imported.mediaId,
                sha256: imported.sha256,
                kind: "video",
                provenance: "explicit-local-import",
                durationUs: imported.durationUs,
                width: imported.width,
                height: imported.height,
                fps: imported.fps,
              },
            ],
          },
          visualTracks: [
            {
              id: "temporal-pip",
              mediaId: imported.mediaId,
              clipId: clip.id,
              timeDomain: "clip-source-relative",
              startUs: 100_000,
              endUs: 700_000,
              mediaTrim: { startUs: 0, endUs: 600_000 },
              sync: "source-time",
              layout: {
                position: "top-right",
                scale: 0.2,
                fit: "contain",
                crop: "none",
                opacity: 1,
                radiusPx: 0,
                border: "none",
              },
              motion: { preset: "none", durationUs: 0 },
            },
          ],
        },
      });
      const preview = await service.renderProject({
        projectId: withVisual.project.projectId,
        revision: withVisual.project.revision,
        kind: "preview",
      });
      const previewPath = join(source.artifactRoot, preview.render?.artifact ?? "");
      const redFrame = parsePpm(
        await decodePpm(previewPath, 0.25, join(source.artifactRoot, "temporal-red.ppm")),
      );
      const blueFrame = parsePpm(
        await decodePpm(previewPath, 0.55, join(source.artifactRoot, "temporal-blue.ppm")),
      );
      expect(dominantColorCount(redFrame, "red")).toBeGreaterThan(3_000);
      expect(dominantColorCount(blueFrame, "blue")).toBeGreaterThan(3_000);

      const tampered = await service.reviseProject({
        mode: "manual",
        project: {
          ...preview.project,
          revision: preview.project.revision + 1,
          preview: { status: "not-requested" },
        },
      });
      const objectPath = join(
        source.artifactRoot,
        "private-media-library",
        "objects",
        imported.sha256,
      );
      const pending = service.renderProject({
        projectId: tampered.project.projectId,
        revision: tampered.project.revision,
        kind: "preview",
      });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      await writeFile(objectPath, await readFile(replacementPath), { mode: 0o600 });
      await expect(pending).rejects.toThrow(/media|dispose|integrity|reference/i);
      const failedArtifact = join(
        source.artifactRoot,
        "projects",
        "renders",
        `${tampered.project.projectId}-r${tampered.project.revision}-preview.mp4`,
      );
      await expect(lstat(failedArtifact)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        service.inspectProject({ projectId: tampered.project.projectId }),
      ).resolves.toMatchObject({
        project: { revision: tampered.project.revision, preview: tampered.project.preview },
      });
    } finally {
      await rm(helperRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("imports normalized private audio, revises V2, and renders decodable project audio", async () => {
    const ownerToken = "33333333-3333-4333-8333-333333333333";
    const source = await fixture({ ownerToken });
    const helperRoot = join(source.artifactRoot, "browser-helpers", source.sessionId);
    const authorizedRoot = join(source.artifactRoot, "authorized-audio");
    await mkdir(helperRoot, { recursive: true, mode: 0o700 });
    await mkdir(authorizedRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(source.sessionRoot, "capture-config.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-start.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(helperRoot, "browser-stop.mjs"), "export {};\n", { mode: 0o600 }),
      writeFile(join(source.artifactRoot, ".recordly-codex-owner-token"), `${ownerToken}\n`, {
        mode: 0o600,
      }),
    ]);
    await Promise.all(
      ["tone.wav", "tone.mp3", "tone.m4a"].map((fileName) =>
        makeImportAudio(join(authorizedRoot, fileName)),
      ),
    );
    await renderSealedSession(source);
    const service = createSessionStoreService({
      artifactRoot: source.artifactRoot,
      authorizedImportRoot: authorizedRoot,
    });
    if (
      service.createProject === undefined ||
      service.reviseProject === undefined ||
      service.inspectProject === undefined ||
      service.renderProject === undefined ||
      service.importProjectMedia === undefined
    ) {
      throw new Error("audio import service is unavailable");
    }
    const importProjectMedia = service.importProjectMedia;
    const created = await service.createProject({
      sessionId: source.sessionId,
      projectId: "audio-e2e",
    });
    const imported = await service.importProjectMedia({
      projectId: created.project.projectId,
      revision: 0,
      fileName: "tone.wav",
    });
    const repeated = await service.importProjectMedia({
      projectId: created.project.projectId,
      revision: 0,
      fileName: "tone.wav",
    });
    const alternateFormats = await Promise.all(
      ["tone.mp3", "tone.m4a"].map((fileName) =>
        importProjectMedia({
          projectId: created.project.projectId,
          revision: 0,
          fileName,
        }),
      ),
    );
    expect(repeated).toEqual(imported);
    for (const normalized of alternateFormats) {
      expect(normalized).toMatchObject({
        mediaId: expect.stringMatching(/^audio_[a-f0-9]{32}$/u),
        kind: "audio",
        extension: "wav",
        sampleRate: 48_000,
        channels: 2,
      });
      expect(JSON.stringify(normalized)).not.toContain(authorizedRoot);
    }
    expect(imported).toMatchObject({
      mediaId: expect.stringMatching(/^audio_[a-f0-9]{32}$/u),
      kind: "audio",
      extension: "wav",
      sampleRate: 48_000,
      channels: 2,
    });
    expect(JSON.stringify(imported)).not.toContain(authorizedRoot);
    await expect(
      service.importProjectMedia({
        projectId: created.project.projectId,
        revision: 1,
        fileName: "tone.wav",
      }),
    ).rejects.toThrow();
    await expect(lstat(join(source.artifactRoot, "projects", "renders"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const migrated = await service.reviseProject({
      mode: "manual",
      project: { ...created.project, revision: 1 },
    });
    if (migrated.project.schemaVersion !== 2 || imported.kind !== "audio")
      throw new Error("audio project did not migrate");
    const withAudio = await service.reviseProject({
      mode: "manual",
      project: {
        ...migrated.project,
        revision: 2,
        media: {
          assets: [
            ...migrated.project.media.assets,
            {
              id: imported.mediaId,
              sha256: imported.sha256,
              kind: "audio",
              provenance: "explicit-local-import",
              durationUs: imported.durationUs,
            },
          ],
        },
        audioTracks: [
          {
            id: "tone-track",
            asset: { assetId: imported.mediaId, sha256: imported.sha256 },
            timeDomain: "project-output-relative",
            startUs: 0,
            trim: { startUs: 0, endUs: Math.min(imported.durationUs, 300_000) },
            gainDb: -3,
          },
        ],
        audioMix: {
          tracks: [
            {
              trackId: "tone-track",
              mediaId: imported.mediaId,
              role: "primary",
              pan: 0,
              fadeInUs: 0,
              fadeOutUs: 0,
              ducking: "none",
            },
          ],
        },
      },
    });
    const preview = await service.renderProject({
      projectId: "audio-e2e",
      revision: 2,
      kind: "preview",
    });
    const previewPath = join(source.artifactRoot, preview.render?.artifact ?? "");
    const probe = await execFileAsync(await resolveMediaExecutable("ffprobe"), [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,channels",
      "-of",
      "csv=p=0",
      previewPath,
    ]);
    expect(probe.stdout.trim()).toBe("48000,2");
    expect(withAudio.project.revision).toBe(2);
    const tamperedRevision = await service.reviseProject({
      mode: "manual",
      project: {
        ...preview.project,
        revision: 3,
        preview: { status: "not-requested" },
      },
    });
    await writeFile(
      join(source.artifactRoot, "project-assets", `${imported.mediaId}.wav`),
      Buffer.from("tampered normalized audio"),
      { mode: 0o600 },
    );
    await expect(
      service.renderProject({
        projectId: "audio-e2e",
        revision: tamperedRevision.project.revision,
        kind: "preview",
      }),
    ).rejects.toThrow(/asset|digest|media/i);
    await expect(
      lstat(
        join(
          source.artifactRoot,
          "projects",
          "renders",
          `audio-e2e-r${tamperedRevision.project.revision}-preview.mp4`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.inspectProject({ projectId: "audio-e2e" })).resolves.toMatchObject({
      project: { revision: 3, preview: { status: "stale" } },
    });
  }, 120_000);
});
