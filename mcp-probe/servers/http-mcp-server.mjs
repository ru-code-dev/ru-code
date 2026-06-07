#!/usr/bin/env node
// Fake REMOTE (streamable-HTTP) MCP server, built on the real
// @modelcontextprotocol/sdk so it speaks exactly what qwen's
// StreamableHTTPClientTransport (httpUrl) expects. This is the transport the
// ACP mcpServers array CANNOT carry — only the overlay file can — so it's the
// case that justifies the overlay approach.
//
// Stateless mode: a fresh Server+transport per POST (the SDK's documented
// stateless pattern). Identity + tools come from env:
//   PROBE_SERVER_NAME   logical name (selects the tool catalog)
//   PROBE_LOG           audit-log path (START / LIST / CALL …)
//   PROBE_HTTP_PORT     port to bind (0 = ephemeral; actual port is printed)
//
// On success prints `PROBE_HTTP_READY <port>` to stdout. If the SDK isn't
// installed it prints `SDK_MISSING` to stderr and exits 3 (probe treats as SKIP).

import http from "node:http";
import { appendFileSync } from "node:fs";

let Server, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
try {
  ({ Server } = await import("@modelcontextprotocol/sdk/server/index.js"));
  ({ StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js"));
  ({ ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js"));
} catch (error) {
  process.stderr.write(`SDK_MISSING ${error?.message ?? ""}\n`);
  process.exit(3);
}

const serverName = process.env.PROBE_SERVER_NAME ?? "remote";
const logPath = process.env.PROBE_LOG ?? null;

const TOOL_CATALOGS = {
  remote: [
    {
      name: "weather",
      description: "Return the (fake) weather for a city.",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: [] },
      run: (args) => `weather in ${args?.city ?? "nowhere"}: sunny`,
    },
    {
      name: "news",
      description: "Return a (fake) news headline.",
      inputSchema: { type: "object", properties: {}, required: [] },
      run: () => "headline: all systems nominal",
    },
  ],
};
const tools = TOOL_CATALOGS[serverName] ?? TOOL_CATALOGS.remote;

function audit(event, fields = {}) {
  if (!logPath) return;
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  const line = `${new Date().toISOString()} ${event} server=${serverName} ${parts.join(" ")}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    /* logging must never crash the server */
  }
}

function makeServer() {
  const server = new Server({ name: serverName, version: "0.0.0-probe" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    audit("LIST", { tools: tools.map((tool) => tool.name).join(",") });
    return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params?.name;
    const tool = tools.find((candidate) => candidate.name === toolName);
    audit("CALL", { tool: toolName, known: Boolean(tool) });
    if (!tool) return { content: [{ type: "text", text: `unknown tool: ${toolName}` }], isError: true };
    return { content: [{ type: "text", text: tool.run(request.params?.arguments) }], isError: false };
  });
  return server;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  try {
    const body = await readJsonBody(req);
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    audit("HTTP_ERROR", { message: String(error?.message ?? error).slice(0, 80) });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const port = Number(process.env.PROBE_HTTP_PORT ?? 0);
httpServer.listen(port, "127.0.0.1", () => {
  const actualPort = httpServer.address().port;
  audit("HTTP_START", { port: actualPort, tools: tools.map((tool) => tool.name).join(",") });
  process.stdout.write(`PROBE_HTTP_READY ${actualPort}\n`);
});
