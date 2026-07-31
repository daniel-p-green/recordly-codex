// biome-ignore-all lint/complexity/useLiteralKeys: untrusted persisted judgment dictionaries require exact key checks.

import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../src/manifest/index.js";
import { type PreviewJudgment, validatePreviewJudgment } from "../src/project/preview-judgment.js";
import { isContainedPath } from "../src/safe/path.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type JudgmentIdentity = Pick<
  PreviewJudgment,
  | "projectId"
  | "revision"
  | "projectSha256"
  | "renderInputSha256"
  | "previewArtifactSha256"
  | "renderRecipeSha256"
>;

type Envelope = { schemaVersion: 1; ownerToken: string; judgment: PreviewJudgment };

function sameIdentity(left: PreviewJudgment, right: JudgmentIdentity): boolean {
  return (
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.projectSha256 === right.projectSha256 &&
    left.renderInputSha256 === right.renderInputSha256 &&
    left.previewArtifactSha256 === right.previewArtifactSha256 &&
    left.renderRecipeSha256 === right.renderRecipeSha256
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST"
  );
}

/** Immutable, owner-bound preview verdicts. File names derive only from validated project identity. */
export class PreviewJudgmentStore {
  private readonly root: string;

  public constructor(
    artifactRoot: string,
    private readonly ownerToken: string,
  ) {
    if (!isAbsolute(artifactRoot) || artifactRoot === "/" || ownerToken.length === 0) {
      throw new RangeError("preview judgment root is invalid");
    }
    this.root = resolve(artifactRoot);
  }

  public async create(value: unknown): Promise<PreviewJudgment> {
    const judgment = validatePreviewJudgment(value);
    await this.ensureRoot();
    const path = this.pathFor(judgment.projectId, judgment.revision);
    const envelope: Envelope = { schemaVersion: 1, ownerToken: this.ownerToken, judgment };
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(envelope)}\n`, { mode: FILE_MODE, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if (isAlreadyExists(error)) throw new RangeError("preview judgment is immutable");
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await chmod(path, FILE_MODE);
    await this.assertPrivateRegularFile(path);
    return judgment;
  }

  public async load(projectId: string, revision: number): Promise<PreviewJudgment | undefined> {
    await this.ensureRoot();
    const path = this.pathFor(projectId, revision);
    try {
      await this.assertPrivateRegularFile(path);
      const envelope = this.envelope(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (
        envelope.ownerToken !== this.ownerToken ||
        envelope.judgment.projectId !== projectId ||
        envelope.judgment.revision !== revision
      ) {
        throw new RangeError("preview judgment is not owned by this artifact root");
      }
      return envelope.judgment;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  public async assertAccepted(identity: JudgmentIdentity): Promise<PreviewJudgment> {
    const judgment = await this.load(identity.projectId, identity.revision);
    if (
      judgment === undefined ||
      judgment.verdict !== "accept" ||
      !sameIdentity(judgment, identity)
    ) {
      throw new RangeError("matching accepted preview judgment is required");
    }
    return judgment;
  }

  private judgmentsRoot(): string {
    return join(this.root, "projects", "judgments");
  }

  private pathFor(projectId: string, revision: number): string {
    if (!identifier.test(projectId) || !Number.isSafeInteger(revision) || revision < 0) {
      throw new RangeError("preview judgment identity is invalid");
    }
    const candidate = resolve(this.judgmentsRoot(), `${projectId}-r${revision}.json`);
    if (!isContainedPath(this.judgmentsRoot(), candidate))
      throw new RangeError("preview judgment escapes root");
    return candidate;
  }

  private envelope(value: unknown): Envelope {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RangeError("persisted preview judgment is invalid");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.getOwnPropertyNames(record).length !== 3 ||
      !Object.hasOwn(record, "schemaVersion") ||
      !Object.hasOwn(record, "ownerToken") ||
      !Object.hasOwn(record, "judgment")
    ) {
      throw new RangeError("persisted preview judgment has an invalid shape");
    }
    if (record["schemaVersion"] !== 1) {
      throw new RangeError("persisted preview judgment envelope version is unsupported");
    }
    if (typeof record["ownerToken"] !== "string") {
      throw new RangeError("persisted preview judgment owner is invalid");
    }
    return {
      schemaVersion: 1,
      ownerToken: record["ownerToken"],
      judgment: validatePreviewJudgment(record["judgment"]),
    };
  }

  private async ensureRoot(): Promise<void> {
    const artifact = await lstat(this.root);
    if (!artifact.isDirectory() || artifact.isSymbolicLink()) {
      throw new RangeError("artifact root is not a private directory");
    }
    const artifactResolved = await realpath(this.root);
    const root = this.judgmentsRoot();
    await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(root, DIRECTORY_MODE);
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RangeError("preview judgment directory is not private");
    }
    if (!isContainedPath(artifactResolved, await realpath(root))) {
      throw new RangeError("preview judgment directory escapes artifact root");
    }
  }

  private async assertPrivateRegularFile(path: string): Promise<void> {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RangeError("preview judgment must be a private regular file");
    }
    if (!isContainedPath(await realpath(this.judgmentsRoot()), await realpath(path))) {
      throw new RangeError("preview judgment escapes storage root");
    }
  }
}
