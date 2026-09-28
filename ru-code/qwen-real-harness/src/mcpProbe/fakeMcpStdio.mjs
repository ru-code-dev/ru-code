// ru-code (S94 probe): a fake MCP server over STDIO that records every message it receives.
//
// Raw newline-delimited JSON-RPC, no SDK — the same wire the SDK's StdioClientTransport speaks, and
// a child spawned from any cwd resolves nothing. It is configured ONLY through its argv, because the
// argv is what a user types into the app's MCP form, so the app stores it, writes it into its
// overlay and qwen spawns it verbatim:
//
//   --log <file>        append one JSON line per event (required)
//   --tools <n>         advertise n tools named <prefix>_tool_01 … (default 50)
//   --prefix <name>     tool-name prefix (default "local")
//   --delay-ms <ms>     answer `initialize` this long after it arrived (a slow server start)
//   --crash             write to stderr and exit 1 before reading anything
//
// Every event carries pid, ppid and the PARENT's cmdline: the app's own probe and qwen both spawn
// this server, and the parent is what tells them apart.

import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

const logPath = argValue("--log", undefined);
const toolCount = Number(argValue("--tools", "50"));
const prefix = argValue("--prefix", "local");
const delayMs = Number(argValue("--delay-ms", "0"));
// Tool-name length (S94 addendum 2): 0 = the default `<prefix>_tool_NN`; N = exactly N characters,
// `<prefix>_navigate…_NN`, so the length of what qwen has to prefix is controlled.
const nameLen = Number(argValue("--name-len", "0"));
// `tools/call` answers this late (S94 addendum 3: the entry's `timeout` on a call).
const callDelayMs = Number(argValue("--call-delay-ms", "0"));
const crash = process.argv.includes("--crash");
const startedAt = Date.now();

const parentCmdline = (() => {
  try {
    return NodeFS.readFileSync(`/proc/${String(process.ppid)}/cmdline`, "utf8")
      .split("\0")
      .filter((part) => part !== "")
      .join(" ");
  } catch {
    return null;
  }
})();

const record = (event) => {
  if (logPath === undefined) return;
  try {
    NodeFS.appendFileSync(
      logPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        ms: Date.now(),
        sinceStartMs: Date.now() - startedAt,
        transport: "stdio",
        prefix,
        pid: process.pid,
        ppid: process.ppid,
        ...event,
      })}\n`,
    );
  } catch {
    /* the log is evidence, never a failure source */
  }
};

// Every PROBE_MARK* variable this process received — the overlay's `env` reaching the server.
const envMarks = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.startsWith("PROBE_MARK")),
);
record({
  event: "process-start",
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  parentCmdline,
  envMarks,
});

if (crash) {
  record({ event: "crash-exit" });
  process.stderr.write("fake-mcp-stdio: scripted crash at start\n");
  process.exit(1);
}

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

const write = (payload) => {
  record({ event: "send", id: payload.id ?? null, method: payload.method ?? null, payload });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

const handle = (message) => {
  switch (message.method) {
    case "initialize":
      setTimeout(
        () =>
          respond(message.id, {
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: `fake-mcp-${prefix}`, version: "1.0.0" },
          }),
        delayMs,
      );
      return;
    case "tools/list":
      respond(message.id, { tools: TOOLS });
      return;
    case "tools/call":
      setTimeout(
        () =>
          respond(message.id, {
            content: [{ type: "text", text: `FAKE-MCP-RESULT ${prefix} ${message.params?.name}` }],
          }),
        callDelayMs,
      );
      return;
    case "ping":
      respond(message.id, {});
      return;
    default:
      respondError(message.id, -32601, `Method not found: ${message.method}`);
  }
};

const readline = NodeReadline.createInterface({ input: process.stdin });
readline.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    record({ event: "malformed", line: trimmed });
    return;
  }
  record({
    event: "recv",
    id: message.id ?? null,
    method: message.method ?? null,
    clientInfo: message.method === "initialize" ? (message.params?.clientInfo ?? null) : undefined,
    params: message.params ?? null,
  });
  if (message.id === undefined || message.id === null) return; // notification
  handle(message);
});
// The client closing stdin is the end of this server's life — nothing may outlive its parent.
readline.on("close", () => {
  record({ event: "stdin-closed" });
  process.exit(0);
});
process.on("SIGTERM", () => {
  record({ event: "sigterm" });
  process.exit(0);
});
