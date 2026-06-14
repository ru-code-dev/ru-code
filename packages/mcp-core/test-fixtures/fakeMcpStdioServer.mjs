// ru-fork test fixture: a minimal real MCP server over stdio, used to exercise the ONLINE probe path
// (connect → listTools → close). Lives in packages/mcp-core so `node` resolves the MCP SDK from this
// package's node_modules. Advertises two tools — one with params, one without — to check
// paramsFromInputSchema mapping through a real handshake.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fake-mcp", version: "1.2.3" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a message",
      inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    },
    {
      name: "ping",
      description: "No-arg ping",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

await server.connect(new StdioServerTransport());
