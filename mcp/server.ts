import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRecordingMcpServer } from "./server-factory.js";
import { createSessionStoreService } from "./session-store-service.js";

async function main(): Promise<void> {
  await createRecordingMcpServer(createSessionStoreService()).connect(new StdioServerTransport());
}

void main().catch(() => {
  process.stderr.write("recordly-codex MCP server failed to start\n");
  process.exitCode = 1;
});
