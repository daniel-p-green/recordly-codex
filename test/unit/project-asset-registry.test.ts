import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadProjectAssetRegistry,
  registerProjectAudioAsset,
} from "../../mcp/project-asset-registry.js";
import { validateRecordingProject } from "../../src/project/index.js";

const roots: string[] = [];
const sha = "a".repeat(64);
const owner = "owner-token";

function project(withAssets = false) {
  return validateRecordingProject({
    schemaVersion: 1,
    projectId: "assets",
    revision: 0,
    revisionPolicy: { automatedRevisionLimit: 4, automatedRevisionCount: 0 },
    captureSources: [
      {
        id: "capture",
        sessionId: "session",
        manifestSha256: sha,
        timelineSha256: sha,
        frameSetSha256: sha,
        sourceWidth: 320,
        sourceHeight: 180,
        durationUs: 1_000_000,
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
          trim: { startUs: 0, endUs: 1_000_000 },
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
        sizePx: 28,
        motion: "source",
        clickEffect: "none",
      },
      frame: {
        background: { kind: "solid", color: "#111827" },
        paddingPx: 32,
        radiusPx: 16,
        shadow: "soft",
      },
    },
    overlays: { annotations: [], captions: [] },
    audioTracks: withAssets
      ? [
          {
            id: "audio",
            asset: { assetId: "audio-1", sha256: sha },
            timeDomain: "project-output-relative",
            startUs: 0,
            trim: { startUs: 0, endUs: 1_000_000 },
            gainDb: 0,
          },
        ]
      : [],
    pipTracks: withAssets
      ? [
          {
            id: "pip",
            asset: { assetId: "pip-1", sha256: "b".repeat(64) },
            clipId: "clip",
            timeDomain: "clip-source-relative",
            startUs: 0,
            endUs: 1_000_000,
            position: "top-left",
            scale: 0.5,
          },
        ]
      : [],
    renderHooks: [],
    preview: { status: "not-requested" },
  });
}

async function root() {
  const value = await mkdtemp(join(tmpdir(), "recordly-assets-"));
  roots.push(value);
  await mkdir(join(value, "projects"), { mode: 0o700 });
  return value;
}
async function registry(rootPath: string, entries: unknown, token = owner) {
  const path = join(rootPath, "projects", "assets.assets.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, ownerToken: token, entries }), {
    mode: 0o600,
  });
  return path;
}
async function journalEntries(rootPath: string) {
  const directory = join(rootPath, "projects", "assets.assets.d");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (name) => {
      const value = JSON.parse(await readFile(join(directory, name), "utf8")) as {
        entry: { assetId: string; sha256: string; relativePath: string };
      };
      return value.entry;
    }),
  );
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("project asset registry", () => {
  it("does not let a crashed writer's stale lock artifact brick future registrations", async () => {
    const value = await root();
    await writeFile(
      join(value, "projects", "assets.assets.json.lock"),
      JSON.stringify({ token: "crashed-writer" }),
      { mode: 0o600 },
    );
    await mkdir(join(value, "projects", "assets.assets.d"), { mode: 0o700 });
    await writeFile(
      join(value, "projects", "assets.assets.d", ".audio-crashed.partial.tmp"),
      '{"incomplete":',
      { mode: 0o600 },
    );
    await registerProjectAudioAsset({
      artifactRoot: value,
      ownerToken: owner,
      projectId: "assets",
      assetId: "audio-1",
      sha256: sha,
      relativePath: "audio-1.wav",
    });
    const base = project();
    const audioOnly = validateRecordingProject({
      ...base,
      audioTracks: [
        {
          id: "audio",
          asset: { assetId: "audio-1", sha256: sha },
          timeDomain: "project-output-relative",
          startUs: 0,
          trim: { startUs: 0, endUs: 1_000_000 },
          gainDb: 0,
        },
      ],
    });

    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: audioOnly }),
    ).resolves.toMatchObject({ assets: { "audio-1": "audio-1.wav" } });
    expect(
      JSON.parse(await readFile(join(value, "projects", "assets.assets.json.lock"), "utf8")),
    ).toEqual({ token: "crashed-writer" });
  });

  it("preserves every registration forced to race on one project", async () => {
    const value = await root();
    const registrations = Array.from({ length: 16 }, (_unused, index) => ({
      artifactRoot: value,
      ownerToken: owner,
      projectId: "assets",
      assetId: `audio-${index}`,
      sha256: index.toString(16).padStart(64, "0"),
      relativePath: `audio-${index}.wav`,
    }));

    await Promise.all(registrations.map((input) => registerProjectAudioAsset(input)));

    const stored = await journalEntries(value);
    expect(stored.map((entry) => entry.assetId).sort()).toEqual(
      registrations.map((entry) => entry.assetId).sort(),
    );
    await expect(access(join(value, "projects", "assets.assets.json.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers normalized audio idempotently and rejects conflicts, wrong owners, and tampered entries", async () => {
    const value = await root();
    const input = {
      artifactRoot: value,
      ownerToken: owner,
      projectId: "assets",
      assetId: "audio-1",
      sha256: sha,
      relativePath: "audio-1.wav",
    };
    await registerProjectAudioAsset(input);
    await registerProjectAudioAsset(input);
    expect(await journalEntries(value)).toEqual([
      { assetId: "audio-1", sha256: sha, relativePath: "audio-1.wav" },
    ]);
    await expect(registerProjectAudioAsset({ ...input, sha256: "b".repeat(64) })).rejects.toThrow(
      /conflicts/i,
    );
    await expect(
      registerProjectAudioAsset({ ...input, ownerToken: "wrong-owner" }),
    ).rejects.toThrow(/owned/i);
    await registry(value, [{ assetId: "audio-1", sha256: sha, relativePath: "../escape.wav" }]);
    await expect(registerProjectAudioAsset(input)).rejects.toThrow(/invalid/i);
  });

  it("returns empty assets without requiring a registry", async () => {
    const value = await root();
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project() }),
    ).resolves.toMatchObject({ assets: {} });
  });
  it("loads owner-bound audio and PiP mappings and rejects ownership, missing, duplicate, and digest mismatches", async () => {
    const value = await root();
    const entries = [
      { assetId: "audio-1", sha256: sha, relativePath: "audio/a.wav" },
      { assetId: "pip-1", sha256: "b".repeat(64), relativePath: "pip/a.ppm" },
    ];
    await registry(value, entries);
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).resolves.toMatchObject({ assets: { "audio-1": "audio/a.wav", "pip-1": "pip/a.ppm" } });
    await registry(value, entries, "wrong");
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).rejects.toThrow(/owned/i);
    await registry(value, [entries[0]]);
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).rejects.toThrow(/registered/i);
    await registry(value, [{ ...entries[0], sha256: "c".repeat(64) }, entries[1]]);
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).rejects.toThrow(/digest/i);
    await registry(value, [entries[0], entries[0], entries[1]]);
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).rejects.toThrow(/invalid/i);
  });
  it("rejects escaping entries and symlinked registry without touching external targets", async () => {
    const value = await root();
    const path = await registry(value, [
      { assetId: "audio-1", sha256: sha, relativePath: "../escape" },
      { assetId: "pip-1", sha256: "b".repeat(64), relativePath: "pip/a.ppm" },
    ]);
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).rejects.toThrow(/invalid/i);
    const outside = await mkdtemp(join(tmpdir(), "recordly-assets-external-"));
    roots.push(outside);
    await writeFile(join(outside, "registry"), "unchanged", { mode: 0o644 });
    await rm(path);
    await symlink(join(outside, "registry"), path);
    await expect(
      loadProjectAssetRegistry({ artifactRoot: value, ownerToken: owner, project: project(true) }),
    ).rejects.toThrow(/private/i);
  });
});
