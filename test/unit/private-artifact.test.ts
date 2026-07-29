import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyPrivateArtifact, digestPrivateArtifact } from "../../mcp/private-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private artifact boundary", () => {
  it("rejects a symlinked predictable artifact path without reading its target", async () => {
    const root = await privateRoot();
    const external = await mkdtemp(join(tmpdir(), "recordly-private-artifact-external-"));
    roots.push(external);
    await writeFile(join(external, "outside.mp4"), "outside", { mode: 0o600 });
    await symlink(join(external, "outside.mp4"), join(root, "projects", "renders", "preview.mp4"));

    await expect(
      digestPrivateArtifact({
        root,
        relativePath: "projects/renders/preview.mp4",
        maximumBytes: 1024,
      }),
    ).rejects.toThrow(/symlink|private/i);
  });

  it("rejects a symlinked artifact ancestor even when its target remains under the private root", async () => {
    const root = await privateRoot();
    const renders = join(root, "renders-target");
    await mkdir(renders, { mode: 0o700 });
    await chmod(renders, 0o700);
    await writeFile(join(renders, "preview.mp4"), "inside", { mode: 0o600 });
    await rm(join(root, "projects", "renders"), { recursive: true });
    await symlink(renders, join(root, "projects", "renders"));

    await expect(
      digestPrivateArtifact({
        root,
        relativePath: "projects/renders/preview.mp4",
        maximumBytes: 1024,
      }),
    ).rejects.toThrow(/symlink|private/i);
  });

  it("rejects a coordinated artifact-ancestor swap before opening the predictable file", async () => {
    const root = await privateRoot();
    const renders = join(root, "projects", "renders");
    const preservedRenders = join(root, "projects", "renders-original");
    const outside = await mkdtemp(join(tmpdir(), "recordly-private-artifact-outside-"));
    roots.push(outside);
    await writeFile(join(renders, "preview.mp4"), "inside", { mode: 0o600 });
    await writeFile(join(outside, "preview.mp4"), "outside", { mode: 0o600 });
    let reachedBarrier!: () => void;
    let releaseBarrier!: () => void;
    const reached = new Promise<void>((resolveReached) => {
      reachedBarrier = resolveReached;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseBarrier = resolveRelease;
    });
    const pending = digestPrivateArtifact({
      root,
      relativePath: "projects/renders/preview.mp4",
      maximumBytes: 1024,
      openBarrier: async () => {
        reachedBarrier();
        await release;
      },
    });
    await reached;
    await rename(renders, preservedRenders);
    await symlink(outside, renders);
    releaseBarrier();

    await expect(pending).rejects.toThrow(/ancestor|artifact|stable/i);
  });

  it("rejects a replacement artifact when its inspection digest is bound", async () => {
    const root = await privateRoot();
    const path = join(root, "projects", "renders", "preview.mp4");
    await writeFile(path, "first-preview", { mode: 0o600 });
    const first = await digestPrivateArtifact({
      root,
      relativePath: "projects/renders/preview.mp4",
      maximumBytes: 1024,
    });
    await rm(path);
    await writeFile(path, "replacement-preview", { mode: 0o600 });

    await expect(
      digestPrivateArtifact({
        root,
        relativePath: "projects/renders/preview.mp4",
        maximumBytes: 1024,
        expectedSha256: first.sha256,
      }),
    ).rejects.toThrow(/expected inspection evidence/i);
  });

  it("completes controlled short destination writes without truncating the copied artifact", async () => {
    const root = await privateRoot();
    const source = Buffer.alloc(70_000, 0x5a);
    await writeFile(join(root, "projects", "renders", "preview.mp4"), source, { mode: 0o600 });
    const destination = join(root, "copy.mp4");

    const copied = await copyPrivateArtifact({
      root,
      relativePath: "projects/renders/preview.mp4",
      maximumBytes: 100_000,
      destinationPath: destination,
      destinationWrite: async (handle, bytes, offset, length) =>
        (await handle.write(bytes, offset, Math.min(length, 7))).bytesWritten,
    });

    expect(copied.byteLength).toBe(source.length);
    expect(await readFile(destination)).toEqual(source);
  });
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recordly-private-artifact-"));
  roots.push(root);
  await chmod(root, 0o700);
  await mkdir(join(root, "projects", "renders"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "projects"), 0o700);
  await chmod(join(root, "projects", "renders"), 0o700);
  return root;
}
