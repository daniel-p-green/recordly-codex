import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".yaml",
  ".yml",
]);
export function trackedBiomeFiles(root, run = execFileSync) {
  if (!existsSync(resolve(root, ".git")))
    throw new Error(
      "Tracked-file validation requires a Git worktree; exported package trees must validate before export.",
    );
  const output = run("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  const files = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => extensions.has(path.slice(path.lastIndexOf("."))));
  if (files.length === 0) throw new Error("Tracked-file validation found no supported files.");
  return files;
}
export function runTrackedBiome({
  root,
  command,
  biome = resolve(root, "node_modules/.bin/biome"),
  run = execFileSync,
}) {
  if (command !== "format" && command !== "lint")
    throw new Error("Usage: run-tracked-biome.mjs <format|lint>");
  const tracked = trackedBiomeFiles(root, run);
  for (const files of Array.from({ length: Math.ceil(tracked.length / 100) }, (_, index) =>
    tracked.slice(index * 100, index * 100 + 100),
  )) {
    run(biome, [command, ...files], { cwd: root, stdio: "inherit" });
  }
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTrackedBiome({ root, command: process.argv[2] });
}
