import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPrivateMediaLibrary } from "../../src/media/private-media-library.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private content-addressed media library", () => {
  it("rejects a coordinated authorized ancestor swap before opening the source", async () => {
    const root = await temporaryRoot("recordly-media-library-parent-swap-");
    const authorizedRoot = join(root, "authorized");
    const sourceParent = join(authorizedRoot, "nested");
    const originalParent = join(authorizedRoot, "nested-original");
    const outsideParent = join(root, "outside");
    const libraryRoot = join(root, "library");
    await Promise.all([
      mkdir(sourceParent, { recursive: true, mode: 0o700 }),
      mkdir(outsideParent, { mode: 0o700 }),
      mkdir(libraryRoot, { mode: 0o700 }),
    ]);
    await writeFile(join(sourceParent, "clip.mp4"), "authorized", { mode: 0o600 });
    await writeFile(join(outsideParent, "clip.mp4"), "outside", { mode: 0o600 });
    let reachedBarrier!: () => void;
    let releaseBarrier!: () => void;
    const reached = new Promise<void>((resolveReached) => {
      reachedBarrier = resolveReached;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseBarrier = resolveRelease;
    });
    const library = await createPrivateMediaLibrary({
      libraryRoot,
      sourceOpenBarrier: async () => {
        reachedBarrier();
        await release;
      },
    });
    const pending = library.ingest({
      authorizedRoot,
      relativePath: "nested/clip.mp4",
      maximumBytes: 1024,
    });
    await reached;
    await rename(sourceParent, originalParent);
    await symlink(outsideParent, sourceParent);
    releaseBarrier();

    await expect(pending).rejects.toThrow(/source|authorized|safe|changed/i);
  });

  it("ingests an authorized local file into a private digest object without retaining its source path", async () => {
    const root = await temporaryRoot("recordly-media-library-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    const bytes = Buffer.from("authorized local media bytes", "utf8");
    await writeFile(join(authorizedRoot, "demo.MP4"), bytes, { mode: 0o600 });
    const library = await createPrivateMediaLibrary({ libraryRoot });

    const first = await library.ingest({
      authorizedRoot,
      relativePath: "demo.MP4",
      maximumBytes: 1024,
    });
    const repeated = await library.ingest({
      authorizedRoot,
      relativePath: "demo.MP4",
      maximumBytes: 1024,
    });

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(first).toEqual({
      mediaId: expect.stringMatching(/^media_[a-f0-9]{32}$/u),
      sha256,
      byteLength: bytes.length,
      extension: "mp4",
      mediaKind: "video",
    });
    expect(repeated).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("demo.MP4");
    expect(JSON.stringify(first)).not.toContain(authorizedRoot);
    expect(await readFile(join(libraryRoot, "objects", sha256))).toEqual(bytes);
  });

  it("fails closed for traversal, symlinks, unsupported or oversized inputs, and a non-private library root", async () => {
    const root = await temporaryRoot("recordly-media-library-reject-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const publicRoot = join(root, "public-library");
    const escapedLibraryRoot = join(root, "escaped-library");
    const externalObjectsRoot = join(root, "external-objects");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await mkdir(publicRoot, { mode: 0o755 });
    await mkdir(escapedLibraryRoot, { mode: 0o700 });
    await mkdir(externalObjectsRoot, { mode: 0o700 });
    await symlink(externalObjectsRoot, join(escapedLibraryRoot, "objects"));
    await writeFile(join(authorizedRoot, "clip.wav"), "0123456789", { mode: 0o600 });
    await writeFile(join(root, "outside.mp4"), "outside", { mode: 0o600 });
    await symlink(join(root, "outside.mp4"), join(authorizedRoot, "linked.mp4"));
    await mkdir(join(authorizedRoot, "directory.mp4"), { mode: 0o700 });
    const library = await createPrivateMediaLibrary({ libraryRoot });

    await expect(
      library.ingest({ authorizedRoot, relativePath: "../outside.mp4", maximumBytes: 1024 }),
    ).rejects.toThrow(/traversal|escape/i);
    await expect(
      library.ingest({ authorizedRoot, relativePath: "linked.mp4", maximumBytes: 1024 }),
    ).rejects.toThrow(/symlink/i);
    await expect(
      library.ingest({ authorizedRoot, relativePath: "directory.mp4", maximumBytes: 1024 }),
    ).rejects.toThrow(/regular/i);
    await expect(
      library.ingest({ authorizedRoot, relativePath: "clip.wav", maximumBytes: 4 }),
    ).rejects.toThrow(/maximum/i);
    await writeFile(join(authorizedRoot, "unsupported.txt"), "nope", { mode: 0o600 });
    await expect(
      library.ingest({ authorizedRoot, relativePath: "unsupported.txt", maximumBytes: 1024 }),
    ).rejects.toThrow(/unsupported/i);
    await expect(createPrivateMediaLibrary({ libraryRoot: publicRoot })).rejects.toThrow(
      /private/i,
    );
    await expect(createPrivateMediaLibrary({ libraryRoot: escapedLibraryRoot })).rejects.toThrow(
      /symlink|escape/i,
    );
  });

  it("rejects a pre-existing digest object whose bytes or metadata do not match the authorized source", async () => {
    const root = await temporaryRoot("recordly-media-library-collision-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(join(libraryRoot, "objects"), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from("known content", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(authorizedRoot, "known.mp4"), bytes, { mode: 0o600 });
    await writeFile(join(libraryRoot, "objects", sha256), "tampered", { mode: 0o600 });
    const library = await createPrivateMediaLibrary({ libraryRoot });

    await expect(
      library.ingest({ authorizedRoot, relativePath: "known.mp4", maximumBytes: 1024 }),
    ).rejects.toThrow(/collision/i);
    await expect(access(join(libraryRoot, "objects", sha256))).resolves.toBeUndefined();
  });

  it("rolls back only its new digest object when metadata publication fails after content publication", async () => {
    const root = await temporaryRoot("recordly-media-library-metadata-failure-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(join(libraryRoot, "objects"), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from("metadata publication failure", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectPath = join(libraryRoot, "objects", sha256);
    const metadataPath = join(libraryRoot, "objects", `${sha256}.json`);
    await writeFile(join(authorizedRoot, "known.mp4"), bytes, { mode: 0o600 });
    await mkdir(metadataPath, { mode: 0o700 });
    const library = await createPrivateMediaLibrary({ libraryRoot });

    await expect(
      library.ingest({ authorizedRoot, relativePath: "known.mp4", maximumBytes: 1024 }),
    ).rejects.toThrow(/metadata|collision/i);
    await expect(access(objectPath)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(metadataPath, { recursive: true, force: true });
    await expect(
      library.ingest({ authorizedRoot, relativePath: "known.mp4", maximumBytes: 1024 }),
    ).resolves.toMatchObject({ sha256, byteLength: bytes.length });
  });
});
