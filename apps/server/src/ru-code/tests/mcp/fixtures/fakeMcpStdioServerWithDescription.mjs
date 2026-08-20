// ru-code test fixture: like fakeMcpStdioServer.mjs but its serverInfo (Implementation) ALSO reports a
// `description` + `websiteUrl`. Used to exercise the probe → catalog metadata back-fill ordering
// (improvements-branch-3 #1): the probe must capture these and the reactor must back-fill them onto the
// catalog within the same eager-reconcile cycle. Raw newline-delimited JSON-RPC (no SDK dependency).

import * as NodeReadline from "node:readline";

const SERVER_INFO = {
  name: "fake-mcp-desc",
  version: "1.2.3",
  description: "Probed description",
  websiteUrl: "https://probed.example",
};

const TOOLS = [
  { name: "ping", description: "No-arg ping", inputSchema: { type: "object", properties: {} } },
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
