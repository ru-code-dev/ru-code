#!/usr/bin/env node
// Dependency-free fake MCP server (stdio transport).
//
// Implements just enough of the Model Context Protocol over stdio for qwen to
// connect, discover tools, and call them. NO npm dependencies — the MCP stdio
// transport is newline-delimited JSON-RPC 2.0, which we frame by hand so this
// probe runs anywhere `node` exists.
//
// Identity + behaviour come entirely from env (the overlay's mcpServers entry
// sets these), so one file backs every fake server in the probe:
//   PROBE_SERVER_NAME   logical name (also selects the built-in tool set)
//   PROBE_LOG           absolute path to append a one-line-per-event audit log
//
// Every protocol event is appended to PROBE_LOG as `EVENT field=value …`. The
// orchestrator reads that file to assert what qwen actually did. The mere
// existence of a START line proves qwen spawned (i.e. selected) this server.

import { appendFileSync } from "node:fs";

const serverName = process.env.PROBE_SERVER_NAME ?? "unnamed";
const logPath = process.env.PROBE_LOG ?? null;

// Built-in tool catalogs, keyed by server name. Each tool is trivial and pure.
const TOOL_CATALOGS = {
  alpha: [
    {
      name: "echo",
      description: "Echo the provided text straight back.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo." } },
        required: ["text"],
      },
      run: (args) => `echo: ${args?.text ?? ""}`,
    },
    {
      name: "ping",
      description: "Return the literal string 'pong'.",
      inputSchema: { type: "object", properties: {}, required: [] },
      run: () => "pong",
    },
  ],
  beta: [
    {
      name: "add",
      description: "Add two numbers and return the sum.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      run: (args) => String((args?.a ?? 0) + (args?.b ?? 0)),
    },
    {
      name: "multiply",
      description: "Multiply two numbers and return the product.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      run: (args) => String((args?.a ?? 0) * (args?.b ?? 0)),
    },
  ],
  // A stand-in for a server the user already had configured. Used to prove our
  // engine can ignore/exclude pre-existing servers. Same shape, distinct name.
  decoy: [
    {
      name: "leak",
      description: "A tool from a pre-existing server we expect to be excluded.",
      inputSchema: { type: "object", properties: {}, required: [] },
      run: () => "this server should have been excluded",
    },
  ],
};

const tools = TOOL_CATALOGS[serverName] ?? TOOL_CATALOGS.alpha;

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

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handleMessage(message) {
  const { id, method, params } = message;

  // Notifications (no id) — observe and move on.
  if (id === undefined) {
    audit("NOTIFY", { method });
    return;
  }

  switch (method) {
    case "initialize": {
      audit("INITIALIZE", { protocol: params?.protocolVersion ?? "?" });
      reply(id, {
        // Echo the client's requested protocol version so negotiation succeeds.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: "0.0.0-probe" },
      });
      return;
    }
    case "ping": {
      audit("PING");
      reply(id, {});
      return;
    }
    case "tools/list": {
      audit("LIST", { tools: tools.map((tool) => tool.name).join(",") });
      reply(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
      return;
    }
    case "tools/call": {
      const toolName = params?.name;
      const tool = tools.find((candidate) => candidate.name === toolName);
      audit("CALL", { tool: toolName, known: Boolean(tool) });
      if (!tool) {
        reply(id, {
          content: [{ type: "text", text: `unknown tool: ${toolName}` }],
          isError: true,
        });
        return;
      }
      reply(id, {
        content: [{ type: "text", text: tool.run(params?.arguments) }],
        isError: false,
      });
      return;
    }
    default: {
      audit("UNHANDLED", { method });
      // Minimal JSON-RPC "method not found" so the client isn't left hanging.
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
}

// PROBE_ECHO lets the orchestrator verify env-var expansion: the overlay sets
// it to `${SOME_VAR}` and we log whatever value actually arrived (qwen expands
// overlay placeholders from its process env before spawning us).
audit("START", {
  pid: process.pid,
  tools: tools.map((tool) => tool.name).join(","),
  echo: process.env.PROBE_ECHO ?? "-",
});

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf("\n")) >= 0) {
    const rawLine = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!rawLine) continue;
    let message;
    try {
      message = JSON.parse(rawLine);
    } catch {
      audit("BADJSON", { raw: rawLine.slice(0, 80) });
      continue;
    }
    handleMessage(message);
  }
});

process.stdin.on("end", () => {
  audit("STDIN_END");
  process.exit(0);
});
