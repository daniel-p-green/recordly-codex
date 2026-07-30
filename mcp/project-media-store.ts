// biome-ignore-all lint/complexity/useLiteralKeys: persisted private media records are untrusted data.

import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "../src/manifest/index.js";
import type { InspectedVisualMedia } from "../src/media/private-visual-raster.js";
import { isContainedPath } from "../src/safe/path.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const mediaId = /^media_[a-f0-9]{32}$/u;
const digest = /^[a-f0-9]{64}$/u;

export type ImportedProjectVisualMedia = Pick<
  InspectedVisualMedia,
  "mediaId" | "sha256" | "mediaKind" | "extension" | "durationUs" | "width" | "height" | "fps"
>;

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new RangeError("private media record must be an object");
  }
  return value as Record<string, unknown>;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function validMedia(value: unknown): ImportedProjectVisualMedia {
  const media = object(value);
  const isVideo = media["mediaKind"] === "video";
  const fields = isVideo
    ? ["mediaId", "sha256", "mediaKind", "extension", "durationUs", "width", "height", "fps"]
    : ["mediaId", "sha256", "mediaKind", "extension", "durationUs", "width", "height"];
  if (
    Object.keys(media).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(media, field)) ||
    Object.keys(media).some((field) => !fields.includes(field)) ||
    typeof media["mediaId"] !== "string" ||
    !mediaId.test(media["mediaId"]) ||
    typeof media["sha256"] !== "string" ||
    !digest.test(media["sha256"]) ||
    (media["mediaKind"] !== "image" && media["mediaKind"] !== "video") ||
    typeof media["extension"] !== "string" ||
    !["gif", "jpg", "png", "ppm", "webp", "mov", "mp4", "webm"].includes(media["extension"]) ||
    !Number.isSafeInteger(media["durationUs"]) ||
    (media["durationUs"] as number) < 1 ||
    !Number.isSafeInteger(media["width"]) ||
    (media["width"] as number) < 2 ||
    !Number.isSafeInteger(media["height"]) ||
    (media["height"] as number) < 2 ||
    (isVideo &&
      (typeof media["fps"] !== "number" ||
        !Number.isFinite(media["fps"]) ||
        (media["fps"] as number) <= 0 ||
        (media["fps"] as number) > 60))
  ) {
    throw new RangeError("private media record is invalid");
  }
  return media as ImportedProjectVisualMedia;
}

/** Owner-bound metadata that maps opaque imported media IDs to decoded facts. */
export class ProjectMediaStore {
  private readonly root: string;

  public constructor(
    artifactRoot: string,
    private readonly ownerToken: string,
  ) {
    if (!isAbsolute(artifactRoot) || artifactRoot === "/" || ownerToken.length === 0) {
      throw new RangeError("private media store root is invalid");
    }
    this.root = resolve(artifactRoot);
  }

  public async save(media: ImportedProjectVisualMedia): Promise<ImportedProjectVisualMedia> {
    const parsed = validMedia(media);
    await this.ensureRoot();
    const path = this.pathFor(parsed.mediaId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${canonicalJson({ schemaVersion: 1, ownerToken: this.ownerToken, media: parsed })}\n`,
      { mode: FILE_MODE, flag: "wx" },
    );
    try {
      await link(temporary, path);
      await chmod(path, FILE_MODE);
      return parsed;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const current = await this.load(parsed.mediaId);
      if (canonicalJson(current) !== canonicalJson(parsed)) {
        throw new RangeError("private media record conflicts with an immutable media ID");
      }
      return current;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  public async load(id: string): Promise<ImportedProjectVisualMedia> {
    if (!mediaId.test(id)) throw new RangeError("private media ID is invalid");
    await this.ensureRoot();
    const path = this.pathFor(id);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RangeError("private media record is unsafe");
    }
    const root = await realpath(this.mediaRoot());
    const resolved = await realpath(path);
    if (!isContainedPath(root, resolved))
      throw new RangeError("private media record escapes storage");
    const stored = object(JSON.parse(await readFile(resolved, "utf8")) as unknown);
    if (
      Object.keys(stored).length !== 3 ||
      stored["schemaVersion"] !== 1 ||
      stored["ownerToken"] !== this.ownerToken ||
      !Object.hasOwn(stored, "media")
    ) {
      throw new RangeError("private media record is not owned by this runtime");
    }
    const media = validMedia(stored["media"]);
    if (media.mediaId !== id) throw new RangeError("private media identity does not match storage");
    return media;
  }

  private mediaRoot(): string {
    return join(this.root, "private-media-records");
  }

  private pathFor(id: string): string {
    const path = resolve(this.mediaRoot(), `${id}.json`);
    if (!isContainedPath(this.mediaRoot(), path))
      throw new RangeError("private media path escapes storage");
    return path;
  }

  private async ensureRoot(): Promise<void> {
    const artifact = await lstat(this.root);
    if (!artifact.isDirectory() || artifact.isSymbolicLink() || (artifact.mode & 0o077) !== 0) {
      throw new RangeError("artifact root is not private");
    }
    const artifactRoot = await realpath(this.root);
    const mediaRoot = this.mediaRoot();
    await mkdir(mediaRoot, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(mediaRoot, DIRECTORY_MODE);
    const status = await lstat(mediaRoot);
    if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RangeError("private media directory is unsafe");
    }
    const resolved = await realpath(mediaRoot);
    if (!isContainedPath(artifactRoot, resolved))
      throw new RangeError("private media directory escapes root");
  }
}
