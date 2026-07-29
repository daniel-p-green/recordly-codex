import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import {
  createVerifiedCaptureSource,
  sourceKeyedPresentationEvidence,
} from "../../mcp/project-render-source.js";
import { resolveMediaExecutable } from "../../src/encoder/ffmpeg.js";
import { canonicalJson } from "../../src/manifest/index.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("source-keyed project render evidence", () => {
  it("retains each capture's absolute source time and never projects tracks into one global timeline", () => {
    const first = sourceKeyedPresentationEvidence("capture-a", {
      cursorTrack: [{ tUs: 400_000, x: 10, y: 20, state: "default" }],
      clickTrack: [],
    });
    const evidence = sourceKeyedPresentationEvidence("capture-b", {
      cursorTrack: [{ tUs: 1_250_000, x: 120, y: 80, state: "pressed" }],
      clickTrack: [{ tUs: 1_500_000, x: 120, y: 80 }],
    });

    expect([...first.cursorTrack, ...evidence.cursorTrack]).toEqual([
      { sourceId: "capture-a", sourceTimeUs: 400_000, x: 10, y: 20, state: "default" },
      { sourceId: "capture-b", sourceTimeUs: 1_250_000, x: 120, y: 80, state: "pressed" },
    ]);
    expect(evidence).toEqual({
      cursorTrack: [
        { sourceId: "capture-b", sourceTimeUs: 1_250_000, x: 120, y: 80, state: "pressed" },
      ],
      clickTrack: [{ sourceId: "capture-b", sourceTimeUs: 1_500_000, x: 120, y: 80 }],
    });
  });

  it("rejects a capture frame replaced after validation instead of letting ffmpeg reopen it", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-frame-snapshot-"));
    roots.push(artifactRoot);
    const sessionId = "session-1";
    const sessionRoot = join(artifactRoot, sessionId);
    const rawRoot = join(sessionRoot, "frames", "raw");
    const stagingRoot = join(artifactRoot, "projects", "renders", ".frame-staging-test");
    await mkdir(join(sessionRoot, "artifacts"), { recursive: true, mode: 0o700 });
    await mkdir(rawRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(sessionRoot, 0o700),
      chmod(rawRoot, 0o700),
      chmod(stagingRoot, 0o700),
    ]);
    const framePath = join(rawRoot, "frame-000001.png");
    const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const frameSha256 = sha256(original);
    await writeFile(framePath, original, { mode: 0o600 });
    const timeline = { durationUs: 1, slots: [{ tUs: 1 }] };
    const source = {
      id: "capture-1",
      sessionId,
      manifestSha256: "",
      timelineSha256: sha256(canonicalJson(timeline)),
      frameSetSha256: sha256(frameSha256),
      sourceWidth: 2,
      sourceHeight: 2,
      durationUs: 1,
    };
    const manifest = {
      schemaVersion: 1,
      kind: "recordly-codex-delivery",
      sessionId,
      source: { width: 2, height: 2, aggregateSha256: source.frameSetSha256 },
      timeline,
      cursorTrack: [],
      observedActions: [],
    };
    const manifestText = JSON.stringify(manifest);
    source.manifestSha256 = sha256(manifestText);
    await writeFile(join(sessionRoot, "artifacts", "recording-manifest.json"), manifestText, {
      mode: 0o600,
    });
    await writeFile(
      join(sessionRoot, "capture-events.jsonl"),
      `${JSON.stringify({
        sessionId,
        type: "frame",
        frameId: 1,
        receiptOffsetUs: 1,
        imagePath: "frames/raw/frame-000001.png",
        sha256: frameSha256,
        width: 2,
        height: 2,
      })}\n`,
      { mode: 0o600 },
    );
    const reader = await createVerifiedCaptureSource({ artifactRoot, source, stagingRoot });
    await writeFile(framePath, Buffer.from("replacement"), { mode: 0o600 });

    await expect(reader.frameAt(1)).rejects.toThrow(/snapshot|evidence/i);
    await expect(readdir(stagingRoot)).resolves.toEqual([]);

    const externalRoot = await mkdtemp(join(tmpdir(), "recordly-external-events-"));
    roots.push(externalRoot);
    const externalEvents = join(externalRoot, "capture-events.jsonl");
    await copyFile(join(sessionRoot, "capture-events.jsonl"), externalEvents);
    await chmod(externalEvents, 0o644);
    const externalContent = await readFile(externalEvents, "utf8");
    await rm(join(sessionRoot, "capture-events.jsonl"));
    await symlink(externalEvents, join(sessionRoot, "capture-events.jsonl"));
    await expect(
      createVerifiedCaptureSource({ artifactRoot, source, stagingRoot }),
    ).rejects.toThrow(/unsafe|symlink|private/i);
    expect(await readFile(externalEvents, "utf8")).toBe(externalContent);
    expect((await lstat(externalEvents)).mode & 0o777).toBe(0o644);
  });

  it("scales proportional legacy screencast JPEGs to sealed geometry and rejects incompatible geometry", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-scale-source-"));
    roots.push(artifactRoot);
    const sessionId = "session-scale";
    const sessionRoot = join(artifactRoot, sessionId);
    const rawRoot = join(sessionRoot, "frames", "raw");
    const stagingRoot = join(artifactRoot, "projects", "renders", ".frame-staging-test");
    await mkdir(join(sessionRoot, "artifacts"), { recursive: true, mode: 0o700 });
    await mkdir(rawRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const framePath = join(rawRoot, "frame-000001.jpg");
    await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=947x900",
      "-frames:v",
      "1",
      "-y",
      framePath,
    ]);
    await chmod(framePath, 0o600);
    const { stdout: encodedGeometry } = await execFileAsync(
      await resolveMediaExecutable("ffprobe"),
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        framePath,
      ],
    );
    const [encodedWidth, encodedHeight] = String(encodedGeometry)
      .trim()
      .split(",")
      .map((value) => Number(value));
    const declaredWidth = 1200;
    const declaredHeight = Math.round(
      ((encodedHeight as number) * declaredWidth) / (encodedWidth as number),
    );
    const frameSha256 = sha256(await readFile(framePath));
    const timeline = { durationUs: 1, slots: [{ tUs: 1 }] };
    const source = {
      id: "capture-scale",
      sessionId,
      manifestSha256: "",
      timelineSha256: sha256(canonicalJson(timeline)),
      frameSetSha256: sha256(frameSha256),
      sourceWidth: declaredWidth,
      sourceHeight: declaredHeight,
      durationUs: 1,
    };
    const manifest = {
      schemaVersion: 1,
      kind: "recordly-codex-delivery",
      sessionId,
      source: {
        width: declaredWidth,
        height: declaredHeight,
        aggregateSha256: source.frameSetSha256,
      },
      timeline,
      cursorTrack: [],
      observedActions: [],
    };
    const manifestText = JSON.stringify(manifest);
    source.manifestSha256 = sha256(manifestText);
    await writeFile(join(sessionRoot, "artifacts", "recording-manifest.json"), manifestText, {
      mode: 0o600,
    });
    await writeFile(
      join(sessionRoot, "capture-events.jsonl"),
      `${JSON.stringify({ sessionId, type: "frame", frameId: 1, receiptOffsetUs: 1, imagePath: "frames/raw/frame-000001.jpg", sha256: frameSha256, width: declaredWidth, height: declaredHeight })}\n`,
      { mode: 0o600 },
    );
    const reader = await createVerifiedCaptureSource({ artifactRoot, source, stagingRoot });
    const frame = await reader.frameAt(1);
    expect(frame.pixels).toHaveLength(declaredWidth * declaredHeight * 3);
    expect(frame.pixels[0]).toBeGreaterThan(200);
    const incompatible = { ...source, sourceWidth: declaredWidth, sourceHeight: 900 };
    await expect(
      createVerifiedCaptureSource({ artifactRoot, source: incompatible, stagingRoot }),
    ).rejects.toThrow(/manifest|geometry/i);
  }, 30_000);
});
