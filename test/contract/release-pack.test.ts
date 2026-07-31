import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("allowlisted release archive", () => {
  it("keeps package.json files aligned with the release allowlist", () => {
    const allowlist = JSON.parse(
      readFileSync(new URL("../../scripts/release-package-files.json", import.meta.url), "utf8"),
    ) as string[];
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      files?: string[];
    };
    expect(packageJson.files).toEqual(allowlist);
  });

  it("packs only the allowlisted plugin surface", () => {
    const output = execFileSync("node", ["scripts/pack-check.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const report = JSON.parse(output) as { ok: boolean; packedCount: number; packed: string[] };
    expect(report.ok).toBe(true);
    expect(report.packedCount).toBeLessThan(30);
    expect(report.packed.some((path) => path.startsWith("test/"))).toBe(false);
    expect(report.packed.some((path) => path.startsWith(".codex/"))).toBe(false);
    expect(report.packed.some((path) => path.startsWith(".github/"))).toBe(false);
    expect(report.packed.some((path) => path.startsWith("src/"))).toBe(false);
    expect(report.packed.some((path) => path.startsWith("mcp/") && path.endsWith(".ts"))).toBe(
      false,
    );
  }, 60_000);
});
