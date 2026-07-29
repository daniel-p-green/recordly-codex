import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RecordingProfileStore } from "../../mcp/recording-profile-store.js";
import { builtInRecordingProfiles, profileSnapshotSha256 } from "../../src/project/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function profile(revision = 1, profileId = "team-demo") {
  const clean = builtInRecordingProfiles().at(0);
  if (clean === undefined) throw new Error("clean profile is missing");
  const snapshot = {
    ...clean.snapshot,
    output: { ...clean.snapshot.output, quality: "high" as const },
  };
  return {
    source: "owner-local" as const,
    profileId,
    profileRevision: revision,
    snapshot,
    snapshotSha256: profileSnapshotSha256(snapshot),
  };
}

describe("owner-local recording profile storage", () => {
  it("creates, lists summaries, resolves profiles, and atomically updates by CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-profiles-"));
    roots.push(root);
    const store = new RecordingProfileStore(root, "owner-1");
    const created = await store.create(profile());
    expect(await store.list()).toEqual([
      {
        profileId: "team-demo",
        profileRevision: 1,
        snapshotSha256: created.snapshotSha256,
      },
    ]);
    expect((await store.load("team-demo")).snapshot).toEqual(created.snapshot);
    const next = profile(2);
    await expect(
      store.update(next, { expectedRevision: 1, expectedSnapshotSha256: created.snapshotSha256 }),
    ).resolves.toMatchObject({ profileRevision: 2 });
    await expect(
      store.update(profile(3), {
        expectedRevision: 1,
        expectedSnapshotSha256: created.snapshotSha256,
      }),
    ).rejects.toThrow(/compare|changed/i);
  });

  it("rejects built-ins, owner crossover, unsafe roots, and concurrent replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-profiles-"));
    roots.push(root);
    const first = new RecordingProfileStore(root, "owner-1");
    const second = new RecordingProfileStore(root, "owner-1");
    await expect(first.create(builtInRecordingProfiles().at(0))).rejects.toThrow(/read-only/i);
    const results = await Promise.allSettled([first.create(profile()), second.create(profile())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(new RecordingProfileStore(root, "owner-2").load("team-demo")).rejects.toThrow(
      /owned/i,
    );
    await chmod(root, 0o755);
    await expect(first.list()).rejects.toThrow(/private/i);
  });

  it("fails closed for symlinked storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-profiles-"));
    const outside = await mkdtemp(join(tmpdir(), "recordly-profile-outside-"));
    roots.push(root, outside);
    const store = new RecordingProfileStore(root, "owner-1");
    await store.create(profile());
    await rm(join(root, "profiles"), { recursive: true });
    await symlink(outside, join(root, "profiles"));
    await expect(store.list()).rejects.toThrow(/private|symbolic|escape/i);
  });

  it("enforces the owner-local profile limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-profiles-"));
    roots.push(root);
    const store = new RecordingProfileStore(root, "owner-1");
    for (let index = 0; index < 32; index += 1) {
      await store.create(profile(1, `team-${index}`));
    }
    await expect(store.create(profile(1, "team-overflow"))).rejects.toThrow(/limit/i);
  });

  it("does not let concurrent distinct profile creates exceed the global limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-profiles-"));
    roots.push(root);
    const first = new RecordingProfileStore(root, "owner-1");
    const second = new RecordingProfileStore(root, "owner-1");
    for (let index = 0; index < 31; index += 1) await first.create(profile(1, `team-${index}`));
    const results = await Promise.allSettled([
      first.create(profile(1, "team-31")),
      second.create(profile(1, "team-32")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await first.list()).toHaveLength(32);
  });
});
