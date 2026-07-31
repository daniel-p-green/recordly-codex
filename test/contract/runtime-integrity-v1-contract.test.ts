import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("candidate v1 runtime integrity contract", () => {
  it("matches the committed bundle bytes, digest, version, and MCP boundary", () => {
    const contract = JSON.parse(
      readFileSync("contracts/runtime-integrity-v1-candidate.json", "utf8"),
    ) as {
      candidateVersion: string;
      pluginVersion: string;
      bundle: { path: string; bytes: number; sha256: string; maximumBytes: number };
      mcp: { serverName: string; protocolVersion: string; toolCount: number };
    };
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };
    const pluginJson = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8")) as {
      version: string;
    };
    const bundle = readFileSync(contract.bundle.path);

    expect(contract).toMatchObject({
      candidateVersion: "1.0.0",
      pluginVersion: packageJson.version,
      bundle: {
        path: "plugin-runtime/recordly-codex-mcp.mjs",
        bytes: bundle.byteLength,
        sha256: createHash("sha256").update(bundle).digest("hex"),
        maximumBytes: 2 * 1024 * 1024,
      },
      mcp: {
        serverName: "recordly-codex-mcp-server",
        protocolVersion: "2025-03-26",
        toolCount: 20,
      },
    });
    expect(pluginJson.version).toBe(contract.pluginVersion);
    expect(bundle.byteLength).toBeLessThanOrEqual(contract.bundle.maximumBytes);
  });
});
