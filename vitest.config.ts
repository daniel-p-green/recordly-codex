import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      // The self-check is exercised as a real subprocess by its behavioral tests; V8 cannot
      // attribute that child-process execution back to the parent coverage session.
      exclude: ["src/index.ts", "scripts/self-check.mjs"],
      thresholds: {
        lines: 80,
        branches: 80,
        "src/capture/index.ts": { lines: 80, branches: 80 },
        "src/compiler/compile-recording.ts": { lines: 80, branches: 80 },
        "src/manifest/canonical-json.ts": { lines: 80, branches: 80 },
        "src/safe/**/*.ts": { lines: 80, branches: 80 },
        "src/timeline/**/*.ts": { lines: 80, branches: 80 },
      },
    },
  },
});
