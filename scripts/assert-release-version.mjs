import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function assertReleaseVersion(tag, packageVersion) {
  if (typeof tag !== "string" || tag.length === 0) throw new Error("Release tag is required.");
  if (typeof packageVersion !== "string" || !versionPattern.test(packageVersion))
    throw new Error("package.json version must be strict SemVer.");
  if (tag !== `v${packageVersion}`) throw new Error(`Release tag must equal v${packageVersion}.`);
}

export function assertReleaseMetadataVersions(
  packageVersion,
  pluginVersion,
  lockVersion,
  lockPackageVersion,
) {
  if (pluginVersion !== packageVersion) {
    throw new Error(".codex-plugin/plugin.json version must equal package.json version.");
  }
  if (lockVersion !== packageVersion) {
    throw new Error("package-lock.json version must equal package.json version.");
  }
  if (lockPackageVersion !== packageVersion) {
    throw new Error("package-lock.json package root version must equal package.json version.");
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.env.GITHUB_REF_NAME;
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  assertReleaseVersion(tag, pkg.version);
  assertReleaseMetadataVersions(pkg.version, plugin.version, lock.version, lock.packages?.[""]?.version);
}
