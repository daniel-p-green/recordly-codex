// biome-ignore-all lint/complexity/useLiteralKeys: persisted project data is untrusted dictionary data.

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "../src/manifest/index.js";
import { type RecordingProject, validateRecordingProject } from "../src/project/index.js";
import { isContainedPath } from "../src/safe/path.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digest = /^[a-f0-9]{64}$/u;
const MAX_LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 5;

export type StoredRecordingProject = {
  project: RecordingProject;
  sha256: string;
};

export type ExpectedRecordingProjectVersion = {
  expectedRevision: number;
  expectedSha256: string;
};

type StoredEnvelope = {
  schemaVersion: 1;
  ownerToken: string;
  projectSha256: string;
  project: RecordingProject;
};

type ProjectLock = { token: string };

function projectDigest(project: RecordingProject): string {
  return createHash("sha256").update(canonicalJson(project)).digest("hex");
}

function safeProjectId(projectId: string): void {
  if (!identifier.test(projectId)) throw new RangeError("project ID must be a safe identifier");
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function waitForLock(): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, LOCK_RETRY_MS));
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new RangeError("persisted project must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.getOwnPropertyNames(value).some((field) => !fields.includes(field))
  ) {
    throw new RangeError("persisted project envelope has an invalid shape");
  }
}

/** Private, owner-bound canonical project storage under the configured artifact root. */
export class RecordingProjectStore {
  private readonly root: string;

  public constructor(
    artifactRoot: string,
    private readonly ownerToken: string,
  ) {
    if (!isAbsolute(artifactRoot) || artifactRoot === "/" || ownerToken.length === 0) {
      throw new RangeError("project storage root is invalid");
    }
    this.root = resolve(artifactRoot);
  }

  public async create(value: unknown): Promise<StoredRecordingProject> {
    const project = validateRecordingProject(value);
    const path = this.pathFor(project.projectId);
    await this.ensureProjectsRoot();
    return this.withProjectLock(project.projectId, async () => {
      await this.writeNew(path, project);
      return { project, sha256: projectDigest(project) };
    });
  }

  public async load(projectId: string): Promise<StoredRecordingProject> {
    safeProjectId(projectId);
    await this.ensureProjectsRoot();
    const path = this.pathFor(projectId);
    await this.assertPrivateRegularFile(path);
    const parsed = object(JSON.parse(await readFile(path, "utf8")) as unknown);
    exact(parsed, ["schemaVersion", "ownerToken", "projectSha256", "project"]);
    if (parsed["schemaVersion"] !== 1 || parsed["ownerToken"] !== this.ownerToken) {
      throw new RangeError("project is not owned by this artifact root");
    }
    if (typeof parsed["projectSha256"] !== "string" || !digest.test(parsed["projectSha256"])) {
      throw new RangeError("persisted project digest is invalid");
    }
    const project = validateRecordingProject(parsed["project"]);
    if (project.projectId !== projectId)
      throw new RangeError("project identity does not match storage");
    const sha256 = projectDigest(project);
    if (sha256 !== parsed["projectSha256"].toLowerCase()) {
      throw new RangeError("persisted project digest does not match");
    }
    return { project, sha256 };
  }

  public async replace(
    value: unknown,
    expected: ExpectedRecordingProjectVersion,
  ): Promise<StoredRecordingProject> {
    const project = validateRecordingProject(value);
    const path = this.pathFor(project.projectId);
    await this.ensureProjectsRoot();
    return this.withProjectLock(project.projectId, async () => {
      const current = await this.load(project.projectId);
      if (
        current.project.revision !== expected.expectedRevision ||
        current.sha256 !== expected.expectedSha256
      ) {
        throw new RangeError("project changed before compare-and-swap replacement");
      }
      await this.write(path, project);
      return { project, sha256: projectDigest(project) };
    });
  }

  private projectsRoot(): string {
    return join(this.root, "projects");
  }

  private pathFor(projectId: string): string {
    safeProjectId(projectId);
    const candidate = resolve(this.projectsRoot(), `${projectId}.json`);
    if (!isContainedPath(this.projectsRoot(), candidate))
      throw new RangeError("project path escapes root");
    return candidate;
  }

  private lockPathFor(projectId: string): string {
    const projectPath = this.pathFor(projectId);
    return `${projectPath}.lock`;
  }

  private async withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPathFor(projectId);
    const lock = await this.acquireProjectLock(lockPath);
    try {
      return await work();
    } finally {
      await this.releaseProjectLock(lockPath, lock);
    }
  }

  private async acquireProjectLock(path: string): Promise<ProjectLock> {
    const lock: ProjectLock = { token: randomUUID() };
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
      try {
        await writeFile(path, `${canonicalJson(lock)}\n`, { mode: FILE_MODE, flag: "wx" });
        await this.assertPrivateRegularFile(path);
        return lock;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await waitForLock();
      }
    }
    throw new RangeError("project lock is unavailable");
  }

  private async releaseProjectLock(path: string, lock: ProjectLock): Promise<void> {
    try {
      await this.assertPrivateRegularFile(path);
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        value !== null &&
        typeof value === "object" &&
        (value as { token?: unknown }).token === lock.token
      ) {
        await unlink(path);
      }
    } catch (error) {
      if (!isAlreadyExists(error)) return;
    }
  }

  private async ensureProjectsRoot(): Promise<void> {
    const rootStatus = await lstat(this.root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw new RangeError("artifact root is not a private directory");
    }
    const rootResolved = await realpath(this.root);
    const projects = this.projectsRoot();
    await mkdir(projects, { recursive: true, mode: DIRECTORY_MODE });
    const status = await lstat(projects);
    if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RangeError("project directory is not private");
    }
    const resolved = await realpath(projects);
    if (!isContainedPath(rootResolved, resolved)) {
      throw new RangeError("project directory escapes artifact root");
    }
    await chmod(resolved, DIRECTORY_MODE);
    const privateStatus = await lstat(resolved);
    if (
      !privateStatus.isDirectory() ||
      privateStatus.isSymbolicLink() ||
      (privateStatus.mode & 0o077) !== 0
    ) {
      throw new RangeError("project directory is not private");
    }
  }

  private async assertPrivateRegularFile(path: string): Promise<void> {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RangeError("project must be a private regular file");
    }
    const root = await realpath(this.projectsRoot());
    const resolved = await realpath(path);
    if (!isContainedPath(root, resolved)) {
      throw new RangeError("project path escapes storage root");
    }
  }

  private async write(path: string, project: RecordingProject): Promise<void> {
    const envelope: StoredEnvelope = {
      schemaVersion: 1,
      ownerToken: this.ownerToken,
      projectSha256: projectDigest(project),
      project,
    };
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(envelope)}\n`, { mode: FILE_MODE, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, FILE_MODE);
    await this.assertPrivateRegularFile(path);
  }

  private async writeNew(path: string, project: RecordingProject): Promise<void> {
    const envelope: StoredEnvelope = {
      schemaVersion: 1,
      ownerToken: this.ownerToken,
      projectSha256: projectDigest(project),
      project,
    };
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(envelope)}\n`, { mode: FILE_MODE, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "EEXIST"
      ) {
        throw new RangeError("project already exists");
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await chmod(path, FILE_MODE);
    await this.assertPrivateRegularFile(path);
  }
}
