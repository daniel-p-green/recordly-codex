import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const packageFiles = [
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "browser/capture-runtime.js",
  "plugin-runtime/recordly-codex-mcp.mjs",
  "skills/recordly-codex/SKILL.md",
  "skills/recordly-codex/agents/openai.yaml",
] as const;

type JsonRpcResponse = {
  id?: number;
  jsonrpc?: string;
  result?: unknown;
  [key: string]: unknown;
};

async function copyCleanPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recordly-codex-clean-export-"));
  roots.push(root);
  for (const file of packageFiles) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(process.cwd(), file), destination);
  }
  return root;
}

async function files(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

async function rawMcp(
  root: string,
  artifactRoot: string,
  serverPath: string,
): Promise<{
  call(id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): void;
  stderr: () => string;
  stdoutLines: () => readonly string[];
}> {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, RECORDLY_CODEX_ARTIFACT_ROOT: artifactRoot },
  });
  let stderr = "";
  let buffer = "";
  const stdoutLines: string[] = [];
  const responses = new Map<number, (value: JsonRpcResponse) => void>();
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      stdoutLines.push(line);
      const message = JSON.parse(line) as JsonRpcResponse;
      if (typeof message.id === "number") responses.get(message.id)?.(message);
    }
  });
  const call = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolveCall, rejectCall) => {
      const timeout = setTimeout(
        () => rejectCall(new Error(`timed out waiting for ${method}`)),
        10_000,
      );
      responses.set(id, (message) => {
        clearTimeout(timeout);
        responses.delete(id);
        resolveCall(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    call,
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close: () => child.kill("SIGTERM"),
    stderr: () => stderr,
    stdoutLines: () => stdoutLines,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("clean marketplace export", () => {
  it("runs the bundled MCP server from the intended package files with no local byproducts", async () => {
    const pluginRoot = await copyCleanPlugin();
    const artifactRoot = await mkdtemp(join(tmpdir(), "recordly-codex-clean-artifacts-"));
    roots.push(artifactRoot);

    expect(await files(pluginRoot)).toEqual([...packageFiles].sort());
    for (const forbidden of [
      "node_modules",
      "coverage",
      "artifacts",
      ".git",
      ".playwright-mcp",
      "backups",
    ]) {
      await expect(lstat(join(pluginRoot, forbidden))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const marketplace = JSON.parse(
      await readFile(join(pluginRoot, ".agents/plugins/marketplace.json"), "utf8"),
    ) as { name?: string; plugins?: Array<{ name?: string; source?: { path?: string } }> };
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
    ) as { name?: string; mcpServers?: string };
    expect(marketplace).toMatchObject({
      name: "recordly-codex",
      plugins: [{ name: manifest.name }],
    });
    expect(marketplace.plugins?.[0]?.source?.path).toBe(".");
    expect(manifest).toMatchObject({ name: "recordly-codex", mcpServers: "./.mcp.json" });
    const notices = await readFile(join(pluginRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("# Third-Party Notices");
    expect(notices).toContain("## @modelcontextprotocol/sdk@1.30.0");
    expect(notices).toContain("## zod@4.4.2");
    expect(notices).not.toContain(process.cwd());

    const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string }>;
    };
    expect(mcp).toEqual({
      mcpServers: {
        "recordly-codex": {
          command: "node",
          args: ["./plugin-runtime/recordly-codex-mcp.mjs"],
          cwd: ".",
        },
      },
    });
    const serverPath = mcp.mcpServers?.["recordly-codex"]?.args?.[0];
    if (serverPath === undefined) throw new Error("clean export MCP server path is missing");

    const transport = await rawMcp(pluginRoot, artifactRoot, serverPath);
    try {
      await transport.call(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "clean-export-test", version: "0.1.0" },
      });
      transport.notify("notifications/initialized", {});
      const listed = await transport.call(2, "tools/list", {});
      const names = ((listed.result as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((tool) => tool.name)
        .sort();
      expect(names).toEqual([
        "create_recording_session",
        "discard_recording_session",
        "inspect_recording_session",
        "record_browser_event",
        "seal_recording_capture",
      ]);
      const created = await transport.call(3, "tools/call", {
        name: "create_recording_session",
        arguments: { url: "https://demo.example/", objective: "Show the approved opening state." },
      });
      const sessionId = (
        created.result as { structuredContent?: { session?: { sessionId?: string } } }
      ).structuredContent?.session?.sessionId;
      if (sessionId === undefined)
        throw new Error(`clean create failed: ${JSON.stringify(created)}`);
      expect(sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
      const discarded = await transport.call(4, "tools/call", {
        name: "discard_recording_session",
        arguments: { sessionId },
      });
      expect(discarded.result).not.toHaveProperty("isError");
      expect(discarded.result).toMatchObject({
        structuredContent: { ok: true, session: { status: "discarded" } },
      });
      expect(transport.stderr()).toBe("");
      expect(transport.stdoutLines().map((line) => JSON.parse(line))).toEqual(
        expect.arrayContaining([expect.objectContaining({ jsonrpc: "2.0", id: 1 })]),
      );
    } finally {
      transport.close();
    }
  }, 30_000);
});
