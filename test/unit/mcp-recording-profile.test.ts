import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RecordingProjectStore } from "../../mcp/project-persistence.js";
import {
  applyRecordingProfileInputSchema,
  createRecordingProfileInputSchema,
  updateRecordingProfileInputSchema,
} from "../../mcp/schemas.js";
import { createSessionStoreService } from "../../mcp/session-store-service.js";
import type { RecordingMcpService } from "../../mcp/types.js";
import { builtInRecordingProfiles, validateRecordingProject } from "../../src/project/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sourceProject() {
  return validateRecordingProject({
    schemaVersion: 1,
    projectId: "profile-project",
    revision: 0,
    revisionPolicy: { automatedRevisionLimit: 0, automatedRevisionCount: 0 },
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
      cursor: {
        visible: true,
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
    audioTracks: [],
    pipTracks: [],
    renderHooks: [],
    preview: { status: "ready", revision: 0 },
  });
}

function highQualitySnapshot() {
  const clean = builtInRecordingProfiles().find((profile) => profile.profileId === "clean");
  if (clean === undefined) throw new Error("clean profile is missing");
  return {
    ...clean.snapshot,
    output: { ...clean.snapshot.output, quality: "high" as const },
  };
}

async function ownedService() {
  const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-profile-mcp-"));
  roots.push(artifactRoot);
  const service = createSessionStoreService({ artifactRoot, idSource: () => "profile-session" });
  await service.create({
    url: "https://demo.example/profile",
    objective: "Initialize profile owner.",
  });
  const ownerToken = (
    await readFile(join(artifactRoot, ".recordly-codex-owner-token"), "utf8")
  ).trim();
  return { artifactRoot, ownerToken, service };
}

function profileApi(service: RecordingMcpService) {
  const { listProfiles, getProfile, createProfile, updateProfile, applyProfile } = service;
  if (
    listProfiles === undefined ||
    getProfile === undefined ||
    createProfile === undefined ||
    updateProfile === undefined ||
    applyProfile === undefined
  ) {
    throw new Error("profile service is unavailable");
  }
  return { listProfiles, getProfile, createProfile, updateProfile, applyProfile };
}

describe("recording-profile MCP service", () => {
  it("creates owner-local profiles, lists deterministic summaries, updates by exact CAS, and isolates owners", async () => {
    const { service } = await ownedService();
    const profiles = profileApi(service);
    const snapshot = highQualitySnapshot();
    const created = await profiles.createProfile({ profileId: "team-demo", snapshot });

    expect(created).toMatchObject({ source: "owner-local", profileRevision: 1 });
    expect(await profiles.listProfiles({})).toEqual([
      ...builtInRecordingProfiles().map(
        ({ source, profileId, profileRevision, snapshotSha256 }) => ({
          source,
          profileId,
          profileRevision,
          snapshotSha256,
        }),
      ),
      {
        source: "owner-local",
        profileId: "team-demo",
        profileRevision: 1,
        snapshotSha256: created.snapshotSha256,
      },
    ]);
    expect(await profiles.getProfile({ source: "owner-local", profileId: "team-demo" })).toEqual(
      created,
    );

    const updated = await profiles.updateProfile({
      profileId: "team-demo",
      expectedRevision: 1,
      expectedSnapshotSha256: created.snapshotSha256,
      snapshot: { ...snapshot, cursor: { ...snapshot.cursor, preset: "large" } },
    });
    expect(updated.profileRevision).toBe(2);
    await expect(
      profiles.updateProfile({
        profileId: "team-demo",
        expectedRevision: 1,
        expectedSnapshotSha256: created.snapshotSha256,
        snapshot,
      }),
    ).rejects.toThrow(/compare|changed/i);

    const other = await ownedService();
    const otherProfiles = profileApi(other.service);
    expect(await otherProfiles.listProfiles({})).toHaveLength(3);
    await expect(
      otherProfiles.getProfile({ source: "owner-local", profileId: "team-demo" }),
    ).rejects.toThrow();
  });

  it("applies only exact canonical profiles as one revision, migrates V1, stales preview, and enforces automated budget", async () => {
    const { artifactRoot, ownerToken, service } = await ownedService();
    const profiles = profileApi(service);
    await new RecordingProjectStore(artifactRoot, ownerToken).create(sourceProject());
    const snapshot = highQualitySnapshot();
    const created = await profiles.createProfile({ profileId: "team-demo", snapshot });
    const updated = await profiles.updateProfile({
      profileId: "team-demo",
      expectedRevision: created.profileRevision,
      expectedSnapshotSha256: created.snapshotSha256,
      snapshot: { ...snapshot, cursor: { ...snapshot.cursor, preset: "large" } },
    });

    await expect(
      profiles.applyProfile({
        projectId: "profile-project",
        projectRevision: 0,
        profile: {
          source: "owner-local",
          profileId: created.profileId,
          profileRevision: created.profileRevision,
          snapshotSha256: created.snapshotSha256,
        },
        mode: "manual",
      }),
    ).rejects.toThrow();

    const applied = await profiles.applyProfile({
      projectId: "profile-project",
      projectRevision: 0,
      profile: {
        source: "owner-local",
        profileId: updated.profileId,
        profileRevision: updated.profileRevision,
        snapshotSha256: updated.snapshotSha256,
      },
      mode: "manual",
    });
    expect(applied.project).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      preview: { status: "stale", revision: 0 },
      profile: { profileId: "team-demo", profileRevision: 2 },
    });
    await expect(
      profiles.applyProfile({
        projectId: "profile-project",
        projectRevision: 0,
        profile: {
          source: "owner-local",
          profileId: updated.profileId,
          profileRevision: updated.profileRevision,
          snapshotSha256: updated.snapshotSha256,
        },
        mode: "manual",
      }),
    ).rejects.toThrow();
    await expect(
      profiles.applyProfile({
        projectId: "profile-project",
        projectRevision: 1,
        profile: {
          source: "builtin",
          profileId: "clean",
          profileRevision: 1,
          snapshotSha256: "0".repeat(64),
        },
        mode: "manual",
      }),
    ).rejects.toThrow();
    await expect(
      profiles.applyProfile({
        projectId: "profile-project",
        projectRevision: 1,
        profile: {
          source: "owner-local",
          profileId: updated.profileId,
          profileRevision: updated.profileRevision,
          snapshotSha256: updated.snapshotSha256,
        },
        mode: "automated",
      }),
    ).rejects.toThrow(/automated|revision/i);
  });

  it("keeps the MCP profile inputs strict and path-free", () => {
    const snapshot = highQualitySnapshot();
    expect(
      createRecordingProfileInputSchema.safeParse({ profileId: "team-demo", snapshot }).success,
    ).toBe(true);
    expect(
      updateRecordingProfileInputSchema.safeParse({
        profileId: "team-demo",
        expectedRevision: 1,
        expectedSnapshotSha256: "a".repeat(64),
        snapshot,
        path: "/tmp/unsafe",
      }).success,
    ).toBe(false);
    expect(
      applyRecordingProfileInputSchema.safeParse({
        projectId: "profile-project",
        projectRevision: 0,
        profile: {
          source: "builtin",
          profileId: "clean",
          profileRevision: 1,
          snapshotSha256: "a".repeat(64),
          snapshot,
        },
      }).success,
    ).toBe(false);
  });
});
