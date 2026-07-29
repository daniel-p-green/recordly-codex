import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveMediaExecutable } from "../../src/encoder/ffmpeg.js";
import { createPrivateMediaLibrary } from "../../src/media/private-media-library.js";
import { createPrivateVisualRasterAdapter } from "../../src/media/private-visual-raster.js";
import { migrateV1RecordingProject, validateRecordingProject } from "../../src/project/index.js";
import { ProjectMediaStore } from "../../mcp/project-media-store.js";
import { resolveProjectVisualSources } from "../../mcp/project-visual-resolver.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const ownerToken = "owner-token";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recordly-visual-resolver-"));
  roots.push(root);
  return root;
}

function baseProject() {
  return migrateV1RecordingProject({
    schemaVersion: 1,
    projectId: "visual-project",
    revision: 1,
    revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
    captureSources: [
      {
        id: "capture",
        sessionId: "session",
        manifestSha256: "a".repeat(64),
        timelineSha256: "b".repeat(64),
        frameSetSha256: "c".repeat(64),
        sourceWidth: 160,
        sourceHeight: 90,
        durationUs: 100_000,
      },
    ],
    output: {
      profile: "landscape-1080p",
      width: 1920,
      height: 1080,
      fps: 30,
      format: "mp4",
      quality: "standard",
    },
    timeline: {
      clips: [
        {
          id: "clip",
          sourceId: "capture",
          trim: { startUs: 0, endUs: 100_000 },
          speedRegions: [],
          zoomRegions: [],
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
      ],
    },
    presentation: {
      cursor: {
        visible: false,
        preset: "system",
        sizePx: 24,
        motion: "source",
        clickEffect: "none",
      },
      frame: {
        background: { kind: "solid", color: "#000000" },
        paddingPx: 0,
        radiusPx: 0,
        shadow: "none",
      },
    },
    overlays: { annotations: [], captions: [] },
    audioTracks: [],
    pipTracks: [],
    renderHooks: [],
    preview: { status: "not-requested" },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project visual resolver", () => {
  it("opens one opaque V2 source and makes same-geometry object replacement fail at disposal", async () => {
    const artifactRoot = await temporaryRoot();
    const authorizedRoot = join(artifactRoot, "authorized");
    const libraryRoot = join(artifactRoot, "private-media-library");
    const red = join(authorizedRoot, "still.png");
    const blue = join(authorizedRoot, "replacement.png");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    const ffmpeg = await resolveMediaExecutable("ffmpeg");
    for (const [color, path] of [
      ["red", red],
      ["blue", blue],
    ] as const) {
      await execFileAsync(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=4x2`,
        "-frames:v",
        "1",
        "-y",
        path,
      ]);
    }
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const imported = await library.ingest({
      authorizedRoot,
      relativePath: "still.png",
      maximumBytes: 1024 * 1024,
    });
    const inspected = await (await createPrivateVisualRasterAdapter({ libraryRoot })).inspect({
      media: imported,
    });
    await new ProjectMediaStore(artifactRoot, ownerToken).save(inspected);
    const migrated = baseProject();
    const project = validateRecordingProject({
      ...migrated,
      media: {
        assets: [
          ...migrated.media.assets,
          {
            id: inspected.mediaId,
            sha256: inspected.sha256,
            kind: "image",
            provenance: "explicit-local-import",
            durationUs: inspected.durationUs,
          },
        ],
      },
      visualTracks: [
        {
          id: "visual",
          mediaId: inspected.mediaId,
          clipId: "clip",
          timeDomain: "clip-source-relative",
          startUs: 0,
          endUs: 100_000,
          mediaTrim: { startUs: 0, endUs: 1 },
          sync: "output-time",
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
    });

    const resolved = await resolveProjectVisualSources({ artifactRoot, ownerToken, project });
    expect(resolved.sources).toHaveLength(1);
    expect(resolved.sources[0]).toMatchObject({ id: inspected.mediaId, sha256: inspected.sha256 });
    await writeFile(join(libraryRoot, "objects", imported.sha256), await readFile(blue), {
      mode: 0o600,
    });
    await expect(resolved.dispose()).rejects.toThrow(/disposal|reference|disagree/i);
  });
});
