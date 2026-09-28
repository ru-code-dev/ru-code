// @effect-diagnostics nodeBuiltinImport:off
// ru-code (S94 probe, moved in S99): running a case and READING its summary — shared by the S94
// cases (mcpProbe.e2e.test.ts) and the S99 fix specs (mcpFixes.e2e.test.ts). Not a test file, so
// importing it registers no suite.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runProbe, type ProbeKnobs, type ProbeRunResult } from "./mcpProbeRig.ts";

export const outRoot = (): string => {
  const dir =
    process.env["RU_CODE_MCP_PROBE_OUT"] ?? NodePath.join(NodeOS.tmpdir(), "s94-mcp-probe-out");
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
};
export const sandboxRoot = (): string => {
  const dir =
    process.env["RU_CODE_MCP_PROBE_SANDBOX"] ??
    NodePath.join(NodeOS.tmpdir(), "s94-mcp-probe-sandbox");
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
};

/** One case against `cli` (a bundle path), its evidence under `outRoot()/<case>`. */
export const runCase = (knobs: ProbeKnobs, cli: string): Promise<ProbeRunResult> =>
  runProbe(knobs, { cliJs: cli, outRoot: outRoot(), sandboxRoot: sandboxRoot() });

// ── reading a run's summary ──────────────────────────────────────────────────────────────────
export type Summary = ProbeRunResult["summary"];
export interface SessionProc {
  readonly proc: string;
  readonly sessionCall: "session/new" | "session/load";
  readonly sessionCallMs: number;
  readonly sessionId: string;
  readonly settingsPathEnv: string | null;
  readonly requestPermissionCount: number;
  readonly settings: ReadonlyArray<{
    readonly label: string;
    readonly exists: boolean;
    readonly sha256: string | null;
  }>;
  readonly probes: ReadonlyArray<{
    readonly label: string;
    readonly method: string;
    readonly result?: Record<string, unknown>;
  }>;
  readonly stderrMcpLines: ReadonlyArray<string>;
  readonly appCalls: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  readonly toolCalls: ReadonlyArray<{
    readonly ms: number;
    readonly kind: string;
    readonly status: string | null;
    readonly content: string;
  }>;
  readonly requestPermissions: ReadonlyArray<{ readonly params: unknown }>;
}
export interface ModelRequest {
  readonly probeTurn: string | null;
  readonly lastRole: string | null;
  readonly toolCount: number;
  readonly mcpToolCount: number;
  readonly mcpToolsByServer: { readonly local: number; readonly remote: number };
  readonly hasToolSearch: boolean;
  readonly mcpToolNamesInMessages: number;
  readonly mcpToolNamesInMessagesList: ReadonlyArray<string>;
  readonly addedMcpToolsReminder: boolean;
  readonly toolNames: ReadonlyArray<string>;
  readonly lastToolMessage: string | null;
  readonly ms: number;
  readonly bodyBytes: number;
  readonly mcpReminders: ReadonlyArray<{
    readonly head: string;
    readonly names: ReadonlyArray<string>;
  }>;
}
export interface McpRow {
  readonly event: string;
  readonly method: string | null;
  readonly clientInfo: { readonly name?: string } | null;
  readonly parent?: string;
  readonly cwd?: string;
  readonly envMarks?: Readonly<Record<string, string>>;
  readonly probeHeaders?: Readonly<Record<string, string>>;
}
export const mcpRows = (summary: Summary, kind: "local" | "remote"): McpRow[] =>
  (summary.mcp[kind] ?? []) as unknown as McpRow[];
export const fromQwen = (row: McpRow) =>
  (row.clientInfo?.name ?? "").startsWith("qwen-cli-mcp-client");
export const mainRequests = (summary: Summary, turn: string): ModelRequest[] =>
  (summary.model as unknown as ModelRequest[]).filter(
    (request) => request.probeTurn === turn && request.toolCount > 0,
  );
/** qwen's registry names for the server whose raw tool names start with `prefix` (L2 status). */
export const registryNames = (proc: SessionProc, prefix: string) => {
  const probe = proc.probes.findLast((entry) => {
    const tools = (entry.result?.["tools"] ?? []) as ReadonlyArray<{ serverToolName?: string }>;
    return (
      entry.method === "qwen/status/workspace/mcp/tools" &&
      tools.length > 0 &&
      (tools[0]?.serverToolName ?? "").startsWith(prefix)
    );
  });
  return (
    (probe?.result?.["tools"] ?? []) as ReadonlyArray<{
      name: string;
      serverToolName: string;
    }>
  ).map((tool) => ({ name: tool.name, raw: tool.serverToolName }));
};
export const completedToolText = (proc: SessionProc): string =>
  proc.toolCalls.find((call) => call.status === "completed")?.content ?? "";
export const firstSession = (summary: Summary): SessionProc => {
  const [proc] = sessions(summary);
  if (!proc) throw new Error("no session");
  return proc;
};
/** Every `context_usage` answer of a process, in order: [label, mcpTools list length, breakdown]. */
export const contextUsages = (proc: SessionProc) =>
  proc.probes
    .filter((probe) => probe.method === "qwen/status/session/context_usage")
    .map((probe) => {
      const usage = (probe.result?.["usage"] ?? {}) as {
        showDetails?: boolean;
        mcpTools?: ReadonlyArray<unknown>;
        breakdown?: { mcpTools?: number };
      };
      return {
        label: probe.label,
        showDetails: usage.showDetails,
        listed: usage.mcpTools?.length ?? 0,
        breakdownMcp: usage.breakdown?.mcpTools ?? 0,
      };
    });
export const configDump = (summary: Summary) => {
  const [dump] = summary.sessionConfigs;
  if (!dump) throw new Error("no [S94-PROBE] session-config line (log-patched bundle?)");
  return dump as {
    trustedFolder: boolean;
    approvalMode: string;
    settingsWarnings: unknown[];
    migrationWarnings: unknown[];
  };
};

export const sessions = (summary: Summary): SessionProc[] =>
  (summary.acpProcs as unknown as SessionProc[]).filter((proc) => proc.sessionCall !== null);
/** The server keys qwen got (the app's own, or the case's rename) — what qwen's names carry. */
export const keys = (summary: Summary) => summary.serverKeys as { local: string; remote: string };

/** Tools qwen registered for `server` in that process's session (debug `SessionMcpView`). */
export const registeredIn = (summary: Summary, proc: SessionProc, server: string): number =>
  Math.max(
    0,
    ...summary.registered
      .filter(
        (row) =>
          row.sessionId === proc.sessionId &&
          row.server === server &&
          row.ms >= proc.sessionCallMs - 1_000,
      )
      .map((row) => row.registered),
  );

/** The model request that opened scripted turn `turn` (not a tool continuation, not a side query). */
export const turnRequest = (summary: Summary, turn: string): ModelRequest => {
  const found = (summary.model as unknown as ModelRequest[]).find(
    (request) => request.probeTurn === turn && request.lastRole === "user",
  );
  if (!found) throw new Error(`no model request for ${turn}`);
  return found;
};

export const lastWorkspaceMcpStatus = (proc: SessionProc) =>
  (proc.probes.findLast((probe) => probe.method === "qwen/status/workspace/mcp")?.result?.[
    "servers"
  ] ?? []) as ReadonlyArray<Record<string, unknown>>;

export const debugHas = (summary: Summary, needle: string): boolean =>
  summary.debugLogMcpLines.some((line) => line.includes(needle));
