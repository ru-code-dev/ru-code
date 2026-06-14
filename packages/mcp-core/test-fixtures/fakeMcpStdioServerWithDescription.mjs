// ru-fork test fixture: like fakeMcpStdioServer.mjs but its serverInfo (Implementation) ALSO reports a
// `description` + `websiteUrl`. Used to exercise the probe → catalog metadata back-fill ordering
// (improvements-branch-3 #1): the probe must capture these and the reactor must back-fill them onto the
// catalog within the same eager-reconcile cycle.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "fake-mcp-desc",
    version: "1.2.3",
    description: "Probed description",
    websiteUrl: "https://probed.example",
  },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "No-arg ping", inputSchema: { type: "object", properties: {} } }],
}));

await server.connect(new StdioServerTransport());
