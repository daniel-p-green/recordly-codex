import { randomUUID } from "node:crypto";
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
import {
  type RecordingProfileReference,
  validateRecordingProfileReference,
} from "../src/project/index.js";
import { isContainedPath } from "../src/safe/path.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digest = /^[a-f0-9]{64}$/iu;
const MAX_PROFILES = 32;
const MAX_LOCK_ATTEMPTS = 40;

export type RecordingProfileSummary = Pick<
  RecordingProfileReference,
  "profileId" | "profileRevision" | "snapshotSha256"
>;

export type ExpectedRecordingProfileVersion = {
  expectedRevision: number;
  expectedSnapshotSha256: string;
};

type Envelope = { schemaVersion: 1; ownerToken: string; profile: RecordingProfileReference };
type Lock = { token: string };

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST"
  );
}

function safeProfileId(profileId: string): void {
  if (!identifier.test(profileId)) throw new RangeError("profile ID must be a safe identifier");
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new RangeError("persisted profile must be an object");
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
    throw new RangeError("persisted profile envelope has an invalid shape");
  }
}

function field(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

/** Private owner-local profile persistence. Built-ins are resolved in memory and never stored. */
export class RecordingProfileStore {
  private readonly root: string;

  public constructor(
    artifactRoot: string,
    private readonly ownerToken: string,
  ) {
    if (!isAbsolute(artifactRoot) || artifactRoot === "/" || ownerToken.length === 0)
      throw new RangeError("profile storage root is invalid");
    this.root = resolve(artifactRoot);
  }

  public async create(value: unknown): Promise<RecordingProfileReference> {
    const profile = this.ownerLocal(value);
    if (profile.profileRevision !== 1)
      throw new RangeError("new profiles must start at revision 1");
    await this.ensureRoot();
    const path = this.pathFor(profile.profileId);
    return this.withCreateLock(() =>
      this.withLock(profile.profileId, async () => {
        if ((await this.list()).length >= MAX_PROFILES)
          throw new RangeError("profile limit reached");
        await this.writeNew(path, profile);
        return profile;
      }),
    );
  }

  public async load(profileId: string): Promise<RecordingProfileReference> {
    safeProfileId(profileId);
    await this.ensureRoot();
    const path = this.pathFor(profileId);
    await this.assertPrivateRegularFile(path);
    const envelope = this.envelope(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (envelope.ownerToken !== this.ownerToken || envelope.profile.profileId !== profileId)
      throw new RangeError("profile is not owned by this artifact root");
    return envelope.profile;
  }

  public async list(): Promise<RecordingProfileSummary[]> {
    await this.ensureRoot();
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.profilesRoot(), { withFileTypes: true });
    const profiles: RecordingProfileSummary[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new RangeError("profile store contains unsafe entry");
      const profileId = entry.name.slice(0, -5);
      const profile = await this.load(profileId);
      profiles.push({
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        snapshotSha256: profile.snapshotSha256,
      });
    }
    return profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  public async update(
    value: unknown,
    expected: ExpectedRecordingProfileVersion,
  ): Promise<RecordingProfileReference> {
    const profile = this.ownerLocal(value);
    if (
      !Number.isSafeInteger(expected.expectedRevision) ||
      expected.expectedRevision < 1 ||
      typeof expected.expectedSnapshotSha256 !== "string" ||
      !digest.test(expected.expectedSnapshotSha256)
    ) {
      throw new RangeError("expected profile version is invalid");
    }
    await this.ensureRoot();
    const path = this.pathFor(profile.profileId);
    return this.withLock(profile.profileId, async () => {
      const current = await this.load(profile.profileId);
      if (
        current.profileRevision !== expected.expectedRevision ||
        current.snapshotSha256 !== expected.expectedSnapshotSha256.toLowerCase() ||
        profile.profileRevision !== current.profileRevision + 1
      ) {
        throw new RangeError("profile changed before compare-and-swap replacement");
      }
      await this.write(path, profile);
      return profile;
    });
  }

  private ownerLocal(value: unknown): RecordingProfileReference {
    const profile = validateRecordingProfileReference(value);
    if (profile.source !== "owner-local") throw new RangeError("built-in profiles are read-only");
    return profile;
  }

  private profilesRoot(): string {
    return join(this.root, "profiles");
  }

  private pathFor(profileId: string): string {
    safeProfileId(profileId);
    const candidate = resolve(this.profilesRoot(), `${profileId}.json`);
    if (!isContainedPath(this.profilesRoot(), candidate))
      throw new RangeError("profile path escapes root");
    return candidate;
  }

  private lockPathFor(profileId: string): string {
    return `${this.pathFor(profileId)}.lock`;
  }

  private async withCreateLock<T>(work: () => Promise<T>): Promise<T> {
    const path = join(this.profilesRoot(), ".create.lock");
    const lock = await this.acquireLock(path);
    try {
      return await work();
    } finally {
      await this.releaseLock(path, lock);
    }
  }

  private async withLock<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    const path = this.lockPathFor(profileId);
    const lock = await this.acquireLock(path);
    try {
      return await work();
    } finally {
      await this.releaseLock(path, lock);
    }
  }

  private async acquireLock(path: string): Promise<Lock> {
    const lock = { token: randomUUID() };
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
      try {
        await writeFile(path, `${canonicalJson(lock)}\n`, { mode: FILE_MODE, flag: "wx" });
        await this.assertPrivateRegularFile(path);
        return lock;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    }
    throw new RangeError("profile lock is unavailable");
  }

  private async releaseLock(path: string, lock: Lock): Promise<void> {
    try {
      await this.assertPrivateRegularFile(path);
      const value = object(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (field(value, "token") === lock.token) await unlink(path);
    } catch {
      // A failed best-effort lock release must not hide the completed operation.
    }
  }

  private envelope(value: unknown): Envelope {
    const record = object(value);
    exact(record, ["schemaVersion", "ownerToken", "profile"]);
    if (field(record, "schemaVersion") !== 1 || typeof field(record, "ownerToken") !== "string")
      throw new RangeError("persisted profile envelope is invalid");
    const profile = this.ownerLocal(field(record, "profile"));
    return { schemaVersion: 1, ownerToken: field(record, "ownerToken") as string, profile };
  }

  private async ensureRoot(): Promise<void> {
    const rootStatus = await lstat(this.root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || (rootStatus.mode & 0o077) !== 0)
      throw new RangeError("artifact root is not a private directory");
    const artifactRoot = await realpath(this.root);
    const profiles = this.profilesRoot();
    await mkdir(profiles, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(profiles, DIRECTORY_MODE);
    const status = await lstat(profiles);
    if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0)
      throw new RangeError("profile directory is not private");
    if (!isContainedPath(artifactRoot, await realpath(profiles)))
      throw new RangeError("profile directory escapes artifact root");
  }

  private async assertPrivateRegularFile(path: string): Promise<void> {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0)
      throw new RangeError("profile must be a private regular file");
    if (!isContainedPath(await realpath(this.profilesRoot()), await realpath(path)))
      throw new RangeError("profile path escapes storage root");
  }

  private async write(path: string, profile: RecordingProfileReference): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(this.stored(profile))}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    });
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await chmod(path, FILE_MODE);
    await this.assertPrivateRegularFile(path);
  }

  private async writeNew(path: string, profile: RecordingProfileReference): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(this.stored(profile))}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if (isAlreadyExists(error)) throw new RangeError("profile already exists");
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await chmod(path, FILE_MODE);
    await this.assertPrivateRegularFile(path);
  }

  private stored(profile: RecordingProfileReference): Envelope {
    return { schemaVersion: 1, ownerToken: this.ownerToken, profile };
  }
}
