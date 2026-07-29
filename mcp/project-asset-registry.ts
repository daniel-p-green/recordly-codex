// biome-ignore-all lint/complexity/useLiteralKeys: persisted asset registry data is untrusted dictionary data.
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { RecordingProject } from "../src/project/index.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digest = /^[a-f0-9]{64}$/u;

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
  const status = await lstat(registryPath);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError("asset registry is not a private regular file");
  }
  const resolved = await realpath(registryPath);
  if (!contained(root, resolved)) throw new RangeError("asset registry resolves outside root");
  const registry = object(JSON.parse(await readFile(resolved, "utf8")) as unknown);
  const entries = registry["entries"];
  if (
    registry["schemaVersion"] !== 1 ||
    registry["ownerToken"] !== input.ownerToken ||
    !Array.isArray(entries) ||
    Object.keys(registry).length !== 3
  ) {
    throw new RangeError("asset registry is invalid or not owned by this runtime");
  }
  const assets: Record<string, string> = {};
  for (const entry of entries) {
    const item = object(entry);
    if (
      Object.keys(item).length !== 3 ||
      typeof item["assetId"] !== "string" ||
      !identifier.test(item["assetId"]) ||
      typeof item["sha256"] !== "string" ||
      !digest.test(item["sha256"]) ||
      typeof item["relativePath"] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(item["relativePath"]) ||
      item["relativePath"].includes("..") ||
      item["relativePath"].startsWith("/") ||
      Object.hasOwn(assets, item["assetId"])
    ) {
      throw new RangeError("asset registry entry is invalid");
    }
    assets[item["assetId"]] = item["relativePath"];
  }
  for (const asset of required) {
    if (assets[asset.assetId] === undefined)
      throw new RangeError("project asset is not registered");
    const entry = entries.find((value) => object(value)["assetId"] === asset.assetId) as Record<
      string,
      unknown
    >;
    if (entry["sha256"] !== asset.sha256) {
      throw new RangeError("project asset registry digest does not match project");
    }
  }
  return { assetRoot, assets };
}
