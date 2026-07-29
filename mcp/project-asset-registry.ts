// biome-ignore-all lint/complexity/useLiteralKeys: persisted asset registry data is untrusted dictionary data.
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { RecordingProject } from "../src/project/index.js";
import { canonicalJson } from "../src/manifest/index.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digest = /^[a-f0-9]{64}$/u;
const relativeAssetPath = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const MAX_PROJECT_ASSETS = 256;

type RegistryEntry = { assetId: string; sha256: string; relativePath: string };

function parseEntries(value: unknown): RegistryEntry[] {
  if (!Array.isArray(value)) throw new RangeError("asset registry entries are invalid");
  const entries: RegistryEntry[] = [];
  const assetIds = new Set<string>();
  for (const entry of value) {
    const item = object(entry);
    if (
      Object.keys(item).length !== 3 ||
      typeof item["assetId"] !== "string" ||
      !identifier.test(item["assetId"]) ||
      typeof item["sha256"] !== "string" ||
      !digest.test(item["sha256"]) ||
      typeof item["relativePath"] !== "string" ||
      !relativeAssetPath.test(item["relativePath"]) ||
      item["relativePath"].includes("..") ||
      item["relativePath"].startsWith("/") ||
      assetIds.has(item["assetId"])
    ) {
      throw new RangeError("asset registry entry is invalid");
    }
    assetIds.add(item["assetId"]);
    entries.push({
      assetId: item["assetId"],
      sha256: item["sha256"],
      relativePath: item["relativePath"],
    });
  }
  return entries;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function mergeEntries(...groups: readonly RegistryEntry[][]): RegistryEntry[] {
  const merged = new Map<string, RegistryEntry>();
  for (const entry of groups.flat()) {
    const existing = merged.get(entry.assetId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(entry)) {
      throw new RangeError("audio asset conflicts with immutable registration");
    }
    merged.set(entry.assetId, entry);
  }
  return [...merged.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
}

async function readLegacyEntries(input: {
  root: string;
  registryPath: string;
  ownerToken: string;
}): Promise<RegistryEntry[]> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(input.registryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError("asset registry is not a private regular file");
  }
  const resolved = await realpath(input.registryPath);
  if (!contained(input.root, resolved))
    throw new RangeError("asset registry resolves outside root");
  const registry = object(JSON.parse(await readFile(resolved, "utf8")) as unknown);
  if (
    registry["schemaVersion"] !== 1 ||
    registry["ownerToken"] !== input.ownerToken ||
    Object.keys(registry).length !== 3
  ) {
    throw new RangeError("asset registry is invalid or not owned by this runtime");
  }
  return parseEntries(registry["entries"]);
}

async function journalRoot(input: {
  projectsRoot: string;
  projectId: string;
  create: boolean;
}): Promise<string | undefined> {
  const candidate = resolve(input.projectsRoot, `${input.projectId}.assets.d`);
  if (!contained(input.projectsRoot, candidate))
    throw new RangeError("asset journal path escapes root");
  if (input.create)
    await mkdir(candidate, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(candidate);
  } catch (error) {
    if (!input.create && errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError("asset journal must be a private non-symlink directory");
  }
  const resolved = await realpath(candidate);
  if (!contained(input.projectsRoot, resolved))
    throw new RangeError("asset journal resolves outside projects root");
  return resolved;
}

async function readJournalEntry(path: string, ownerToken: string): Promise<RegistryEntry> {
  const status = await lstat(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.mode & 0o077) !== 0 ||
    status.size > 2048
  ) {
    throw new RangeError("asset journal entry is unsafe");
  }
  const envelope = object(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (
    envelope["schemaVersion"] !== 1 ||
    envelope["ownerToken"] !== ownerToken ||
    Object.keys(envelope).length !== 3
  ) {
    throw new RangeError("asset journal entry is invalid or not owned by this runtime");
  }
  const entries = parseEntries([envelope["entry"]]);
  const entry = entries[0];
  if (entry === undefined) throw new RangeError("asset journal entry is invalid");
  return entry;
}

async function readJournalEntries(input: {
  projectsRoot: string;
  projectId: string;
  ownerToken: string;
}): Promise<RegistryEntry[]> {
  const root = await journalRoot({ ...input, create: false });
  if (root === undefined) return [];
  const children = await readdir(root, { withFileTypes: true });
  if (children.length > MAX_PROJECT_ASSETS * 2)
    throw new RangeError("asset journal exceeds its entry cap");
  const entries: RegistryEntry[] = [];
  for (const child of children) {
    const path = resolve(root, child.name);
    if (!contained(root, path)) throw new RangeError("asset journal entry escapes its root");
    if (child.name.startsWith(".") && child.name.endsWith(".tmp")) {
      const status = await lstat(path).catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
      if (status === undefined) continue;
      if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
        throw new RangeError("asset journal temporary entry is unsafe");
      }
      continue;
    }
    if (!child.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/u.test(child.name)) {
      throw new RangeError("asset journal contains an invalid entry");
    }
    entries.push(await readJournalEntry(path, input.ownerToken));
  }
  if (entries.length > MAX_PROJECT_ASSETS)
    throw new RangeError("asset journal exceeds its entry cap");
  return mergeEntries(entries);
}

/** Atomically registers one immutable normalized WAV for one owner-bound project. */
export async function registerProjectAudioAsset(input: {
  artifactRoot: string;
  ownerToken: string;
  projectId: string;
  assetId: string;
  sha256: string;
  relativePath: string;
}): Promise<void> {
  if (
    !isAbsolute(input.artifactRoot) ||
    !identifier.test(input.projectId) ||
    !identifier.test(input.assetId) ||
    !digest.test(input.sha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.relativePath)
  ) {
    throw new RangeError("audio asset registration is invalid");
  }
  const root = await realpath(input.artifactRoot);
  const projectsRoot = join(root, "projects");
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  await chmod(projectsRoot, 0o700);
  const registryPath = resolve(projectsRoot, `${input.projectId}.assets.json`);
  if (!contained(root, registryPath)) throw new RangeError("asset registry path escapes root");
  const legacy = await readLegacyEntries({ root, registryPath, ownerToken: input.ownerToken });
  const existingJournal = await readJournalEntries({
    projectsRoot,
    projectId: input.projectId,
    ownerToken: input.ownerToken,
  });
  const next = { assetId: input.assetId, sha256: input.sha256, relativePath: input.relativePath };
  const existing = mergeEntries(legacy, existingJournal).find(
    (entry) => entry.assetId === input.assetId,
  );
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(next))
      throw new RangeError("audio asset conflicts with immutable registration");
    return;
  }
  const assetsRoot = await journalRoot({ projectsRoot, projectId: input.projectId, create: true });
  if (assetsRoot === undefined) throw new RangeError("asset journal is unavailable");
  const entryPath = resolve(assetsRoot, `${input.assetId}.json`);
  if (!contained(assetsRoot, entryPath)) throw new RangeError("asset journal entry escapes root");
  const temporary = resolve(assetsRoot, `.${input.assetId}.${randomUUID()}.tmp`);
  if (!contained(assetsRoot, temporary))
    throw new RangeError("asset journal temporary escapes root");
  const envelope = { schemaVersion: 1, ownerToken: input.ownerToken, entry: next };
  try {
    await writeFile(temporary, `${canonicalJson(envelope)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, entryPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const published = await readJournalEntry(entryPath, input.ownerToken);
      if (canonicalJson(published) !== canonicalJson(next)) {
        throw new RangeError("audio asset conflicts with immutable registration");
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value.length > 0 && !value.startsWith("..") && !isAbsolute(value);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("asset registry must be an object");
  }
  return value as Record<string, unknown>;
}

/**
 * Resolves only project-declared, hash-matching assets from a contained private
 * registry. There is deliberately no generic local-path input in the MCP API.
 */
export async function loadProjectAssetRegistry(input: {
  artifactRoot: string;
  ownerToken: string;
  project: RecordingProject;
}): Promise<{ assetRoot: string; assets: Record<string, string> }> {
  if (!isAbsolute(input.artifactRoot)) throw new RangeError("artifact root must be absolute");
  const rootStatus = await lstat(input.artifactRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new RangeError("asset registry root is invalid");
  }
  const root = await realpath(input.artifactRoot);
  const assetRoot = join(root, "project-assets");
  const required = [...input.project.audioTracks, ...input.project.pipTracks].map(
    (track) => track.asset,
  );
  if (required.length === 0) return { assetRoot, assets: {} };
  const registryPath = resolve(root, "projects", `${input.project.projectId}.assets.json`);
  if (!contained(root, registryPath)) throw new RangeError("asset registry path escapes root");
  const projectsRoot = resolve(root, "projects");
  const entries = mergeEntries(
    await readLegacyEntries({ root, registryPath, ownerToken: input.ownerToken }),
    await readJournalEntries({
      projectsRoot,
      projectId: input.project.projectId,
      ownerToken: input.ownerToken,
    }),
  );
  const assets: Record<string, string> = {};
  for (const entry of entries) {
    assets[entry.assetId] = entry.relativePath;
  }
  for (const asset of required) {
    if (assets[asset.assetId] === undefined)
      throw new RangeError("project asset is not registered");
    const entry = entries.find((value) => value.assetId === asset.assetId);
    if (entry?.sha256 !== asset.sha256) {
      throw new RangeError("project asset registry digest does not match project");
    }
  }
  return { assetRoot, assets };
}
