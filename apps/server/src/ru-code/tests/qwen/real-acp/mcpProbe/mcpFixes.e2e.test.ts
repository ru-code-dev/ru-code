// @effect-diagnostics nodeBuiltinImport:off
// ru-code (S99, V2-65/V2-68): THE MCP FIX WAVE'S GUARDING SPECS — on REAL qwen 0.21.1 behind the
// REAL app, through the sealed rig (mcpProbeRig.ts). Each case boots the built app server with the
// `QG_` switches it names (acpSwitches.ts — the names are imported, never retyped), configures MCP
// the web's way and reads the four angles: what we wrote, what qwen reports, what each fake MCP
// server received, what the model got. One case per row of the S99 path table (brief §B).
//
// Gated like every MCP probe case (`RU_CODE_QWEN_CLI_JS` + `RU_CODE_MCP_PROBE=1`); run through
//   pnpm test:e2e:real-qwen "S99-"
// It needs `apps/server/dist` built (`pnpm build`) — the app under test is the built server.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { CLI_ENV } from "@ru-code/branding";
import { MCP_BUILTINS, qwenServerKey } from "@smart-tools/qwen-cli-mcp-manager/server";

import {
  QG_ACP_LOG_AVAILABLE_TOOLS,
  QG_ACP_LOG_STDERR,
  QG_MCP_ALWAYS_LOAD_TOOLS,
  QG_MCP_INJECT_BLOCKING_ENV,
} from "../../../../qwen/acpSwitches.ts";
import {
  completedToolText,
  firstSession,
  keys,
  mainRequests,
  mcpRows,
  registeredIn,
  registryNames,
  runCase,
  sandboxRoot,
  sessions,
  turnRequest,
  type Summary,
} from "./mcpProbeReaders.ts";
import { FAKE_MCP_STDIO, probeCliJs, type ProbeKnobs } from "./mcpProbeRig.ts";

const cliJs = probeCliJs();
const gated = describe.skipIf(cliJs === undefined);
const CASE_TIMEOUT_MS = 600_000;

/** The app-server env that turns the named switches on. */
const switchesOn = (...names: ReadonlyArray<string>): Readonly<Record<string, string>> =>
  Object.fromEntries(names.map((name) => [name, "1"]));

/**
 * The S99 base: LOCAL 10 stdio tools, REMOTE 10 http tools, the app's native prompt timing (the
 * proxy holds nothing), every switch off. A case changes only what its row is about.
 */
const base = (name: string, purpose: string, delta: Partial<ProbeKnobs>): ProbeKnobs => ({
  name,
  purpose,
  local: { tools: 10, delayMs: 6_000 },
  remote: { tools: 10, delayMs: 1_000 },
  holdPromptMs: 0,
  statusAtMs: [1_000],
  ...delta,
});

/** One overlay snapshot the proxy took (cliProxy.mjs `settings.jsonl`). */
interface OverlaySnapshot {
  readonly label: string;
  readonly exists: boolean;
  readonly text?: string;
  readonly mode?: string;
  readonly sha256?: string;
}

/** Every process the app spawned through the proxy: argv, `--acp` or not, env, overlay snapshots. */
const spawnedProcs = (
  outDir: string,
): ReadonlyArray<{
  readonly argv: ReadonlyArray<string>;
  readonly isAcp: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly settingsPath: string | undefined;
  readonly snapshots: ReadonlyArray<OverlaySnapshot>;
}> => {
  const cliDir = NodePath.join(outDir, "cli");
  return NodeFS.readdirSync(cliDir)
    .toSorted()
    .map((proc) => {
      const meta = JSON.parse(
        NodeFS.readFileSync(NodePath.join(cliDir, proc, "meta.json"), "utf8"),
      ) as { argv: string[]; isAcp: boolean; envSelected: Record<string, string> };
      const settingsFile = NodePath.join(cliDir, proc, "settings.jsonl");
      const snapshots = NodeFS.existsSync(settingsFile)
        ? NodeFS.readFileSync(settingsFile, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as OverlaySnapshot)
        : [];
      return {
        argv: meta.argv,
        isAcp: meta.isAcp,
        env: meta.envSelected,
        settingsPath: meta.envSelected["QWEN_CODE_SYSTEM_SETTINGS_PATH"],
        snapshots,
      };
    });
};

/** The `--allowed-mcp-server-names` tokens of an argv. */
const allowlistOf = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  (argv[argv.indexOf("--allowed-mcp-server-names") + 1] ?? "").split(",");

/** The overlay's `mcpServers` keys as qwen read them (the snapshot at `session/new|load`). */
const overlayKeysAtSession = (proc: {
  readonly snapshots: ReadonlyArray<OverlaySnapshot>;
}): ReadonlyArray<string> => {
  const atCall = proc.snapshots.find(
    (row) => row.label.startsWith("app sends session/") && row.exists,
  );
  if (atCall?.text === undefined) throw new Error("no overlay at session/new|load");
  return Object.keys((JSON.parse(atCall.text) as { mcpServers: object }).mcpServers);
};

/** The overlay file as the app handed it to the FIRST ACP process (proxy snapshot at exec). */
const overlayAtExec = (outDir: string): OverlaySnapshot & { readonly text: string } => {
  for (const proc of spawnedProcs(outDir)) {
    const exec = proc.snapshots.find((row) => row.label === "exec" && row.exists);
    if (exec?.text !== undefined) return { ...exec, text: exec.text };
  }
  throw new Error("no ACP process was handed an overlay file");
};

const overlayServers = (outDir: string): Record<string, Record<string, unknown>> =>
  (
    JSON.parse(overlayAtExec(outDir).text) as {
      mcpServers: Record<string, Record<string, unknown>>;
    }
  ).mcpServers;

/** The blocking-discovery var on a spawn: "1" under every alias, or absent under every alias. */
const blockingVar = (env: Readonly<Record<string, string>>): "1" | "absent" | "mixed" => {
  const values = CLI_ENV.LEGACY_MCP_BLOCKING.names.map((name) => env[name]);
  if (values.every((value) => value === "1")) return "1";
  if (values.every((value) => value === undefined)) return "absent";
  return "mixed";
};

/** Per session process: when the app sent `session/new|load` and when qwen answered it. */
const sessionTimings = (summary: Summary) =>
  (
    summary.acpProcs as unknown as ReadonlyArray<{
      readonly proc: string;
      readonly sessionCall: string | null;
      readonly sessionCallMs: number | null;
      readonly sessionId: string | null;
      readonly settingsPathEnv: string | null;
      readonly answers: { readonly sessionNew: number[]; readonly sessionLoad: number[] };
    }>
  )
    .filter((proc) => proc.sessionCall !== null)
    .map((proc) => ({
      proc: proc.proc,
      sessionId: proc.sessionId ?? "",
      warm: (proc.settingsPathEnv ?? "").includes("qwen-warm"),
      callMs: proc.sessionCallMs ?? 0,
      answerMs: proc.answers.sessionNew[0] ?? proc.answers.sessionLoad[0] ?? 0,
    }));

/** The readable keys the app gives the rig's two fake servers (`probe-local`, `probe-remote`). */
const expectReadableKeys = (summary: Summary): void => {
  expect(keys(summary).local).toMatch(/^probe_local_[0-9a-z]{4}$/);
  expect(keys(summary).remote).toMatch(/^probe_remote_[0-9a-z]{4}$/);
};

/** Both S99 MCP switches: the tools declared from turn 1 (S94 P-29). */
const BOTH_ON = switchesOn(QG_MCP_ALWAYS_LOAD_TOOLS, QG_MCP_INJECT_BLOCKING_ENV);

/** Every ACP process that set up a session: its allowlist tokens == its overlay's keys. */
const expectArgvMatchesFile = (outDir: string): number => {
  const withSession = spawnedProcs(outDir).filter(
    (proc) =>
      proc.isAcp && proc.snapshots.some((row) => row.label.startsWith("app sends session/")),
  );
  for (const proc of withSession) {
    expect([...allowlistOf(proc.argv)].toSorted()).toEqual(
      [...overlayKeysAtSession(proc)].toSorted(),
    );
  }
  return withSession.length;
};

/**
 * The overlay the first ACP process got, after qwen started: every snapshot the proxy took (at
 * exec, at `session/new`, before each answer, on any change) has the SAME bytes and mode 0600 —
 * qwen did not rewrite the secret-bearing file (S94 P-01 vs P-17).
 */
const expectOverlayUntouched = (outDir: string): void => {
  const proc = spawnedProcs(outDir).find((entry) =>
    entry.snapshots.some((row) => row.label === "exec" && row.exists),
  );
  if (!proc) throw new Error("no ACP process was handed an overlay file");
  const present = proc.snapshots.filter((row) => row.exists);
  expect(present.length).toBeGreaterThanOrEqual(3);
  expect(new Set(present.map((row) => row.sha256)).size).toBe(1);
  expect(new Set(present.map((row) => row.mode))).toEqual(new Set(["600"]));
};

/** One entry of the app server's log: `[HH:MM:SS.mmm] LEVEL (#n): message` + its field lines. */
interface AppLogEntry {
  readonly ms: number;
  readonly message: string;
  readonly body: string;
}

/** The app server's log (`app-server.log`, TZ=UTC), as entries with epoch ms. */
const appLog = (outDir: string): ReadonlyArray<AppLogEntry> => {
  const runDay = (
    JSON.parse(NodeFS.readFileSync(NodePath.join(outDir, "run-meta.json"), "utf8")) as {
      startedAt: string;
    }
  ).startedAt.slice(0, 10);
  const entries: Array<{ ms: number; message: string; body: string[] }> = [];
  for (const line of NodeFS.readFileSync(NodePath.join(outDir, "app-server.log"), "utf8").split(
    "\n",
  )) {
    const head = /^\[(\d\d:\d\d:\d\d\.\d{3})\] \w+ \(#\d+\): (.*)$/.exec(line);
    if (head) {
      entries.push({
        ms: Date.parse(`${runDay}T${head[1] ?? ""}Z`),
        message: head[2] ?? "",
        body: [],
      });
    } else {
      entries.at(-1)?.body.push(line);
    }
  }
  return entries.map((entry) => ({ ...entry, body: entry.body.join("\n") }));
};

/** The app log's `[cli-acp] stderr` entries — qwen's stderr lines (ACP_LOG_STDERR). */
const stderrLogged = (outDir: string): ReadonlyArray<AppLogEntry> =>
  appLog(outDir).filter((entry) => entry.message === "[cli-acp] stderr");

/**
 * qwen's stderr over time, from the proxy (`stderr-bytes.jsonl`): bytes written in total, the
 * lines of what was recorded, and `pending` — bytes written but not yet taken by the app.
 */
const stderrTimeline = (outDir: string) => {
  const cliDir = NodePath.join(outDir, "cli");
  const rows: Array<{ ms: number; total: number; pending: number }> = [];
  let lines = 0;
  for (const proc of NodeFS.readdirSync(cliDir)) {
    const file = NodePath.join(cliDir, proc, "stderr-bytes.jsonl");
    if (!NodeFS.existsSync(file)) continue;
    for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
      if (line.trim() !== "") rows.push(JSON.parse(line) as (typeof rows)[number]);
    }
    const log = NodePath.join(cliDir, proc, "stderr.log");
    if (NodeFS.existsSync(log)) {
      lines += NodeFS.readFileSync(log, "utf8").split("\n").length - 1;
    }
  }
  const total = Math.max(0, ...rows.map((row) => row.total));
  return {
    total,
    lines,
    totalAt: (ms: number) =>
      Math.max(0, ...rows.filter((row) => row.ms <= ms).map((row) => row.total)),
    pendingPeak: Math.max(0, ...rows.map((row) => row.pending)),
    pendingEnd: rows.at(-1)?.pending ?? 0,
  };
};

/** The session works: each named turn reached the model; the app respawned nothing. */
const expectSessionWorks = (summary: Summary, turns: ReadonlyArray<string>): void => {
  for (const turn of turns) expect(turnRequest(summary, turn).mcpToolCount).toBe(0);
  expect(summary.appSpawnReasons.filter((reason) => reason.startsWith("respawn"))).toEqual([]);
};

/**
 * What the app does when qwen dies mid-turn — read off the PRE-CHANGE build (logs/S99/B-07-red,
 * S99 report item 7) and required unchanged: the child exit is seen, the prompt fails as a
 * transport error classified C4 (Timeline+Notification), the session is torn down, and the next
 * turn is a fresh spawn that resumes the session (`session/load`) and is answered.
 */
const expectKilledTurnOutcome = (summary: Summary, outDir: string, killedMs: number): void => {
  const after = appLog(outDir).filter((entry) => entry.ms >= killedMs - 1_000);
  expect(
    after.some((entry) => entry.message === "[cli-adapter] ACP child exited unexpectedly"),
  ).toBe(true);
  expect(after.find((entry) => entry.message === "[cli-acp.request.failed]")?.body).toContain(
    "method: 'session/prompt'",
  );
  const runtime = after.filter((entry) => entry.message === "[runtime]");
  expect(runtime).toHaveLength(1);
  expect(runtime[0]?.body).toContain("code: 'C4'");
  expect(runtime[0]?.body).toContain("surface: 'Timeline+Notification'");
  expect(after.some((entry) => entry.message === "[cli-adapter] ACP session aborted")).toBe(true);
  expect(summary.appSpawnReasons).toEqual(["fresh-spawn", "fresh-spawn"]);
  expect(sessions(summary).filter((proc) => proc.sessionCall === "session/load")).toHaveLength(1);
  expect(turnRequest(summary, "turn 3").lastRole).toBe("user");
};

/** The app's own `qwen/status/session/context_usage` requests on the wire (not the proxy's probes). */
const appContextUsageCalls = (outDir: string): ReadonlyArray<Record<string, unknown>> => {
  const cliDir = NodePath.join(outDir, "cli");
  return NodeFS.readdirSync(cliDir).flatMap((proc) => {
    const file = NodePath.join(cliDir, proc, "wire.jsonl");
    if (!NodeFS.existsSync(file)) return [];
    return NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { dir: string; msg: Record<string, unknown> })
      .filter(
        (row) =>
          row.dir === "app->qwen" && row.msg["method"] === "qwen/status/session/context_usage",
      )
      .map((row) => row.msg["params"] as Record<string, unknown>);
  });
};

/**
 * The reinstall's older release, derived from TODAY's shipped list: context7_local exactly as
 * shipped (kept), context7_remote under an older name (changed), a built-in the new release no
 * longer ships (dropped — a fake stdio server, so qwen spawns nothing real for it), and no
 * filesystem (added by the new release).
 */
const shipped = (builtinId: string): Record<string, unknown> => {
  const found = MCP_BUILTINS.find((definition) => definition.builtinId === builtinId);
  if (found === undefined) throw new Error(`no shipped built-in ${builtinId}`);
  return { ...found };
};
const OLDER_RELEASE: ReadonlyArray<Record<string, unknown>> = [
  shipped("context7_local"),
  { ...shipped("context7_remote"), name: "Context7 Remote (beta)" },
  {
    builtinId: "legacy_probe",
    name: "Legacy Probe",
    config: {
      default: {
        transport: "stdio",
        command: process.execPath,
        args: [FAKE_MCP_STDIO, "--log", NodePath.join(sandboxRoot(), "legacy-probe.jsonl")],
      },
    },
    vars: [],
  },
];

interface McpSnapshotJson {
  readonly catalog: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly builtinId: string | null;
    readonly builtinHash: string | null;
  }>;
  readonly bindings: ReadonlyArray<{ readonly serverId: string; readonly enabled: boolean }>;
}

/** The app's catalog + bindings (`mcp.getSnapshot`) on the older release and after the reinstall. */
const reinstallSnapshots = (
  outDir: string,
): { readonly previousRelease: McpSnapshotJson; readonly reinstalled: McpSnapshotJson } =>
  (
    JSON.parse(NodeFS.readFileSync(NodePath.join(outDir, "run-meta.json"), "utf8")) as {
      mcpSnapshots: { previousRelease: McpSnapshotJson; reinstalled: McpSnapshotJson };
    }
  ).mcpSnapshots;

const builtinsOf = (snapshot: McpSnapshotJson): Record<string, string> =>
  Object.fromEntries(
    snapshot.catalog.flatMap((server) =>
      server.builtinId === null ? [] : [[server.builtinId, server.name]],
    ),
  );

/** Bytes the proxy saw qwen write to stderr, over every ACP process of the run. */
const qwenStderrBytes = (outDir: string): number => {
  const cliDir = NodePath.join(outDir, "cli");
  return NodeFS.readdirSync(cliDir)
    .map((proc) => NodePath.join(cliDir, proc, "stderr.log"))
    .filter((file) => NodeFS.existsSync(file))
    .reduce((total, file) => total + NodeFS.statSync(file).size, 0);
};

/** When qwen's debug log first shows `server` registered in that process's session. */
const registeredAt = (summary: Summary, sessionId: string, server: string): number | undefined =>
  summary.registered.find((row) => row.sessionId === sessionId && row.server === server)?.ms;

export const S99_CASES: ReadonlyArray<{
  readonly knobs: ProbeKnobs;
  readonly check: (summary: Summary, outDir: string) => void;
  /** Real network + npx (the real Playwright MCP): opt-in, like the S94 cases. */
  readonly playwright?: true;
}> = [
  {
    // path table: model | cold spawn, MCP_ALWAYS_LOAD_TOOLS on + MCP_INJECT_BLOCKING_ENV on
    knobs: base(
      "S99-01-cold-both-on",
      "both MCP switches on; cold spawn at the app's native timing; the model calls LOCAL and REMOTE tool 01",
      {
        appEnv: BOTH_ON,
        modelScript: ({ keys: key }) => [
          { name: `mcp__${key.local}__local_tool_01`, args: { query: "s99-local" } },
          { name: `mcp__${key.remote}__remote_tool_01`, args: { query: "s99-remote" } },
        ],
      },
    ),
    check: (summary, outDir) => {
      // readable keys, the same in the file and in the argv
      expectReadableKeys(summary);
      expect(expectArgvMatchesFile(outDir)).toBeGreaterThan(0);
      // turn 1 already declares every enabled tool, under qwen's intact names …
      const [first] = mainRequests(summary, "turn 1");
      expect(first?.mcpToolsByServer).toEqual({ local: 10, remote: 10, extra: 0 });
      expect(first?.toolNames).toContain(`mcp__${keys(summary).local}__local_tool_10`);
      expect(first?.toolNames).toContain(`mcp__${keys(summary).remote}__remote_tool_10`);
      // … and the startup reminder does not list them again (not deferred, client.ts:675)
      expect(first?.mcpReminders).toEqual([]);
      expect(first?.mcpToolNamesInMessages).toBe(0);
      // a real LOCAL and REMOTE call returns to the model
      expect(mcpRows(summary, "local").some((row) => row.method === "tools/call")).toBe(true);
      expect(mcpRows(summary, "remote").some((row) => row.method === "tools/call")).toBe(true);
      const results = mainRequests(summary, "turn 1").map((request) => request.lastToolMessage);
      expect(results.some((text) => text?.includes("FAKE-MCP-RESULT local local_tool_01"))).toBe(
        true,
      );
      expect(results.some((text) => text?.includes("FAKE-MCP-RESULT remote remote_tool_01"))).toBe(
        true,
      );
      expect(firstSession(summary).requestPermissionCount).toBe(0);
      expectOverlayUntouched(outDir);
    },
  },
  {
    // path table: model | warm take, both on
    knobs: base(
      "S99-02-warm-both-on",
      "both MCP switches on; turn 1 cold, then a 2nd thread on the project's MCP warm slot",
      { warmTake: true, appEnv: BOTH_ON },
    ),
    check: (summary, outDir) => {
      expectReadableKeys(summary);
      const warmProcs = spawnedProcs(outDir).filter((proc) =>
        (proc.settingsPath ?? "").includes("qwen-warm"),
      );
      expect(warmProcs.length).toBeGreaterThan(0);
      for (const proc of warmProcs) expect(blockingVar(proc.env)).toBe("1");
      // the slot's argv (baked at slot spawn) == the keys of the copy it read at session/new
      expect(expectArgvMatchesFile(outDir)).toBeGreaterThanOrEqual(2);
      const warm = turnRequest(summary, "warm turn");
      expect(warm.mcpToolsByServer).toEqual({ local: 10, remote: 10, extra: 0 });
      expect(warm.toolNames).toContain(`mcp__${keys(summary).local}__local_tool_10`);
    },
  },
  {
    // path table: model | MCP change → respawn → session/load (both on)
    knobs: base(
      "S99-07-resume-swap-both-on",
      "both MCP switches on; turn 1 with LOCAL+REMOTE; the app switches REMOTE off and EXTRA on; respawn + session/load; turn 2",
      {
        appEnv: BOTH_ON,
        extra: { tools: 10, delayMs: 1_000 },
        resume: "swap-remote-for-extra",
      },
    ),
    check: (summary, outDir) => {
      expectReadableKeys(summary);
      expect(summary.appSpawnReasons).toContain("respawn:mcp-servers-changed");
      expect(sessions(summary).some((proc) => proc.sessionCall === "session/load")).toBe(true);
      expect(expectArgvMatchesFile(outDir)).toBeGreaterThanOrEqual(2);
      expect(turnRequest(summary, "turn 1").mcpToolsByServer).toEqual({
        local: 10,
        remote: 10,
        extra: 0,
      });
      const resumed = turnRequest(summary, "turn 2 (resume)");
      expect(resumed.mcpToolsByServer).toEqual({ local: 10, remote: 0, extra: 10 });
      expect(resumed.toolNames.some((name) => name.includes("remote_tool_"))).toBe(false);
    },
  },
  {
    // path table: model | both off  +  overlay file | after qwen started
    knobs: base(
      "S99-06-both-off",
      "every switch off: qwen gets today's file and env except the readable keys and $version; turn 2 1 s after turn 1",
      { secondTurnAfterMs: 1_000 },
    ),
    check: (summary, outDir) => {
      expectReadableKeys(summary);
      const overlay = JSON.parse(overlayAtExec(outDir).text) as Record<string, unknown>;
      expect(Object.keys(overlay)).toEqual(["$version", "security", "mcpServers"]);
      expect(overlay["$version"]).toBe(4);
      expect(overlay["security"]).toEqual({ folderTrust: { enabled: false } });
      // today's entry shapes, nothing added
      const servers = overlayServers(outDir);
      expect(Object.keys(servers[keys(summary).local] ?? {}).toSorted()).toEqual(
        ["args", "command", "cwd", "env", "timeout", "trust"].toSorted(),
      );
      expect(Object.keys(servers[keys(summary).remote] ?? {}).toSorted()).toEqual(
        ["headers", "httpUrl", "timeout", "trust"].toSorted(),
      );
      for (const proc of spawnedProcs(outDir)) expect(blockingVar(proc.env)).toBe("absent");
      expect(expectArgvMatchesFile(outDir)).toBeGreaterThan(0);
      // what the model gets is today's: 0 MCP tools on every turn
      expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
      expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(0);
      expectOverlayUntouched(outDir);
    },
  },
  ...(["on", "off"] as const).map((log) => ({
    // path table: server log | ACP_LOG_STDERR on and off
    knobs: base(
      `S99-12${log === "on" ? "a" : "b"}-stderr-log-${log}`,
      `ACP_LOG_STDERR ${log}; LOCAL crashes at start (qwen writes its "failed to start" line to stderr); 2 turns`,
      {
        local: { tools: 10, delayMs: 6_000, crash: true },
        secondTurnAfterMs: 1_000,
        ...(log === "on" ? { appEnv: switchesOn(QG_ACP_LOG_STDERR) } : {}),
      },
    ),
    check: (summary: Summary, outDir: string) => {
      // qwen did write to stderr …
      expect(qwenStderrBytes(outDir)).toBeGreaterThan(0);
      // … and the app log has its lines only while the switch is on
      const logged = stderrLogged(outDir);
      if (log === "on") {
        expect(logged.some((entry) => entry.body.includes("failed to start"))).toBe(true);
      } else {
        expect(logged).toEqual([]);
        expect(appLog(outDir).some((entry) => entry.message.startsWith("[cli-acp] stderr"))).toBe(
          false,
        );
      }
      // nothing else changes: the session works, the model gets the same, no respawn
      expectSessionWorks(summary, ["turn 1", "turn 2"]);
    },
  })),
  ...(
    [
      ["a", "crash", "off"],
      ["b", "crash", "on"],
      ["c", "timeout", "off"],
      ["d", "timeout", "on"],
    ] as const
  ).map(([letter, failure, blocking]) => ({
    // path table: server log | a server fails to start / times out (ACP_LOG_STDERR on)
    knobs: base(
      `S99-13${letter}-${failure}-logged-blocking-${blocking}`,
      `ACP_LOG_STDERR on, MCP_INJECT_BLOCKING_ENV ${blocking}; LOCAL ${failure === "crash" ? "crashes at start" : "answers after 31 s (qwen's stdio cap is 30 s)"}; 2 turns`,
      {
        local:
          failure === "crash"
            ? { tools: 10, delayMs: 6_000, crash: true }
            : { tools: 10, delayMs: 31_000 },
        // blocking off: turn 2 after qwen's 30 s cap, so the timeout's line is in the run
        secondTurnAfterMs: failure === "timeout" && blocking === "off" ? 33_000 : 1_000,
        appEnv: switchesOn(
          QG_ACP_LOG_STDERR,
          ...(blocking === "on" ? [QG_MCP_INJECT_BLOCKING_ENV] : []),
        ),
      },
    ),
    check: (summary: Summary, outDir: string) => {
      const [timing] = sessionTimings(summary);
      if (!timing) throw new Error("no session");
      // qwen's own line, with qwen's key for the server, in the app's debug log …
      const line = stderrLogged(outDir).find((entry) => entry.body.includes("failed to start"));
      expect(line?.body).toContain(keys(summary).local);
      // … logged when qwen writes it: once the session is set up, and for a timeout only
      // after qwen's 30 s cap
      expect(line?.ms ?? 0).toBeGreaterThanOrEqual(timing.callMs - 1_000);
      if (failure === "timeout") {
        expect((line?.ms ?? 0) - timing.callMs).toBeGreaterThanOrEqual(29_000);
      }
      // and the session is untouched by it: session/new answered, turns work, no respawn
      expect(timing.answerMs).toBeGreaterThan(timing.callMs);
      expectSessionWorks(summary, ["turn 1", "turn 2"]);
      expect(registeredIn(summary, firstSession(summary), keys(summary).remote)).toBe(10);
    },
  })),
  ...(["off", "on"] as const).map((log) => ({
    // path table: qwen process | stderr flood > 1 MB mid-session  +  ACP_LOG_STDERR off
    knobs: base(
      `S99-14${log === "off" ? "a" : "b"}-stderr-flood-mid-session-log-${log}`,
      `the app runs with NODE_DEBUG=stream in its env (a developer's shell) — qwen inherits it and traces every stream write to stderr; the model streams each answer in 2000 chunks, so qwen floods stderr DURING the session; ACP_LOG_STDERR ${log}; 3 turns`,
      {
        secondTurnAfterMs: 1_000,
        thirdTurnAfterMs: 1_000,
        answerChunks: 2_000,
        appEnv: { NODE_DEBUG: "stream", ...(log === "on" ? switchesOn(QG_ACP_LOG_STDERR) : {}) },
      },
    ),
    check: (summary: Summary, outDir: string) => {
      const [timing] = sessionTimings(summary);
      if (!timing) throw new Error("no session");
      const flood = stderrTimeline(outDir);
      // the flood: > 1 MB written after session/new was answered
      expect(flood.total - flood.totalAt(timing.answerMs)).toBeGreaterThan(1_000_000);
      // … and every later turn works
      expectSessionWorks(summary, ["turn 1", "turn 2", "turn 3"]);
      if (log === "off") {
        // today's path: nothing reads it, nothing reaches the log. What the app's pipe cannot
        // hold stays queued in the WRITER — here the rig's proxy, a Node process like qwen: on
        // POSIX Node queues an unread pipe, it does not block. (On Windows Node's pipe stderr is
        // blocking, so a flood could stall the writer — Node's code, not measured; S99 F1.)
        expect(flood.pendingPeak).toBeGreaterThan(flood.total - 512 * 1024);
        expect(stderrLogged(outDir)).toEqual([]);
      } else {
        // every line logged; the writer's backlog drained
        expect(stderrLogged(outDir).length).toBeGreaterThanOrEqual(flood.lines);
        expect(flood.pendingEnd).toBe(0);
      }
    },
  })),
  {
    // path table: qwen process | qwen killed mid-session (ACP_LOG_STDERR on)
    knobs: base(
      "S99-15-qwen-killed-mid-turn",
      "ACP_LOG_STDERR on; turn 2's model request SIGKILLs the qwen serving it (a crash / OOM kill); turn 3 2 s after the kill",
      {
        secondTurnAfterMs: 1_000,
        killQwenOnTurn: "turn 2",
        thirdTurnAfterMs: 2_000,
        appEnv: switchesOn(QG_ACP_LOG_STDERR),
      },
    ),
    check: (summary: Summary, outDir: string) => {
      const killed = (
        JSON.parse(NodeFS.readFileSync(NodePath.join(outDir, "run-meta.json"), "utf8")) as {
          killedQwen?: { ms: number };
        }
      ).killedQwen;
      if (!killed) throw new Error("qwen was not killed");
      // today's exit path, unchanged (the pre-change build gives the same — S99 report)
      expectKilledTurnOutcome(summary, outDir, killed.ms);
      // the reader ended with the killed process — nothing left reading
      const ended = appLog(outDir).filter(
        (entry) =>
          entry.message === "[cli-acp] stderr reader ended" && entry.ms >= killed.ms - 1_000,
      );
      expect(ended.length).toBeGreaterThanOrEqual(1);
    },
  },
  ...(["on", "off"] as const).map((log) => ({
    // path table: server log | ACP_LOG_AVAILABLE_TOOLS on and off
    knobs: base(
      `S99-16${log === "on" ? "a" : "b"}-available-tools-log-${log}`,
      `both MCP switches on (the tools are declared); ACP_LOG_AVAILABLE_TOOLS ${log}; 2 turns`,
      {
        secondTurnAfterMs: 1_000,
        appEnv: switchesOn(
          QG_MCP_ALWAYS_LOAD_TOOLS,
          QG_MCP_INJECT_BLOCKING_ENV,
          ...(log === "on" ? [QG_ACP_LOG_AVAILABLE_TOOLS] : []),
        ),
      },
    ),
    check: (summary: Summary, outDir: string) => {
      const lines = appLog(outDir).filter((entry) => entry.message === "[cli-acp] available tools");
      const calls = appContextUsageCalls(outDir);
      if (log === "on") {
        // after each turn: the app asks with `detail: true` and logs the names the model has
        expect(calls).toHaveLength(2);
        for (const params of calls) expect(params["detail"]).toBe(true);
        expect(lines).toHaveLength(2);
        for (const line of lines) {
          expect(line.body).toContain(`${keys(summary).local}__local_tool_10`);
          expect(line.body).toContain(`${keys(summary).remote}__remote_tool_10`);
          expect(line.body).toContain("tool_search");
        }
      } else {
        expect(calls).toEqual([]);
        expect(lines).toEqual([]);
      }
      // nothing else changes: the model gets the same declared tools either way
      for (const turn of ["turn 1", "turn 2"]) {
        expect(turnRequest(summary, turn).mcpToolsByServer).toEqual({
          local: 10,
          remote: 10,
          extra: 0,
        });
      }
    },
  })),
  {
    // path table: upgrade | existing catalog + built-ins, reinstall
    knobs: base(
      "S99-18-reinstall",
      "an install from an OLDER RELEASE (today's built-ins with context7_remote under an older name, a since-dropped built-in, no filesystem) holding the two probe servers, all bound; the real build starts on the same data and runs a turn",
      {
        previousRelease: {
          builtins: OLDER_RELEASE,
          bindBuiltins: ["context7_remote", "legacy_probe"],
        },
      },
    ),
    check: (summary, outDir) => {
      const { previousRelease, reinstalled } = reinstallSnapshots(outDir);
      expect(builtinsOf(previousRelease)).toEqual({
        context7_local: "Context 7 Local",
        context7_remote: "Context7 Remote (beta)",
        legacy_probe: "Legacy Probe",
      });
      // the startup reconciliation, by builtinId: kept, changed, dropped, added
      expect(builtinsOf(reinstalled)).toEqual({
        context7_local: "Context 7 Local",
        context7_remote: "Context 7 Remote",
        filesystem: "filesystem",
      });
      const hashOf = (snapshot: McpSnapshotJson, builtinId: string) =>
        snapshot.catalog.find((server) => server.builtinId === builtinId)?.builtinHash;
      expect(hashOf(reinstalled, "context7_local")).toBe(hashOf(previousRelease, "context7_local"));
      expect(hashOf(reinstalled, "context7_remote")).not.toBe(
        hashOf(previousRelease, "context7_remote"),
      );
      const bound = (snapshot: McpSnapshotJson) =>
        snapshot.bindings.filter((binding) => binding.enabled).map((binding) => binding.serverId);
      expect(bound(previousRelease)).toContain("srv-builtin-legacy_probe");
      expect(bound(reinstalled)).not.toContain("srv-builtin-legacy_probe");
      expect(bound(reinstalled)).toContain("srv-builtin-context7_remote");
      // what qwen got after it: readable keys, the same in the file and the argv
      expect(expectArgvMatchesFile(outDir)).toBeGreaterThan(0);
      const proc = spawnedProcs(outDir).find((entry) => entry.isAcp);
      expect([...allowlistOf(proc?.argv ?? [])].toSorted()).toEqual(
        [
          keys(summary).local,
          keys(summary).remote,
          // the renamed built-in: the new name's slug, and the SAME 4-char suffix its key had under
          // the older release's name — the suffix belongs to the stable serverId, not to the name
          `context_7_remote_${qwenServerKey("Context7 Remote (beta)", "srv-builtin-context7_remote").slice(-4)}`,
        ].toSorted(),
      );
      expectReadableKeys(summary);
      expect(turnRequest(summary, "turn 1").lastRole).toBe("user");
    },
  },
  {
    // path table: model | a UI-unchecked tool (MCP_ALWAYS_LOAD_TOOLS on)
    knobs: base(
      "S99-09-unchecked-tool",
      "both MCP switches on; LOCAL local_tool_07 unchecked in the app (tool policy exception)",
      {
        appEnv: BOTH_ON,
        localToolPolicy: { defaultDecision: "allow", exceptions: ["local_tool_07"] },
      },
    ),
    check: (summary, outDir) => {
      expectReadableKeys(summary);
      // the policy stays on the raw tool name; only the server key is qwen-facing
      expect(overlayServers(outDir)[keys(summary).local]?.["excludeTools"]).toEqual([
        "local_tool_07",
      ]);
      const request = turnRequest(summary, "turn 1");
      expect(request.mcpToolsByServer).toEqual({ local: 9, remote: 10, extra: 0 });
      expect(request.toolNames.some((name) => name.endsWith("__local_tool_07"))).toBe(false);
    },
  },
  {
    // path table: model | real Playwright MCP, readable key (switches off)
    playwright: true,
    knobs: base(
      "S99-10-playwright-readable-key",
      'REAL @playwright/mcp (warm npm cache) configured as the user does ("playwright", stdio); switches off; prompt held 20 s; the model searches the plain name browser_take_screenshot',
      {
        realLocalServer: {
          name: "playwright",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
        },
        localDraft: {
          vars: [
            {
              name: "npm_config_cache",
              secret: false,
              perProject: false,
              required: false,
              value: NodePath.join(sandboxRoot(), "npm-cache-warm"),
            },
          ],
        },
        holdPromptMs: 20_000,
        statusAtMs: [1_000, 15_000],
        modelScript: () => [{ name: "tool_search", args: { query: "browser_take_screenshot" } }],
      },
    ),
    check: (summary) => {
      const key = keys(summary).local;
      expect(key).toMatch(/^playwright_[0-9a-z]{4}$/);
      const tools = registryNames(firstSession(summary), "browser_");
      expect(tools.length).toBeGreaterThanOrEqual(20);
      // every name intact: qwen's name is exactly mcp__<key>__<the server's own name>
      for (const tool of tools) expect(tool.name).toBe(`mcp__${key}__${tool.raw}`);
      // switch off ⇒ deferred; the model finds the tool by its plain name
      expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
      expect(completedToolText(firstSession(summary))).toContain(
        `mcp__${key}__browser_take_screenshot`,
      );
    },
  },
  {
    // path table: model | MCP_ALWAYS_LOAD_TOOLS on, blocking off, turn sent while servers load
    knobs: base(
      "S99-03-always-load-while-loading",
      "MCP_ALWAYS_LOAD_TOOLS on, blocking off; LOCAL answers after 20 s, REMOTE after 1 s; turn 1 at the app's native timing, turn 2 5 s later (REMOTE registered, LOCAL still loading)",
      {
        local: { tools: 10, delayMs: 20_000 },
        secondTurnAfterMs: 5_000,
        appEnv: switchesOn(QG_MCP_ALWAYS_LOAD_TOOLS),
      },
    ),
    check: (summary, outDir) => {
      // what we wrote: every entry declares its tools
      for (const entry of Object.values(overlayServers(outDir))) {
        expect(entry["alwaysLoadTools"]).toBe(true);
      }
      const [proc] = sessions(summary);
      if (!proc) throw new Error("no session");
      const turnOne = turnRequest(summary, "turn 1");
      const turnTwo = turnRequest(summary, "turn 2");
      expect(turnOne.mcpToolCount).toBe(0);
      // REMOTE was registered before turn 2 left, LOCAL was not …
      const remoteAt = registeredAt(summary, proc.sessionId, keys(summary).remote);
      const localAt = registeredAt(summary, proc.sessionId, keys(summary).local);
      expect(remoteAt).toBeLessThan(turnTwo.ms);
      expect(localAt ?? Number.POSITIVE_INFINITY).toBeGreaterThan(turnTwo.ms); // (or never, before teardown)
      // … and qwen declares nothing until the WHOLE discovery ends (config.ts:3100,3114).
      expect(turnTwo.mcpToolCount).toBe(0);
    },
  },
  {
    // path table: model | MCP_ALWAYS_LOAD_TOOLS on, blocking off, turn sent after the whole discovery
    knobs: base(
      "S99-04-always-load-after-discovery",
      "MCP_ALWAYS_LOAD_TOOLS on, blocking off; turn 1 at native timing, turn 2 released once qwen logged BOTH servers loaded, turn 3 2 s later",
      {
        secondTurnAfterMs: 0,
        secondTurnAfterServersLoaded: true,
        thirdTurnAfterMs: 2_000,
        appEnv: switchesOn(QG_MCP_ALWAYS_LOAD_TOOLS),
      },
    ),
    check: (summary, outDir) => {
      // blocking off ⇒ no spawn carries the blocking var
      for (const proc of spawnedProcs(outDir)) expect(blockingVar(proc.env)).toBe("absent");
      const [proc] = sessions(summary);
      if (!proc) throw new Error("no session");
      const loadedAt = Math.max(
        registeredAt(summary, proc.sessionId, keys(summary).local) ?? Infinity,
        registeredAt(summary, proc.sessionId, keys(summary).remote) ?? Infinity,
      );
      expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
      for (const turn of ["turn 2", "turn 3"]) {
        const request = turnRequest(summary, turn);
        expect(request.ms).toBeGreaterThan(loadedAt);
        expect(request.mcpToolsByServer).toEqual({ local: 10, remote: 10, extra: 0 });
        // qwen's own names, intact: mcp__<key>__<tool>
        expect(request.toolNames).toContain(`mcp__${keys(summary).local}__local_tool_10`);
        expect(request.toolNames).toContain(`mcp__${keys(summary).remote}__remote_tool_10`);
        expect(request.hasToolSearch).toBe(true);
      }
      expect(registeredIn(summary, proc, keys(summary).local)).toBe(10);
    },
  },
  {
    // path table: model | MCP_ALWAYS_LOAD_TOOLS off, blocking on
    knobs: base(
      "S99-05-blocking-only",
      "MCP_INJECT_BLOCKING_ENV on, MCP_ALWAYS_LOAD_TOOLS off; LOCAL answers after 6 s; turn 1 at native timing, turn 2 1 s after it",
      { secondTurnAfterMs: 1_000, appEnv: switchesOn(QG_MCP_INJECT_BLOCKING_ENV) },
    ),
    check: (summary, outDir) => {
      for (const proc of spawnedProcs(outDir).filter((entry) => entry.isAcp)) {
        expect(blockingVar(proc.env)).toBe("1");
      }
      // session/new waited for the WHOLE discovery (qwen's legacy blocking path)
      const [timing] = sessionTimings(summary);
      if (!timing) throw new Error("no session");
      for (const server of [keys(summary).local, keys(summary).remote]) {
        expect(registeredAt(summary, timing.sessionId, server)).toBeLessThan(timing.answerMs);
      }
      expect(timing.answerMs - timing.callMs).toBeGreaterThan(5_000);
      // … and the tools stay deferred: 0 declared on every turn
      expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
      expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(0);
    },
  },
  ...(["off", "on"] as const).map((blocking) => ({
    // path table: model | no MCP configured (blocking on and off)
    knobs: base(
      `S99-08${blocking === "off" ? "a" : "b"}-no-app-mcp-blocking-${blocking}`,
      `no MCP server in the app; the user declared one in <QWEN_HOME>/settings.json and one in <workspace>/.qwen/settings.json; MCP_INJECT_BLOCKING_ENV ${blocking}`,
      {
        appMcp: false,
        userServer: true,
        workspaceServer: true,
        // then a 2nd thread on the GENERIC warm spare (a project without MCP)
        warmTake: true,
        ...(blocking === "on" ? { appEnv: switchesOn(QG_MCP_INJECT_BLOCKING_ENV) } : {}),
      },
    ),
    check: (summary: Summary, outDir: string) => {
      const acp = spawnedProcs(outDir).filter((entry) => entry.isAcp);
      // the cold spawn and the generic warm spare the 2nd thread took
      expect(acp.some((proc) => (proc.settingsPath ?? "").includes("qwen-warm"))).toBe(true);
      for (const proc of acp) {
        expect(blockingVar(proc.env)).toBe(blocking === "on" ? "1" : "absent");
        // the allowlist nothing can match
        expect(proc.argv).toContain("__none__");
      }
      // session/new is not delayed, cold or warm …
      const timings = sessionTimings(summary);
      expect(timings.map((timing) => timing.warm).toSorted()).toEqual([false, true]);
      for (const timing of timings) expect(timing.answerMs - timing.callMs).toBeLessThan(2_000);
      // … and the user's own servers never connect
      expect(summary.mcp["user"]).toHaveLength(0);
      expect(summary.mcp["workspace"]).toHaveLength(0);
      expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
    },
  })),
  {
    // path table: env | MCP_INJECT_BLOCKING_ENV on — every --acp spawn incl. warm spares
    knobs: base(
      "S99-11-blocking-env-warm-spares",
      "MCP_INJECT_BLOCKING_ENV on; turn 1 cold, then a 2nd thread on the project's MCP warm slot",
      { warmTake: true, appEnv: switchesOn(QG_MCP_INJECT_BLOCKING_ENV) },
    ),
    check: (summary, outDir) => {
      const procs = spawnedProcs(outDir);
      const acp = procs.filter((entry) => entry.isAcp);
      // the cold spawn and the project's MCP warm slots — every one of them (the generic spare:
      // S99-08b)
      expect(acp.some((proc) => (proc.settingsPath ?? "").includes("qwen-warm"))).toBe(true);
      for (const proc of acp) expect(blockingVar(proc.env)).toBe("1");
      // and no other spawn (the app's --version provider probe)
      const others = procs.filter((entry) => !entry.isAcp);
      expect(others.length).toBeGreaterThan(0);
      for (const proc of others) expect(blockingVar(proc.env)).toBe("absent");
      // the warm slot's session/new waited for discovery too
      const warm = sessionTimings(summary).find((timing) => timing.warm);
      if (!warm) throw new Error("no warm session");
      for (const server of [keys(summary).local, keys(summary).remote]) {
        expect(registeredAt(summary, warm.sessionId, server)).toBeLessThan(warm.answerMs);
      }
    },
  },
];

gated("S99 MCP fixes — real qwen 0.21.1 behind the real app", () => {
  for (const { knobs, check, playwright } of S99_CASES) {
    it.skipIf(playwright === true && process.env["RU_CODE_MCP_PROBE_PLAYWRIGHT"] !== "1")(
      knobs.name,
      async () => {
        const { summary, outDir } = await runCase(knobs, cliJs as string);
        expect(summary.error).toBeNull();
        check(summary, outDir);
      },
      CASE_TIMEOUT_MS,
    );
  }
});
