// ru-code (S94 probe): a fake MCP server over STREAMABLE HTTP that records every request.
//
// Raw JSON-RPC over HTTP, stateless, no SDK: `POST /mcp` carrying requests is answered with an
// `application/json` body (the spec's non-streaming answer), a POST carrying only notifications
// gets `202`, and `GET /mcp` (the optional server→client SSE stream) gets `405` — all three are
// what the SDK's StreamableHTTPClientTransport accepts. Every request is logged with its headers,
// so the app's own probe and qwen are told apart by `clientInfo` and `user-agent`.
//
//   --log <file>         append one JSON line per event (required)
//   --port-file <file>   write the bound port here once listening (required)
//   --tools <n>          advertise n tools named <prefix>_tool_01 … (default 50)
//   --prefix <name>      tool-name prefix (default "remote")
//   --delay-ms <ms>      answer `initialize` this long after it arrived

import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

const logPath = argValue("--log", undefined);
const portFile = argValue("--port-file", undefined);
const toolCount = Number(argValue("--tools", "50"));
const prefix = argValue("--prefix", "remote");
const delayMs = Number(argValue("--delay-ms", "0"));
// Tool-name length (S94 addendum 2): 0 = the default `<prefix>_tool_NN`; N = exactly N characters,
// `<prefix>_navigate…_NN`, so the length of what qwen has to prefix is controlled.
const nameLen = Number(argValue("--name-len", "0"));
// `tools/call` answers this late (S94 addendum 3: the entry's `timeout` on a call).
const callDelayMs = Number(argValue("--call-delay-ms", "0"));
const startedAt = Date.now();

const record = (event) => {
  if (logPath === undefined) return;
  try {
    NodeFS.appendFileSync(
      logPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        ms: Date.now(),
        sinceStartMs: Date.now() - startedAt,
        transport: "http",
        prefix,
        pid: process.pid,
        ...event,
      })}\n`,
    );
  } catch {
    /* the log is evidence, never a failure source */
  }
};

const pad = (n) => String(n).padStart(2, "0");
const NAME_BASE = `${prefix}_navigate_to_the_page_and_capture_a_full_screenshot_of_it_now`;
const toolName = (index) =>
  nameLen > 0
    ? `${NAME_BASE.slice(0, nameLen - 3)}_${pad(index + 1)}`
    : `${prefix}_tool_${pad(index + 1)}`;
const TOOLS = Array.from({ length: toolCount }, (_, index) => ({
  name: toolName(index),
  description: `Fake ${prefix} tool number ${String(index + 1)}. Returns a fixed marker.`,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "free text" } },
  },
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const answer = async (message) => {
  switch (message.method) {
    case "initialize":
      await sleep(delayMs);
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `fake-mcp-${prefix}`, version: "1.0.0" },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
    case "tools/call":
      await sleep(callDelayMs);
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `FAKE-MCP-RESULT ${prefix} ${message.params?.name}` }],
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id: message.id, result: {} };
    default:
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
};

const pickHeaders = (headers) => ({
  // every X-Probe-* header — the overlay's `headers` reaching the server
  ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith("x-probe"))),
  "user-agent": headers["user-agent"] ?? null,
  accept: headers["accept"] ?? null,
  "mcp-session-id": headers["mcp-session-id"] ?? null,
  "mcp-protocol-version": headers["mcp-protocol-version"] ?? null,
});

const server = NodeHttp.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    void (async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers = pickHeaders(request.headers);
      if (request.method !== "POST") {
        record({ event: "http", httpMethod: request.method, url: request.url, headers });
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        record({ event: "malformed", url: request.url, headers, raw });
        response.writeHead(400);
        response.end();
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) {
        record({
          event: "recv",
          url: request.url,
          headers,
          id: message.id ?? null,
          method: message.method ?? null,
          clientInfo:
            message.method === "initialize" ? (message.params?.clientInfo ?? null) : undefined,
          params: message.params ?? null,
        });
      }
      const requests = messages.filter(
        (message) => message.id !== undefined && message.id !== null && message.method,
      );
      if (requests.length === 0) {
        response.writeHead(202);
        response.end();
        return;
      }
      const answers = await Promise.all(requests.map(answer));
      for (const payload of answers) {
        record({ event: "send", id: payload.id, method: null, payload });
      }
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
    })();
  });
  // The client hanging up before this server answered (e.g. its own timeout) — the one early close
  // that matters. `response` "close" fires on completion too, hence the writableFinished check.
  response.on("close", () => {
    if (!response.writableFinished)
      record({ event: "client-gone-before-answer", url: request.url });
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  record({ event: "listening", port, argv: process.argv.slice(2) });
  if (portFile !== undefined) NodeFS.writeFileSync(portFile, String(port));
});

process.on("SIGTERM", () => {
  record({ event: "sigterm" });
  server.close();
  server.closeAllConnections();
  process.exit(0);
});
