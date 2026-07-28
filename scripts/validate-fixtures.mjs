import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repositoryRoot, "fixtures/render/fixture-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Invalid render fixture manifest: ${label} must be ${expected}`);
  }
}

assertEqual(manifest.id, "sanitized-browser-workflow-v1", "id");
assertEqual(manifest.externalAssets, false, "externalAssets");
assertEqual(manifest.viewport?.width, 1440, "viewport.width");
assertEqual(manifest.viewport?.height, 810, "viewport.height");
assertEqual(manifest.output?.width, 1920, "output.width");
assertEqual(manifest.output?.height, 1080, "output.height");
assertEqual(manifest.output?.fps, 30, "output.fps");
assertEqual(manifest.output?.frameCount, 30, "output.frameCount");

// This is intentionally an argument-array invocation: fixture validation never evaluates shell text.
execFileSync(
  process.execPath,
  [
    resolve(repositoryRoot, "node_modules/vitest/vitest.mjs"),
    "run",
    "test/integration/render-fixture.test.ts",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
