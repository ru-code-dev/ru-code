// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
//
// This module is the deliberate non-Effect boundary to the MCP SDK: plain async
// over Node builtins + timers (so the mcp-probe harness can reuse it verbatim).
// Effect's node-builtin / global-timer rules don't apply here.
//
// The monitor primitive: connect to one MCP server, list its tools, close. No
// held connection — the supervisor calls this on a schedule.
//
// This is a FAITHFUL MIRROR of qwen's McpClient.connect()/discoverTools()
// (qwen-code packages/core/src/tools/mcp-client.ts): same transport construction
// (StreamableHTTP with headers, Stdio with cwd + piped stderr), same client
// setup (roots capability + ListRoots handler), same connect({timeout}) +
// listTools(). So a successful probe means qwen will almost certainly succeed,
// and a failing probe means qwen will fail the same way — using the IDENTICAL
// timeout we also write into qwen's overlay.
//
// Two things qwen does NOT need but a long-running monitor does: (1) a hard
// wall-clock backstop so a hung connect can never freeze the sweep loop
// (qwen connects once at startup; we re-probe forever), and (2) we surface the
// child's stderr in the failure message so the user sees the real cause
// (e.g. an npm 404 or `command not found`).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import type { McpTool, McpToolParam } from "@t3tools/contracts";
import type { ResolvedServerConfig } from "./resolver.ts";

// ── tool input-schema → params ───────────────────────────────────────────────
// An MCP tool advertises its arguments as a JSON-Schema `inputSchema`
// ({ properties: { <name>: { type, description, items } }, required: [...] }). The
// SDK types each property value as `object`, so we narrow every field with `in` +
// `typeof` (no casts — the ru-fork rule) before reading it.

// `in` + `typeof` narrow a loosely-typed (`object`) JSON-Schema node cast-free — but `in` only
// narrows on a LITERAL key, so each field gets its own reader rather than a dynamic-key helper.

/** Read `node.type` as a string, or undefined. */
function schemaType(node: object): string | undefined {
  return "type" in node && typeof node.type === "string" ? node.type : undefined;
}

/** Read `node.description` as a string, or "". */
function schemaDescription(node: object): string {
  return "description" in node && typeof node.description === "string" ? node.description : "";
}

/** A human type label for a property: `string`, `number`, `string[]`, `array`, `object`, … */
function typeLabel(property: object): string {
  const base = schemaType(property) ?? "any";
  if (base !== "array" || !("items" in property)) {
    return base;
  }
  const items = property.items;
  if (typeof items === "object" && items !== null) {
    const itemType = schemaType(items);
    if (itemType !== undefined) {
      return `${itemType}[]`;
    }
  }
  return "array";
}

/** Map a tool's JSON-Schema inputSchema into the UI's flat param rows. */
export function paramsFromInputSchema(inputSchema: {
  readonly properties?: Readonly<Record<string, object>> | undefined;
  readonly required?: ReadonlyArray<string> | undefined;
}): McpToolParam[] {
  const properties = inputSchema.properties;
  if (properties === undefined) {
    return [];
  }
  const required = new Set(inputSchema.required ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: typeLabel(property),
    required: required.has(name),
    description: schemaDescription(property),
  }));
}

export type ProbeStatus = "online" | "offline";

/** Matches the per-server default; also the value we write into the qwen overlay. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Extra slack over the connect timeout before the hard monitor backstop fires. */
const BACKSTOP_MARGIN_MS = 5_000;

export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly tools: ReadonlyArray<McpTool>;
  readonly latencyMs: number;
  readonly message?: string;
  /** True when the probe hit a timeout (vs an explicit connection error). */
  readonly timedOut?: boolean;
  /** serverInfo.description reported on connect (the human blurb) — back-filled onto the catalog. */
  readonly serverDescription?: string;
  /** serverInfo.websiteUrl reported on connect (docs link) — back-filled onto the catalog. */
  readonly serverWebsiteUrl?: string;
}

class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Истекло время ожидания ответа MCP-сервера (${Math.round(timeoutMs / 1000)}с)`);
    this.name = "ProbeTimeoutError";
  }
}

export async function probeOnce(
  resolved: ResolvedServerConfig,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - startedAt);

  const client = new Client({ name: "ru-code-mcp-monitor", version: "0.0.0" });
  const transport = buildTransport(resolved);
  let stderrTail = "";
  // serverInfo (the Implementation in `initialize`) — captured after connect so the online return
  // can surface description/websiteUrl without changing connectAndList's return type.
  let serverInfo: ReturnType<Client["getServerVersion"]>;

  // Mirror qwen: advertise roots + answer ListRoots with the project dir, so
  // servers that query roots (e.g. filesystem) behave as they will under qwen.
  client.registerCapabilities({ roots: {} });
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: resolved.cwd
      ? [{ uri: pathToFileURL(resolved.cwd).toString(), name: basename(resolved.cwd) }]
      : [],
  }));

  let backstopTimer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<never>((_resolve, reject) => {
    backstopTimer = setTimeout(
      () => reject(new ProbeTimeoutError(timeoutMs)),
      timeoutMs + BACKSTOP_MARGIN_MS,
    );
  });

  const connectAndList = (async (): Promise<ReadonlyArray<McpTool>> => {
    // The SDK transports implement Transport but declare some optional props as
    // `T | undefined`, which trips exactOptionalPropertyTypes. They are valid
    // Transports at runtime — bridge the SDK's type strictness here.
    const connecting = client.connect(transport as Transport, { timeout: timeoutMs });
    // The child has spawned by now (Stdio.start() spawns synchronously) — pipe
    // its stderr so a failed install/launch shows the real error to the user.
    if (transport instanceof StdioClientTransport && transport.stderr) {
      transport.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
    }
    await connecting;
    serverInfo = client.getServerVersion();
    const listed = await client.listTools();
    return listed.tools.map((tool) => {
      const params = paramsFromInputSchema(tool.inputSchema);
      const description = tool.description ?? "";
      // Keep `params` optional-absent when empty (exactOptionalPropertyTypes) so a no-arg tool
      // stays `{name, description}` and the UI shows «Без параметров.» rather than an empty list.
      return params.length > 0
        ? { name: tool.name, description, params }
        : { name: tool.name, description };
    });
  })();

  try {
    const tools = await Promise.race([connectAndList, backstop]);
    return {
      status: "online",
      tools,
      latencyMs: elapsedMs(),
      ...(typeof serverInfo?.description === "string" ? { serverDescription: serverInfo.description } : {}),
      ...(typeof serverInfo?.websiteUrl === "string" ? { serverWebsiteUrl: serverInfo.websiteUrl } : {}),
    };
  } catch (error) {
    const timedOut = error instanceof ProbeTimeoutError;
    return {
      status: "offline",
      tools: [],
      latencyMs: elapsedMs(),
      message: failureMessage(error, stderrTail),
      ...(timedOut ? { timedOut: true } : {}),
    };
  } finally {
    if (backstopTimer !== undefined) {
      clearTimeout(backstopTimer);
    }
    // Closes the client AND kills the spawned child / socket even if connect
    // never resolved — the monitor must not leak processes.
    await client.close().catch(() => undefined);
    // The losing race branch may still reject later; swallow it so it never
    // surfaces as an unhandled rejection.
    connectAndList.catch(() => undefined);
  }
}

function failureMessage(error: unknown, stderrTail: string): string {
  const base = error instanceof Error ? error.message : String(error);
  const stderr = stderrTail.trim();
  if (stderr.length === 0) {
    return base;
  }
  // Last few non-empty stderr lines — usually the actual npm/process error.
  const tail = stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-3)
    .join(" · ");
  return `${base} — ${tail}`;
}

function buildTransport(
  resolved: ResolvedServerConfig,
): StdioClientTransport | StreamableHTTPClientTransport {
  if (resolved.transport === "http") {
    const headers = resolved.headers ?? {};
    const options: StreamableHTTPClientTransportOptions =
      Object.keys(headers).length > 0 ? { requestInit: { headers: { ...headers } } } : {};
    return new StreamableHTTPClientTransport(new URL(resolved.httpUrl ?? ""), options);
  }
  return new StdioClientTransport({
    command: resolved.command ?? "",
    args: [...(resolved.args ?? [])],
    env: { ...processEnvStrings(), ...resolved.env },
    ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
    stderr: "pipe",
  });
}

/** process.env with undefined values dropped (StdioClientTransport wants string-only). */
function processEnvStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
