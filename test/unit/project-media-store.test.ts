import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectMediaStore,
  type ImportedProjectVisualMedia,
} from "../../mcp/project-media-store.js";

const roots: string[] = [];
const ownerToken = "private-owner-token";
const mediaId = "media_0123456789abcdef0123456789abcdef";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recordly-project-media-store-"));
  roots.push(root);
  return root;
}

function media(sha256: string): ImportedProjectVisualMedia {
  return {
    mediaId,
    sha256,
    mediaKind: "image",
    extension: "png",
    durationUs: 1,
    width: 4,
    height: 2,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private project media registry", () => {
  it("accepts an identical repeat save as an idempotent read", async () => {
    const store = new ProjectMediaStore(await temporaryRoot(), ownerToken);
    const first = media("a".repeat(64));

    await expect(store.save(first)).resolves.toEqual(first);
    await expect(store.save(first)).resolves.toEqual(first);
    await expect(store.load(mediaId)).resolves.toEqual(first);
  });

  it("rejects conflicting metadata for the same media ID without replacing the first record", async () => {
    const store = new ProjectMediaStore(await temporaryRoot(), ownerToken);
    const first = media("a".repeat(64));
    const conflict = media("b".repeat(64));

    await store.save(first);
    await expect(store.save(conflict)).rejects.toThrow(/conflict|immutable|already/i);
    await expect(store.load(mediaId)).resolves.toEqual(first);
  });

  it("commits exactly one immutable record when conflicting saves race", async () => {
    const store = new ProjectMediaStore(await temporaryRoot(), ownerToken);
    const first = media("a".repeat(64));
    const conflict = media("b".repeat(64));

    const results = await Promise.allSettled([store.save(first), store.save(conflict)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(store.load(mediaId)).resolves.toEqual(
      results[0]?.status === "fulfilled" ? first : conflict,
    );
  });
});
