import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createRecordingMcpServer } from "../../mcp/server-factory.js";
import { createSessionStoreService } from "../../mcp/session-store-service.js";
import { canonicalJson } from "../../src/manifest/index.js";

type ContractTool = {
  name: string;
  title: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchemaSha256: string;
  outputSchemaSha256: string;
};

type ContractSnapshot = {
  schemaVersion: 1;
  candidateVersion: "1.0.0";
  protocolVersion: "2025-03-26";
  toolCount: 20;
  tools: ContractTool[];
};

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

describe("candidate v1 MCP contract", () => {
  it("matches the reviewed tool metadata and complete JSON-schema digests", async () => {
    const service = createSessionStoreService({
      artifactRoot: "/tmp/recordly-codex-v1-contract",
    });
    const server = createRecordingMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "recordly-v1-contract-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const actual: ContractSnapshot = {
        schemaVersion: 1,
        candidateVersion: "1.0.0",
        protocolVersion: "2025-03-26",
        toolCount: 20,
        tools: listed.tools
          .map((tool) => ({
            name: tool.name,
            title: tool.title ?? "",
            readOnly: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint === true,
            inputSchemaSha256: digest(tool.inputSchema),
            outputSchemaSha256: digest(tool.outputSchema),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
      if (!existsSync("contracts/mcp-v1-candidate.json")) {
        throw new Error(
          `candidate contract snapshot is missing:\n${JSON.stringify(actual, null, 2)}`,
        );
      }
      const expected = JSON.parse(
        readFileSync("contracts/mcp-v1-candidate.json", "utf8"),
      ) as ContractSnapshot;
      expect(actual).toEqual(expected);
    } finally {
      await client.close();
    }
  });
});
