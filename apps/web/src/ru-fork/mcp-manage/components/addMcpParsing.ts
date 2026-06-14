/**
 * Pure parsing helpers for the Add-MCP dialog. Kept separate from the component so the
 * fiddly string→config logic stays testable and the JSX stays readable.
 */

import type { McpServerConfig, McpVar } from "../types";

/** Parse `Key: value` lines into a record. Blank lines and lines without `:` are ignored. */
export function parseHeaderLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0) result[key] = value;
  }
  return result;
}

export type AdvancedJsonResult =
  | { ok: true; config: McpServerConfig; vars: McpVar[]; timeoutMs?: number }
  | { ok: false; error: string };

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") result[key] = raw;
  }
  return result;
}

/** A pasted `env` block becomes plain vars — the standard MCP `env` maps onto our var model. */
function envToVars(env: Record<string, string>): McpVar[] {
  return Object.entries(env).map(([name, value]) => ({
    name,
    value,
    secret: false,
    perProject: false,
    required: false,
    hasStoredSecret: false,
    origin: "user",
    valueLocked: false,
  }));
}

function asTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1000
    ? Math.round(value)
    : undefined;
}

/**
 * Parse a raw MCP server JSON blob into a template {@link McpServerConfig} + vars. Accepts
 * the two shapes the product targets: `{command,args,env}` (stdio, env → vars) or
 * `{httpUrl,headers}` (streamable HTTP). An optional `timeout`/`timeoutMs` is carried out.
 */
export function parseAdvancedJson(text: string): AdvancedJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Некорректный JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Ожидается JSON-объект." };
  }
  const record = parsed as Record<string, unknown>;
  const timeoutMs = asTimeoutMs(record["timeoutMs"] ?? record["timeout"]);
  const withTimeout = timeoutMs !== undefined ? { timeoutMs } : {};

  if (typeof record["httpUrl"] === "string") {
    return {
      ok: true,
      config: { transport: "http", httpUrl: record["httpUrl"], headers: asStringRecord(record["headers"]) },
      vars: [],
      ...withTimeout,
    };
  }

  if (typeof record["command"] === "string") {
    const args = Array.isArray(record["args"])
      ? record["args"].filter((item): item is string => typeof item === "string")
      : [];
    return {
      ok: true,
      config: { transport: "stdio", command: record["command"], args },
      vars: envToVars(asStringRecord(record["env"])),
      ...withTimeout,
    };
  }

  return { ok: false, error: "Нужен ключ command (stdio) или httpUrl (http)." };
}
