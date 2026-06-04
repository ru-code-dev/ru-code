/**
 * Shared, controlled form state for a server's transport config. Used by both the catalog
 * add/edit dialog and the per-project override dialog so the fields, captions and parsing
 * live in exactly one place (DRY).
 */

import type { McpServerConfig, McpTransport } from "../types";
import { parseEnvLines, parseHeaderLines } from "./addMcpParsing";

/** Editable, string-based mirror of an {@link McpServerConfig}. */
export interface ServerConfigDraft {
  readonly transport: McpTransport;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly httpUrl: string;
  readonly headersText: string;
}

export const EMPTY_DRAFT: ServerConfigDraft = {
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  httpUrl: "",
  headersText: "",
};

function recordToLines(record: Readonly<Record<string, string>>, separator: string): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

/** Build an editable draft from an existing config (for edit / override prefill). */
export function draftFromConfig(config: McpServerConfig): ServerConfigDraft {
  if (config.transport === "stdio") {
    return {
      ...EMPTY_DRAFT,
      transport: "stdio",
      command: config.command,
      argsText: config.args.join(" "),
      envText: recordToLines(config.env, "="),
    };
  }
  return {
    ...EMPTY_DRAFT,
    transport: "http",
    httpUrl: config.httpUrl,
    headersText: recordToLines(config.headers, ": "),
  };
}

export type DraftResult =
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: string };

/** Validate + convert a draft into a config, or return a user-facing error. */
export function configFromDraft(draft: ServerConfigDraft): DraftResult {
  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (command.length === 0) {
      return { ok: false, error: "Укажите команду для локального сервера." };
    }
    return {
      ok: true,
      config: {
        transport: "stdio",
        command,
        args: draft.argsText.split(/\s+/u).filter(Boolean),
        env: parseEnvLines(draft.envText),
      },
    };
  }
  const httpUrl = draft.httpUrl.trim();
  if (httpUrl.length === 0) {
    return { ok: false, error: "Укажите URL для удалённого сервера." };
  }
  return {
    ok: true,
    config: { transport: "http", httpUrl, headers: parseHeaderLines(draft.headersText) },
  };
}
