// ru-fork: behavior tests for the real probe (probeOnce) — the connect→listTools→close lifecycle.
// We exercise the OFFLINE paths against real child processes (no fake MCP server needed): a command
// that cannot spawn, and a process that never speaks MCP (handshake times out). The online path needs
// a real MCP server and is covered separately by the live mcp-probe harness.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { type ResolvedServerConfig, probeOnce } from "@ru-fork/mcp-core";
import { describe, expect, it } from "vitest";

// packages/mcp-core/test-fixtures/fakeMcpStdioServer.mjs (5 dirs up from this test file).
const FAKE_SERVER = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../../packages/mcp-core/test-fixtures/fakeMcpStdioServer.mjs",
);

const stdio = (command: string, args: ReadonlyArray<string>): ResolvedServerConfig => ({
  transport: "stdio",
  command,
  args: [...args],
  env: {},
  cwd: process.cwd(),
});

describe("probeOnce — offline paths", () => {
  it("returns offline (not throwing) when the command cannot be spawned", async () => {
    const result = await probeOnce(stdio("this-binary-does-not-exist-7f3a", []), 3000);
    expect(result.status).toBe("offline");
    expect(result.tools).toEqual([]);
    expect(typeof result.message).toBe("string");
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it("returns offline after the connect timeout for a process that never speaks MCP", async () => {
    // `sleep` ignores stdin and never answers the MCP handshake ⇒ the SDK connect-timeout fires.
    const startedAt = Date.now();
    const result = await probeOnce(stdio("sleep", ["30"]), 700);
    expect(result.status).toBe("offline");
    expect(typeof result.message).toBe("string");
    // It actually waited for the timeout (didn't fail instantly like a missing binary).
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
  }, 15_000);
});

describe("probeOnce — online path (real stdio MCP server)", () => {
  it("connects, lists tools, and maps params through the real handshake", async () => {
    const result = await probeOnce(stdio("node", [FAKE_SERVER]), 10_000);
    expect(result.status).toBe("online");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.tools.map((tool) => tool.name).toSorted()).toEqual(["echo", "ping"]);
    const echo = result.tools.find((tool) => tool.name === "echo");
    expect(echo?.params?.map((param) => param.name)).toEqual(["msg"]);
    expect(echo?.params?.[0]?.required).toBe(true);
    const ping = result.tools.find((tool) => tool.name === "ping");
    expect(ping?.params).toBeUndefined(); // no-arg tool ⇒ params absent
  }, 20_000);
});
