// ru-code test fixture: a minimal real MCP server over stdio, used to exercise the ONLINE probe path
// (connect → listTools → close). Speaks raw newline-delimited JSON-RPC (no SDK dependency — the host
// test tree cannot resolve @modelcontextprotocol/sdk for a spawned child process), which is exactly
// the wire protocol the SDK's StdioClientTransport speaks. Advertises two tools — one with params,
// one without — to check paramsFromInputSchema mapping through a real handshake.

import * as NodeReadline from "node:readline";

const SERVER_INFO = { name: "fake-mcp", version: "1.2.3" };

const TOOLS = [
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
];

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const readline = NodeReadline.createInterface({ input: process.stdin });
readline.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) {
    return; // notification (e.g. notifications/initialized) — no response
  }
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "tools/list":
      respond(message.id, { tools: TOOLS });
      break;
    case "ping":
      respond(message.id, {});
      break;
    default:
      respondError(message.id, -32601, `Method not found: ${message.method}`);
  }
});
