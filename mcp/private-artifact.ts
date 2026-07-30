import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { isContainedPath, isSafeRelativePath } from "../src/safe/path.js";

const FILE_MODE = 0o600;
const CHUNK_BYTES = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

type FileIdentity = { dev: number; ino: number; size: number };
type DirectoryIdentity = { path: string; dev: number; ino: number };
type DestinationWrite = (
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  offset: number,
  length: number,
) => Promise<number>;

export type PrivateArtifactDigest = {
  sha256: string;
  byteLength: number;
};

export type PrivateArtifactInput = {
  root: string;
  relativePath: string;
  maximumBytes: number;
  expectedSha256?: string;
  /** Test-only barrier after identity snapshots and before opening the artifact. */
  openBarrier?: () => Promise<void>;
};

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function identity(status: { dev: number; ino: number; size: number }): FileIdentity {
  return { dev: status.dev, ino: status.ino, size: status.size };
}

async function privateDirectory(path: string, root: string, label: string): Promise<string> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError(`${label} must be a private non-symlink directory`);
  }
  const resolved = await realpath(path);
  if (path !== root && !isContainedPath(root, resolved)) {
    throw new RangeError(`${label} escapes private artifact root`);
  }
  return resolved;
}

async function privateDirectoryIdentity(
  path: string,
  root: string,
  label: string,
): Promise<DirectoryIdentity> {
  await privateDirectory(path, root, label);
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new RangeError(`${label} changed before stable read`);
  }
  return { path, dev: status.dev, ino: status.ino };
}

async function assertStableDirectories(identities: readonly DirectoryIdentity[]): Promise<void> {
  for (const expected of identities) {
    const current = await lstat(expected.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new RangeError("private artifact ancestor changed before stable read");
    }
  }
}

async function openPrivateArtifact(input: PrivateArtifactInput) {
  if (
    !isAbsolute(input.root) ||
    input.root === "/" ||
    !isSafeRelativePath(input.relativePath) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    (input.expectedSha256 !== undefined && !sha256Pattern.test(input.expectedSha256))
  ) {
    throw new RangeError("private artifact input is invalid");
  }
  const root = resolve(input.root);
  const rootIdentity = await privateDirectoryIdentity(root, root, "artifact root");
  const rootResolved = await realpath(root);
  const path = resolve(rootResolved, input.relativePath);
  if (!isContainedPath(rootResolved, path)) throw new RangeError("private artifact escapes root");
  let ancestor = rootResolved;
  const ancestors = [rootIdentity];
  for (const segment of input.relativePath.split("/").slice(0, -1)) {
    ancestor = join(ancestor, segment);
    ancestors.push(await privateDirectoryIdentity(ancestor, rootResolved, "artifact directory"));
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new RangeError("private artifact must be a private non-symlink regular file");
  }
  if (before.size > input.maximumBytes) throw new RangeError("private artifact exceeds byte limit");
  await input.openBarrier?.();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameIdentity(identity(before), identity(opened)) ||
      !sameIdentity(identity(opened), identity(after))
    ) {
      throw new RangeError("private artifact changed before stable read");
    }
    await assertStableDirectories(ancestors);
    return { handle, path, opened: identity(opened) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  writer: DestinationWrite,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const bytesWritten = await writer(handle, bytes, written, bytes.length - written);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten < 1 ||
      bytesWritten > bytes.length - written
    ) {
      throw new RangeError("private artifact destination made no bounded write progress");
    }
    written += bytesWritten;
  }
}

/** Hashes a private file from a stable descriptor and rejects path replacement or digest mismatch. */
export async function digestPrivateArtifact(
  input: PrivateArtifactInput,
): Promise<PrivateArtifactDigest> {
  const opened = await openPrivateArtifact(input);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < opened.opened.size) {
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new RangeError("private artifact changed during stable read");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const current = await lstat(opened.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(opened.opened, identity(current))
    ) {
      throw new RangeError("private artifact changed during stable read");
    }
    const sha256 = hash.digest("hex");
    if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
      throw new RangeError("private artifact digest does not match expected inspection evidence");
    }
    return { sha256, byteLength: position };
  } finally {
    await opened.handle.close();
  }
}

/** Copies and hashes the same stable private descriptor so decoders never reopen a predictable render path. */
export async function copyPrivateArtifact(
  input: PrivateArtifactInput & { destinationPath: string; destinationWrite?: DestinationWrite },
): Promise<PrivateArtifactDigest> {
  const opened = await openPrivateArtifact(input);
  if (!isAbsolute(input.destinationPath)) {
    await opened.handle.close();
    throw new RangeError("private artifact destination is invalid");
  }
  const destination = await open(
    input.destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    const write =
      input.destinationWrite ??
      (async (handle, bytes, offset, length) =>
        (await handle.write(bytes, offset, length)).bytesWritten);
    while (position < opened.opened.size) {
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new RangeError("private artifact changed during stable read");
      await writeAll(destination, buffer.subarray(0, bytesRead), write);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const current = await lstat(opened.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(opened.opened, identity(current))
    ) {
      throw new RangeError("private artifact changed during stable read");
    }
    const sha256 = hash.digest("hex");
    if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
      throw new RangeError("private artifact digest does not match expected inspection evidence");
    }
    await chmod(input.destinationPath, FILE_MODE);
    return { sha256, byteLength: position };
  } catch (error) {
    await destination.close().catch(() => undefined);
    await unlink(input.destinationPath).catch(() => undefined);
    throw error;
  } finally {
    await opened.handle.close();
    await destination.close().catch(() => undefined);
  }
}

/** Reads a small generated inspection image through the same private boundary. */
export async function readPrivateArtifact(
  input: PrivateArtifactInput,
): Promise<{ bytes: Buffer } & PrivateArtifactDigest> {
  const opened = await openPrivateArtifact(input);
  try {
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < opened.opened.size) {
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new RangeError("private artifact changed during stable read");
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(chunk);
      hash.update(chunk);
      position += bytesRead;
    }
    const current = await lstat(opened.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(opened.opened, identity(current))
    ) {
      throw new RangeError("private artifact changed during stable read");
    }
    const sha256 = hash.digest("hex");
    if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
      throw new RangeError("private artifact digest does not match expected inspection evidence");
    }
    return { bytes: Buffer.concat(chunks), sha256, byteLength: position };
  } finally {
    await opened.handle.close();
  }
}
