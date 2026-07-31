import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { isContainedPath } from "../safe/path.js";

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 2048;
const STREAM_CHUNK_BYTES = 64 * 1024;

const mediaExtensions = {
  gif: { extension: "gif", mediaKind: "image" },
  jpeg: { extension: "jpg", mediaKind: "image" },
  jpg: { extension: "jpg", mediaKind: "image" },
  m4a: { extension: "m4a", mediaKind: "audio" },
  mov: { extension: "mov", mediaKind: "video" },
  mp3: { extension: "mp3", mediaKind: "audio" },
  mp4: { extension: "mp4", mediaKind: "video" },
  png: { extension: "png", mediaKind: "image" },
  ppm: { extension: "ppm", mediaKind: "image" },
  wav: { extension: "wav", mediaKind: "audio" },
  webm: { extension: "webm", mediaKind: "video" },
  webp: { extension: "webp", mediaKind: "image" },
} as const;

export type ImportedMediaKind = (typeof mediaExtensions)[keyof typeof mediaExtensions]["mediaKind"];

export type ImportedMedia = {
  mediaId: string;
  sha256: string;
  byteLength: number;
  extension: string;
  mediaKind: ImportedMediaKind;
};

export type PrivateMediaLibrary = {
  ingest(input: {
    authorizedRoot: string;
    relativePath: string;
    maximumBytes: number;
  }): Promise<ImportedMedia>;
};

type StoredMediaMetadata = Omit<ImportedMedia, "mediaId"> & { schemaVersion: 1 };

function fail(message: string): never {
  throw new RangeError(`private media library: ${message}`);
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function canonicalDirectory(
  path: string,
  label: string,
  requirePrivate: boolean,
): Promise<string> {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  const status = await lstat(path).catch(() => fail(`${label} is unavailable`));
  if (status.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!status.isDirectory()) fail(`${label} must be a directory`);
  if (requirePrivate && !privateMode(status.mode)) fail(`${label} must be private`);
  return realpath(path);
}

async function privateChildDirectory(root: string, name: string): Promise<string> {
  const candidate = resolve(root, name);
  if (!isContainedPath(root, candidate)) fail("library child escaped its root");
  await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "EEXIST") throw error;
  });
  const status = await lstat(candidate);
  if (status.isSymbolicLink() || !status.isDirectory() || !privateMode(status.mode)) {
    fail("library child must be a private non-symlink directory");
  }
  const resolved = await realpath(candidate);
  if (!isContainedPath(root, resolved)) fail("library child escaped its root");
  return resolved;
}

function relativeSourcePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 512 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("source path contains traversal or invalid segments");
  }
  return path;
}

function mediaType(path: string): { extension: string; mediaKind: ImportedMediaKind } {
  const raw = extname(basename(path)).slice(1).toLowerCase();
  const resolved = mediaExtensions[raw as keyof typeof mediaExtensions];
  if (resolved === undefined) fail("source extension is unsupported");
  return resolved;
}

function maximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_IMPORT_BYTES) {
    fail("maximumBytes must be a bounded positive integer");
  }
  return value;
}

type SourceIdentity = {
  path: string;
  dev: number;
  ino: number;
  kind: "directory" | "file";
};

async function sourceIdentity(path: string, kind: SourceIdentity["kind"]): Promise<SourceIdentity> {
  const status = await lstat(path).catch(() =>
    fail("source path changed before it could be opened"),
  );
  if (
    status.isSymbolicLink() ||
    (kind === "directory" ? !status.isDirectory() : !status.isFile())
  ) {
    fail(
      kind === "directory"
        ? "source directory must be a non-symlink directory"
        : "source file must be a regular non-symlink file",
    );
  }
  return { path, dev: status.dev, ino: status.ino, kind };
}

function sameIdentity(
  status: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  identity: SourceIdentity,
): boolean {
  return (
    status.dev === identity.dev &&
    status.ino === identity.ino &&
    (identity.kind === "directory" ? status.isDirectory() : status.isFile())
  );
}

async function openedAuthorizedSource(input: {
  authorizedRoot: string;
  relativePath: string;
  maximumBytes: number;
  sourceOpenBarrier?: () => Promise<void>;
}): Promise<{ handle: Awaited<ReturnType<typeof open>>; media: ReturnType<typeof mediaType> }> {
  const root = await canonicalDirectory(input.authorizedRoot, "authorizedRoot", false);
  const relativePath = relativeSourcePath(input.relativePath);
  const segments = relativePath.split("/");
  const candidate = resolve(root, relativePath);
  if (!isContainedPath(root, candidate)) fail("source path escaped authorizedRoot");
  const ancestors = [await sourceIdentity(root, "directory")];
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = resolve(ancestor, segment);
    ancestors.push(await sourceIdentity(ancestor, "directory"));
  }
  const initial = await sourceIdentity(candidate, "file");
  const initialStatus = await lstat(candidate);
  if (initialStatus.size > input.maximumBytes) fail("source file exceeds maximumBytes");
  const resolved = await realpath(candidate);
  if (!isContainedPath(root, resolved)) fail("source path escaped authorizedRoot");
  await input.sourceOpenBarrier?.();
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail("source file could not be opened safely"),
  );
  try {
    const status = await handle.stat();
    if (!sameIdentity(status, initial))
      fail("source file changed before it could be opened safely");
    if (status.size > input.maximumBytes) fail("source file exceeds maximumBytes");
    for (const identity of ancestors) {
      const current = await lstat(identity.path).catch(() =>
        fail("source ancestor changed before it could be opened safely"),
      );
      if (current.isSymbolicLink() || !sameIdentity(current, identity)) {
        fail("source ancestor changed before it could be opened safely");
      }
    }
    const current = await lstat(candidate).catch(() =>
      fail("source file changed before it could be opened safely"),
    );
    if (current.isSymbolicLink() || !sameIdentity(current, initial)) {
      fail("source file changed before it could be opened safely");
    }
    return { handle, media: mediaType(relativePath) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written);
    written += result.bytesWritten;
  }
}

async function copyAndHash(
  source: Awaited<ReturnType<typeof open>>,
  temporaryPath: string,
  maximum: number,
): Promise<{ sha256: string; byteLength: number }> {
  const target = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maximum) fail("source file exceeds maximumBytes");
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      await writeAll(target, bytes);
    }
    await target.sync();
    return { sha256: digest.digest("hex"), byteLength: offset };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await target.close();
  }
}

async function hashExistingObject(
  path: string,
  maximum: number,
): Promise<{ sha256: string; byteLength: number }> {
  const status = await lstat(path).catch(() => fail("media object is unavailable"));
  if (status.isSymbolicLink() || !status.isFile()) fail("media object is not a regular file");
  if (status.size > maximum) fail("media object exceeds maximumBytes");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail("media object could not be opened safely"),
  );
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maximum) fail("media object exceeds maximumBytes");
      digest.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: digest.digest("hex"), byteLength: offset };
  } finally {
    await handle.close();
  }
}

async function readStoredMetadata(path: string): Promise<StoredMediaMetadata> {
  const status = await lstat(path).catch(() =>
    fail("media digest collision or metadata is unavailable"),
  );
  if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_METADATA_BYTES) {
    fail("media metadata is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail("media metadata could not be opened safely"),
  );
  try {
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail("media metadata was truncated");
      offset += bytesRead;
    }
    const value = JSON.parse(bytes.toString("utf8")) as Partial<StoredMediaMetadata>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      typeof value.byteLength !== "number" ||
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 0 ||
      typeof value.extension !== "string" ||
      !Object.values(mediaExtensions).some(
        (media) => media.extension === value.extension && media.mediaKind === value.mediaKind,
      )
    ) {
      fail("media metadata is invalid");
    }
    return value as StoredMediaMetadata;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function mediaId(sha256: string): string {
  return `media_${createHash("sha256").update("recordly-codex-media-id-v1\\0").update(sha256).digest("hex").slice(0, 32)}`;
}

function metadataBytes(value: StoredMediaMetadata): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function verifyStoredMedia(input: {
  objectPath: string;
  metadataPath: string;
  expected: StoredMediaMetadata;
  maximumBytes: number;
}): Promise<ImportedMedia> {
  const object = await hashExistingObject(input.objectPath, input.maximumBytes);
  const metadata = await readStoredMetadata(input.metadataPath);
  if (
    object.sha256 !== input.expected.sha256 ||
    object.byteLength !== input.expected.byteLength ||
    metadata.sha256 !== input.expected.sha256 ||
    metadata.byteLength !== input.expected.byteLength ||
    metadata.extension !== input.expected.extension ||
    metadata.mediaKind !== input.expected.mediaKind
  ) {
    fail("media digest collision or metadata mismatch");
  }
  const { schemaVersion: _schemaVersion, ...stored } = metadata;
  return { mediaId: mediaId(metadata.sha256), ...stored };
}

async function removePublishedObject(input: {
  objectPath: string;
  expected: StoredMediaMetadata;
  maximumBytes: number;
}): Promise<void> {
  const object = await hashExistingObject(input.objectPath, input.maximumBytes);
  if (object.sha256 !== input.expected.sha256 || object.byteLength !== input.expected.byteLength) {
    fail("media digest collision or metadata mismatch");
  }
  await unlink(input.objectPath);
}

export async function createPrivateMediaLibrary(input: {
  libraryRoot: string;
  /** Internal coordination seam for deterministic filesystem-race verification. */
  sourceOpenBarrier?: () => Promise<void>;
}): Promise<PrivateMediaLibrary> {
  const libraryRoot = await canonicalDirectory(input.libraryRoot, "libraryRoot", true);
  const objectsRoot = await privateChildDirectory(libraryRoot, "objects");

  return {
    async ingest(request): Promise<ImportedMedia> {
      const maximum = maximumBytes(request.maximumBytes);
      const source = await openedAuthorizedSource({
        ...request,
        maximumBytes: maximum,
        ...(input.sourceOpenBarrier === undefined
          ? {}
          : { sourceOpenBarrier: input.sourceOpenBarrier }),
      });
      const temporaryPath = resolve(objectsRoot, `.import-${randomUUID()}.tmp`);
      if (!isContainedPath(objectsRoot, temporaryPath)) fail("temporary object escaped its root");
      try {
        const copied = await copyAndHash(source.handle, temporaryPath, maximum);
        const expected: StoredMediaMetadata = {
          schemaVersion: 1,
          sha256: copied.sha256,
          byteLength: copied.byteLength,
          extension: source.media.extension,
          mediaKind: source.media.mediaKind,
        };
        const objectPath = resolve(objectsRoot, copied.sha256);
        const metadataPath = resolve(objectsRoot, `${copied.sha256}.json`);
        if (
          !isContainedPath(objectsRoot, objectPath) ||
          !isContainedPath(objectsRoot, metadataPath)
        ) {
          fail("digest object escaped its root");
        }
        const metadataTemporaryPath = resolve(objectsRoot, `.metadata-${randomUUID()}.tmp`);
        if (!isContainedPath(objectsRoot, metadataTemporaryPath))
          fail("temporary metadata escaped its root");
        let objectPublished = false;
        let metadataPublished = false;
        try {
          await link(temporaryPath, objectPath);
          objectPublished = true;
          await unlink(temporaryPath);
          await writeExclusive(metadataTemporaryPath, metadataBytes(expected));
          await link(metadataTemporaryPath, metadataPath);
          metadataPublished = true;
          await unlink(metadataTemporaryPath);
        } catch (error: unknown) {
          await unlink(metadataTemporaryPath).catch(() => undefined);
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
          await unlink(temporaryPath).catch(() => undefined);
          if (!objectPublished) {
            if (code !== "EEXIST") throw error;
          } else if (!metadataPublished) {
            try {
              return await verifyStoredMedia({
                objectPath,
                metadataPath,
                expected,
                maximumBytes: maximum,
              });
            } catch {
              await removePublishedObject({ objectPath, expected, maximumBytes: maximum });
              throw error;
            }
          }
        }
        return verifyStoredMedia({ objectPath, metadataPath, expected, maximumBytes: maximum });
      } finally {
        await source.handle.close();
        await unlink(temporaryPath).catch(() => undefined);
      }
    },
  };
}
