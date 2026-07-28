import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        "src/capture/index.ts": { lines: 80, branches: 80 },
        "src/compiler/compile-recording.ts": { lines: 80, branches: 80 },
        "src/manifest/canonical-json.ts": { lines: 80, branches: 80 },
        "src/timeline/**/*.ts": { lines: 80, branches: 80 },
      },
    },
  },
});
