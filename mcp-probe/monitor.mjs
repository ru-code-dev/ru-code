// Monitor probe — a preview of the production McpSupervisor's health loop.
//
// The plan (§6.3) monitors MCP servers WITHOUT holding connections: it reprobes
// on demand — stdio servers spawn→connect→listTools→close; remote (http) servers
// connect→listTools→close on a periodic poll. This module is exactly that, built
// on the same @modelcontextprotocol/sdk the supervisor will use. The probe's
// P-cases call it to prove status + tool discovery work for both transports.

export async function probeOnce(target) {
  const startedAt = Date.now();
  let Client, transport;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    if (target.kind === "stdio") {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        command: target.command,
        args: target.args ?? [],
        env: { ...process.env, ...(target.env ?? {}) },
      });
    } else {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(new URL(target.url));
    }
  } catch (error) {
    return { status: "error", error: `sdk: ${error?.message ?? error}`, tools: [], latencyMs: 0 };
  }

  const client = new Client({ name: "mcp-monitor", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    await client.close();
    return {
      status: "online",
      tools: (listed.tools ?? []).map((tool) => tool.name),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    return { status: "offline", error: String(error?.message ?? error).slice(0, 120), tools: [], latencyMs: Date.now() - startedAt };
  }
}

// True if the SDK is installed (so callers can SKIP cleanly with a hint).
export async function sdkInstalled() {
  try {
    await import("@modelcontextprotocol/sdk/client/index.js");
    return true;
  } catch {
    return false;
  }
}
