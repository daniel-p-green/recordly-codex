import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RecordingProjectStore } from "../../mcp/project-persistence.js";

const roots: string[] = [];

const project = {
  schemaVersion: 1,
  projectId: "workflow-project",
  revision: 0,
  revisionPolicy: { automatedRevisionLimit: 4, automatedRevisionCount: 0 },
  captureSources: [
    {
      id: "capture-1",
      sessionId: "session-1",
      manifestSha256: "a".repeat(64),
      timelineSha256: "b".repeat(64),
      frameSetSha256: "c".repeat(64),
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
        id: "clip-1",
        sourceId: "capture-1",
        trim: { startUs: 0, endUs: 1_000_000 },
        speedRegions: [],
        zoomRegions: [],
        transitionAfter: { kind: "cut", durationUs: 0 },
      },
    ],
  },
  presentation: {
    cursor: { visible: true, preset: "system", sizePx: 28, motion: "source", clickEffect: "none" },
    frame: {
      background: { kind: "solid", color: "#111827" },
      paddingPx: 32,
      radiusPx: 16,
      shadow: "soft",
    },
  },
  overlays: { annotations: [], captions: [] },
  audioTracks: [],
  pipTracks: [],
  renderHooks: [],
  preview: { status: "not-requested" },
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recording project persistence", () => {
  it("permits exactly one concurrent create and rejects stale compare-and-swap replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-project-store-"));
    roots.push(root);
    const store = new RecordingProjectStore(root, "owner-1");
    const independentStore = new RecordingProjectStore(root, "owner-1");

    const creates = await Promise.allSettled([
      store.create(project),
      independentStore.create(project),
    ]);
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates.filter((result) => result.status === "rejected")).toHaveLength(1);

    const created = await store.load(project.projectId);
    const revised = {
      ...project,
      revision: 1,
      presentation: {
        ...project.presentation,
        cursor: { ...project.presentation.cursor, preset: "large" as const },
      },
    };
    const stored = await store.replace(revised, {
      expectedRevision: created.project.revision,
      expectedSha256: created.sha256,
    });
    expect(stored.project.revision).toBe(1);
    await expect(
      store.replace(project, {
        expectedRevision: created.project.revision,
        expectedSha256: created.sha256,
      }),
    ).rejects.toThrow(/changed|stale/i);
  });

  it("atomically compares and replaces through independent store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-project-store-"));
    roots.push(root);
    const first = new RecordingProjectStore(root, "owner-1");
    const second = new RecordingProjectStore(root, "owner-1");
    const created = await first.create(project);
    const fromFirst = await first.load(project.projectId);
    const fromSecond = await second.load(project.projectId);
    const largeCursor = {
      ...project,
      revision: 1,
      presentation: {
        ...project.presentation,
        cursor: { ...project.presentation.cursor, preset: "large" as const },
      },
    };
    const systemCursor = { ...project, revision: 1 };

    const replacements = await Promise.allSettled([
      first.replace(largeCursor, {
        expectedRevision: fromFirst.project.revision,
        expectedSha256: fromFirst.sha256,
      }),
      second.replace(systemCursor, {
        expectedRevision: fromSecond.project.revision,
        expectedSha256: fromSecond.sha256,
      }),
    ]);
    expect(replacements.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(replacements.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await first.load(project.projectId)).project.revision).toBe(1);
    expect(created.project.revision).toBe(0);
  });

  it("never chmods a symlinked projects ancestor or reclaims a foreign stale-looking lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-project-store-"));
    const external = await mkdtemp(join(tmpdir(), "recordly-project-external-"));
    roots.push(root, external);
    await chmod(external, 0o755);
    await symlink(external, join(root, "projects"));
    await expect(new RecordingProjectStore(root, "owner-1").create(project)).rejects.toThrow(
      /private|symlink|escape/i,
    );
    expect((await lstat(external)).mode & 0o777).toBe(0o755);

    await rm(join(root, "projects"));
    await mkdir(join(root, "projects"), { mode: 0o700 });
    const first = new RecordingProjectStore(root, "owner-1");
    const second = new RecordingProjectStore(root, "owner-1");
    const created = await first.create(project);
    const lock = join(root, "projects", `${project.projectId}.json.lock`);
    await writeFile(lock, '{"pid":999999,"token":"foreign","createdAtMs":0}\n', { mode: 0o600 });
    await utimes(lock, new Date(0), new Date(0));
    const next = { ...project, revision: 1 };
    const results = await Promise.allSettled([
      first.replace(next, { expectedRevision: 0, expectedSha256: created.sha256 }),
      second.replace(next, { expectedRevision: 0, expectedSha256: created.sha256 }),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect((await first.load(project.projectId)).project.revision).toBe(0);
  });

  it("stores canonical owner-bound projects privately and detects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-project-store-"));
    roots.push(root);
    const store = new RecordingProjectStore(root, "owner-1");

    const created = await store.create(project);
    const path = join(root, "projects", "workflow-project.json");
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await lstat(join(root, "projects"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await store.load("workflow-project")).project).toEqual(project);

    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...persisted, projectSha256: "0".repeat(64) })}\n`, {
      mode: 0o600,
    });
    await expect(store.load("workflow-project")).rejects.toThrow(/digest/i);
    await expect(
      new RecordingProjectStore(root, "owner-2").load("workflow-project"),
    ).rejects.toThrow(/owned/i);
  });

  it("fails closed with an explicit diagnostic for unsupported envelope versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-project-store-"));
    roots.push(root);
    const store = new RecordingProjectStore(root, "owner-1");
    await store.create(project);
    const path = join(root, "projects", "workflow-project.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...persisted, schemaVersion: 2 })}\n`, {
      mode: 0o600,
    });

    await expect(store.load("workflow-project")).rejects.toThrow(/version.*unsupported/i);
  });
});
