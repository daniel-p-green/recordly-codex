import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRecordingMcpServer } from "../../dist/mcp/server-factory.js";

const failure = async () => {
  throw new Error("database failed at /private/recordly-codex/session.ts:17");
};

await createRecordingMcpServer({
  create: failure,
  recordEvent: failure,
  inspect: failure,
  seal: failure,
  discard: failure,
}).connect(new StdioServerTransport());
