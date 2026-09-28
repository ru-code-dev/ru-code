// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// ru-code (S94 probe): MCP servers configured in the app vs what REAL qwen 0.21.1 sees.
//
// Each case is one run of `mcpProbeRig.ts`: a fresh app server, real qwen behind the recording
// proxy, two fake MCP servers (LOCAL stdio + REMOTE streamable HTTP) and a fake model. The
// baseline is what a user gets today; every other case turns ONE knob against it. The run's raw
// evidence lands under `$RU_CODE_MCP_PROBE_OUT/<case>` (the S94 report cites it cell by cell);
// the assertions pin what the run showed.
//
// GATED twice: the real bundle (`RU_CODE_QWEN_CLI_JS`, as the rest of real-acp) AND
// `RU_CODE_MCP_PROBE=1`, because a case takes up to a few minutes. The run script sets both
// from the bundle constant (ru-code/qwen-real-harness/README.md "Running it"):
//
//   pnpm test:e2e:real-qwen "<case>"
//
// It needs `apps/server/dist` built (`pnpm build`) — the app under test is the built server.

import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  completedToolText,
  configDump,
  contextUsages,
  debugHas,
  firstSession,
  fromQwen,
  keys,
  lastWorkspaceMcpStatus,
  mainRequests,
  mcpRows,
  registeredIn,
  registryNames,
  runCase,
  sandboxRoot,
  sessions,
  turnRequest,
  type ModelRequest,
  type SessionProc,
  type Summary,
} from "./mcpProbeReaders.ts";
import { probeCliJs, serverKeyToken, type ProbeKnobs, type ProbeRunResult } from "./mcpProbeRig.ts";

const cliJs = probeCliJs();
const gated = describe.skipIf(cliJs === undefined);

const run = (knobs: ProbeKnobs, cli: string = cliJs as string): Promise<ProbeRunResult> =>
  runCase(knobs, cli);

/**
 * S94 addendum 3 runs a LOG-ONLY patched bundle (WORKFLOW/logs/S94/P-patch-logonly.diff: one
 * `debugLogger.debug` dumping the per-scope, merged and effective settings of each session). Its
 * cases run only when that bundle is named; every other case runs the unpatched bundle.
 */
const logPatchedCliJs = process.env["RU_CODE_MCP_PROBE_LOGPATCH_CLI_JS"]?.trim() || undefined;

/** The baseline (brief): LOCAL 50 tools / 25 s, REMOTE 50 tools / 4 s, cold, prompt after discovery. */
export const BASELINE: ProbeKnobs = {
  name: "P-01-baseline",
  purpose:
    "baseline: LOCAL stdio 50 tools answering after 25 s, REMOTE http 50 tools after 4 s, configured through the app, cold spawn, the prompt reaching qwen 35 s after session/new",
  local: { tools: 50, delayMs: 25_000 },
  remote: { tools: 50, delayMs: 4_000 },
  holdPromptMs: 35_000,
  statusAtMs: [1_000, 33_000],
  // S94's app wrote no `$version` (S99 item 6 adds it): kept as an explicit knob, so P-01 still
  // shows qwen rewriting a version-less file. A case with its own transform replaces this one.
  transform: () => ({ deleteSettingsKeys: ["$version"] }),
};

const pad = (n: number) => String(n).padStart(2, "0");
const toolNames = (server: string, prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `mcp__${server}__${prefix}_tool_${pad(index + 1)}`);

/** ONE knob against the baseline — every other field stays the baseline's. */
const knob = (name: string, purpose: string, delta: Partial<ProbeKnobs>): ProbeKnobs => ({
  ...BASELINE,
  ...delta,
  name,
  purpose,
});

// §5 trust checks — each app-set trust switch removed/flipped, one at a time.
export const TRUST_CASES: ReadonlyArray<ProbeKnobs> = [
  knob("P-02-trust-no-foldertrust-key", "overlay without security.folderTrust.enabled:false", {
    transform: () => ({ deleteSettingsKeys: ["security"] }),
  }),
  knob("P-03-trust-no-server-trust", "overlay servers without trust:true", {
    transform: () => ({ deleteServerKeys: ["trust"] }),
  }),
  knob("P-04-trust-no-allowlist-flag", "argv without --allowed-mcp-server-names <ids>", {
    transform: () => ({ dropAllowedFlag: true }),
  }),
  knob(
    "P-05-trust-approval-yolo",
    "the app's per-turn approval mode (auto-edit) rewritten to yolo",
    {
      transform: () => ({ setModeOverride: "yolo" }),
    },
  ),
  knob(
    "P-06-trust-process-cwd-statedir",
    "qwen's process cwd = <stateDir> (as a warm slot) instead of the thread cwd",
    {
      transform: () => ({ childCwd: "@STATEDIR@" }),
    },
  ),
];

// §6 knobs — one value per case.
export const KNOB_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-07-spawn-warm-take",
    "turn 1 cold, then a 2nd thread on the project's MCP warm slot (the app's real take path)",
    {
      warmTake: true,
    },
  ),
  knob("P-08-delay-local-31s", "LOCAL answers after 31 s (over qwen's 30 s stdio default)", {
    local: { tools: 50, delayMs: 31_000 },
  }),
  knob("P-09-delay-remote-6s", "REMOTE answers after 6 s (over qwen's 5 s remote default)", {
    remote: { tools: 50, delayMs: 6_000 },
  }),
  knob(
    "P-10-discovery-timeout-raised",
    "LOCAL 31 s + REMOTE 6 s, each server entry carrying discoveryTimeoutMs 60000",
    {
      local: { tools: 50, delayMs: 31_000 },
      remote: { tools: 50, delayMs: 6_000 },
      transform: () => ({ serverMerge: { discoveryTimeoutMs: 60_000 } }),
    },
  ),
  knob("P-11-legacy-blocking", "QWEN_CODE_LEGACY_MCP_BLOCKING=1 in qwen's env", {
    childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
  }),
  knob(
    "P-12-prompt-immediate",
    "the prompt forwarded as the app sends it (no hold) — the app's native timing",
    {
      holdPromptMs: 0,
    },
  ),
  knob("P-13-toolsearch-disabled", "overlay tools.toolSearch.enabled:false", {
    transform: () => ({ settingsMerge: { tools: { toolSearch: { enabled: false } } } }),
  }),
  knob("P-14-always-load-tools", "every overlay server entry alwaysLoadTools:true", {
    transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
  }),
  knob("P-15-tools-visible", "overlay tools.visible = all 100 qualified MCP tool names", {
    transform: () => ({ settingsMerge: { tools: { visible: allVisible() } } }),
  }),
  knob("P-16-tool-count-2", "2 tools per server instead of 50", {
    local: { tools: 2, delayMs: 25_000 },
    remote: { tools: 2, delayMs: 4_000 },
  }),
  knob("P-17-version-present", 'overlay carries "$version": 4', {
    transform: () => ({ settingsMerge: { $version: 4 } }),
  }),
  knob("P-18-channel-acp", "servers moved from the settings file into ACP session/new.mcpServers", {
    transform: () => ({ channel: "acp" }),
  }),
  knob("P-19-failure-local-crash", "LOCAL crashes at start (exit 1 before reading stdin)", {
    local: { tools: 50, delayMs: 25_000, crash: true },
  }),
  knob(
    "P-20-failure-workspace-server",
    "a third server declared by the user in <workspace>/.qwen/settings.json",
    {
      workspaceServer: true,
    },
  ),
  // Added (S94-probe §6): the baseline shows the prompt carries no MCP tool and no late-MCP
  // reminder; does a LATER turn on the same live session ever get them?
  knob("P-21-second-turn", "a 2nd turn on the same thread/session 5 s after the 1st answered", {
    secondTurnAfterMs: 5_000,
  }),
  // Added (S94-probe §6): P-10 shows LOCAL at 31 s still dying at 30 s with discoveryTimeoutMs
  // 60000 ("MCP error -32001: Request timed out") — the entry's own `timeout: 30000`, which the
  // app writes, caps the request. Both raised isolates that cap.
  knob(
    "P-22-both-timeouts-raised",
    "LOCAL 31 s + REMOTE 6 s, entries with discoveryTimeoutMs 60000 AND timeout 60000",
    {
      local: { tools: 50, delayMs: 31_000 },
      remote: { tools: 50, delayMs: 6_000 },
      transform: () => ({ serverMerge: { discoveryTimeoutMs: 60_000, timeout: 60_000 } }),
    },
  ),
  // Added (S94-probe §6): in P-20 the workspace-declared server leaves no trace at all; this
  // separates the app's allowlist (argv) from qwen's workspace approval gate.
  knob(
    "P-23-workspace-server-no-allowlist",
    "P-20's workspace-declared server with the allowlist flag dropped",
    {
      workspaceServer: true,
      transform: () => ({ dropAllowedFlag: true }),
    },
  ),
  // Added (S94-probe §6): the baseline model is never told the MCP tools exist. Does a model that
  // searches anyway reach them? The fake model answers turn 1 with `tool_search "fake local tool"`.
  // Added (S94-probe §6): P-13/14/15 make the tools visible with the prompt held past discovery;
  // the app itself prompts right after session/new (P-12). Does the lever hold on turn 1?
  knob(
    "P-28-always-load-immediate",
    "alwaysLoadTools:true on every entry AND the app's native prompt timing (no hold)",
    {
      holdPromptMs: 0,
      transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
    },
  ),
  // Added (S94-probe §6): P-28 fails on turn 1 for lack of finished discovery, P-11 finishes it
  // but only names the tools. The two together, at the app's native timing:
  knob(
    "P-29-blocking-always-load-immediate",
    "QWEN_CODE_LEGACY_MCP_BLOCKING=1 + alwaysLoadTools:true + the app's native prompt timing",
    {
      holdPromptMs: 0,
      childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
      transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
    },
  ),
  knob("P-24-model-calls-tool-search", "the model answers turn 1 with a tool_search keyword call", {
    modelToolSearchQuery: "fake local tool",
  }),
];

// ADDENDUM (owner go, 2026-09-27) — the `session/load` knob: the app's real resume after a respawn.
export const RESUME_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-25-load-cold-after-mcp-change",
    "session/load after an MCP-change respawn, COLD (LOCAL bound between turn 1 and turn 2)",
    {
      resume: "cold-add-server",
    },
  ),
  knob(
    "P-26-load-warm-after-mcp-change",
    "session/load after an MCP-change respawn, WARM (one LOCAL tool switched off; the app takes the MCP slot)",
    {
      resume: "warm-toggle-tool",
    },
  ),
  knob(
    "P-27-load-after-ttl-expiry",
    "session/load from the no-change respawn after the 30-min spawn-record expiry (server clock +31 min)",
    {
      resume: "ttl-expiry",
    },
  ),
];

// ADDENDUM 2 (owner go, 2026-09-27) — the server key × the tool-name length. Blocking discovery so
// the startup reminder carries the MCP names (P-11); 5 tools per server; the model searches for
// LOCAL tool 03 by its PLAIN name.
const plainToolName = (prefix: string, nameLen: number, index: number): string =>
  `${`${prefix}_navigate_to_the_page_and_capture_a_full_screenshot_of_it_now`.slice(0, nameLen - 3)}_${pad(index)}`;
const serverKeyCase = (name: string, shortKeys: boolean, nameLen: number): ProbeKnobs =>
  knob(
    name,
    `server key ${shortKeys ? "short (probe-local / probe-remote)" : "srv-<uuid>"} × tool names of ${String(nameLen)} chars; blocking discovery; the model runs tool_search for LOCAL tool 03's plain name`,
    {
      local: { tools: 5, delayMs: 25_000, nameLen },
      remote: { tools: 5, delayMs: 4_000, nameLen },
      holdPromptMs: 0,
      childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
      serverKeys: shortKeys ? { local: "probe-local", remote: "probe-remote" } : "catalog-ids",
      modelScript: () => [
        { name: "tool_search", args: { query: plainToolName("local", nameLen, 3) } },
      ],
    },
  );
export const SERVER_KEY_CASES: ReadonlyArray<ProbeKnobs> = [
  serverKeyCase("P-30-key-uuid-name16", false, 16),
  serverKeyCase("P-31-key-uuid-name25", false, 25),
  serverKeyCase("P-32-key-uuid-name40", false, 40),
  serverKeyCase("P-33-key-short-name16", true, 16),
  serverKeyCase("P-34-key-short-name25", true, 25),
  serverKeyCase("P-35-key-short-name40", true, 40),
];

// ADDENDUM 3 (owner go, 2026-09-27) — overlay FORMAT proof: every key the app's writer emits
// (McpOverlay.ts:105-141,228-236), each with its observable effect. Short server delays; the
// tools are made visible (alwaysLoadTools) so the model request can show which ones qwen kept.
const callLocalTool01 = ({ keys }: { keys: { local: string } }) => [
  { name: `mcp__${keys.local}__local_tool_01`, args: { query: "probe" } },
];
const formatBase: Partial<ProbeKnobs> = {
  local: { tools: 50, delayMs: 2_000 },
  remote: { tools: 50, delayMs: 1_000 },
  holdPromptMs: 8_000,
  statusAtMs: [1_000, 6_000],
  transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
};
export const FORMAT_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-40-format-keys",
    "env (plain + secret var), cwd, headers (config + extra), excludeTools, trust:true — one tool call",
    {
      ...formatBase,
      localDraft: {
        vars: [
          {
            name: "PROBE_MARK_PLAIN",
            secret: false,
            perProject: false,
            required: false,
            value: "plain-marker-1",
          },
          {
            name: "PROBE_MARK_SECRET",
            secret: true,
            perProject: false,
            required: false,
            value: "secret-marker-2",
          },
        ],
      },
      remoteDraft: {
        headers: { "X-Probe-Config": "cfg-1" },
        extraHeaders: { "X-Probe-Extra": "extra-1" },
      },
      localToolPolicy: { defaultDecision: "allow", exceptions: ["local_tool_50"] },
      modelScript: callLocalTool01,
    },
  ),
  knob(
    "P-41-format-timeout",
    "LOCAL timeoutMs 5000 (the entry's `timeout`), its tools/call answering after 8 s",
    {
      ...formatBase,
      local: { tools: 50, delayMs: 2_000, callDelayMs: 8_000 },
      localDraft: { timeoutMs: 5_000 },
      modelScript: callLocalTool01,
    },
  ),
  knob("P-42-format-trust-false", "LOCAL «Доверять серверу» off (trust:false) — one tool call", {
    ...formatBase,
    localDraft: { trust: false },
    modelScript: callLocalTool01,
    stopOnPermissionRequest: true,
  }),
  knob(
    "P-43-format-include-tools",
    "LOCAL policy deny-all-but [local_tool_01, local_tool_02] ⇒ includeTools",
    {
      ...formatBase,
      localToolPolicy: { defaultDecision: "deny", exceptions: ["local_tool_01", "local_tool_02"] },
    },
  ),
  knob(
    "P-44-format-foldertrust-used",
    "the USER enabled folder trust and marked the workspace DO_NOT_TRUST; the app's overlay as written",
    {
      ...formatBase,
      userSettings: { security: { folderTrust: { enabled: true } } },
      trustedFolders: (workspace) => ({ [workspace]: "DO_NOT_TRUST" }),
    },
  ),
  knob(
    "P-45-format-foldertrust-removed",
    "P-44 with the overlay's security.folderTrust key removed",
    {
      ...formatBase,
      userSettings: { security: { folderTrust: { enabled: true } } },
      trustedFolders: (workspace) => ({ [workspace]: "DO_NOT_TRUST" }),
      transform: () => ({
        serverMerge: { alwaysLoadTools: true },
        deleteSettingsKeys: ["security"],
      }),
    },
  ),
];

// ADDENDUM 4 (owner go, 2026-09-27) — the other undeferring keys at the app's native prompt timing,
// with default and with blocking discovery; turn 2 on the same session 30 s after turn 1.
/** Every qualified MCP tool name qwen will register — its keys filled in by the proxy. */
function allVisible(): string[] {
  return [
    ...toolNames(serverKeyToken("local"), "local", 50),
    ...toolNames(serverKeyToken("remote"), "remote", 50),
  ];
}
export const NATIVE_TIMING_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-50-toolsearch-off-native",
    "tools.toolSearch.enabled:false, native prompt timing, default discovery; turn 2 after 30 s",
    {
      holdPromptMs: 0,
      secondTurnAfterMs: 30_000,
      transform: () => ({ settingsMerge: { tools: { toolSearch: { enabled: false } } } }),
    },
  ),
  knob("P-51-toolsearch-off-native-blocking", "P-50 + QWEN_CODE_LEGACY_MCP_BLOCKING=1", {
    holdPromptMs: 0,
    secondTurnAfterMs: 30_000,
    childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
    transform: () => ({ settingsMerge: { tools: { toolSearch: { enabled: false } } } }),
  }),
  knob(
    "P-52-visible-native",
    "tools.visible = all 100 names, native prompt timing, default discovery; turn 2 after 30 s",
    {
      holdPromptMs: 0,
      secondTurnAfterMs: 30_000,
      transform: () => ({ settingsMerge: { tools: { visible: allVisible() } } }),
    },
  ),
  knob("P-53-visible-native-blocking", "P-52 + QWEN_CODE_LEGACY_MCP_BLOCKING=1", {
    holdPromptMs: 0,
    secondTurnAfterMs: 30_000,
    childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
    transform: () => ({ settingsMerge: { tools: { visible: allVisible() } } }),
  }),
];

// ADDENDUM 5 (owner go, 2026-09-27) — the model's side. 1: tool_search as the model uses it, on the
// default config after discovery (default max_results, 20, by server name, repeated until nothing
// is left). 2: an end-to-end LOCAL + REMOTE call under (a) default after a select: reveal, (b) P-29,
// (c) tools.toolSearch.enabled:false.
const repeatSearch = { name: "tool_search", args: { query: "fake tool", max_results: 20 } };
const callBoth = (keys: { local: string; remote: string }) => [
  { name: `mcp__${keys.local}__local_tool_01`, args: { query: "probe-local-arg" } },
  { name: `mcp__${keys.remote}__remote_tool_01`, args: { query: "probe-remote-arg" } },
];
export const MODEL_SIDE_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-60-toolsearch-model",
    "default config after discovery; the model searches: default, max_results 20, by server name, then 'fake tool' ×20 until nothing is left",
    {
      modelScript: ({ keys }) => [
        { name: "tool_search", args: { query: "fake tool" } },
        repeatSearch,
        { name: "tool_search", args: { query: keys.local } },
        repeatSearch,
        repeatSearch,
        repeatSearch,
        repeatSearch,
        repeatSearch,
      ],
    },
  ),
  knob(
    "P-61-call-default",
    "default config after discovery: select: reveal of LOCAL+REMOTE tool 01, then the model calls both",
    {
      modelScript: ({ keys }) => [
        {
          name: "tool_search",
          args: {
            query: `select:mcp__${keys.local}__local_tool_01,mcp__${keys.remote}__remote_tool_01`,
          },
        },
        ...callBoth(keys),
      ],
    },
  ),
  knob(
    "P-62-call-blocking-always-load",
    "P-29's config (blocking + alwaysLoadTools, native timing): the model calls LOCAL and REMOTE tool 01",
    {
      holdPromptMs: 0,
      childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
      transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
      modelScript: ({ keys }) => callBoth(keys),
    },
  ),
  knob(
    "P-63-call-toolsearch-off",
    "tools.toolSearch.enabled:false (prompt after discovery, as P-13): the model calls LOCAL and REMOTE tool 01",
    {
      transform: () => ({ settingsMerge: { tools: { toolSearch: { enabled: false } } } }),
      modelScript: ({ keys }) => callBoth(keys),
    },
  ),
];

// ADDENDUM 6 (owner go, 2026-09-27) — the reminder path with blocking discovery only (tools stay
// deferred). 1: A+B → A+C across the app's respawn + session/load. 3: startup reminder → reveal →
// LOCAL + REMOTE call. (2, the context cost, is measured from the request logs of P-01/11/13/14/5x.)
const selectBoth = (keys: { local: string; remote: string }) => ({
  name: "tool_search",
  args: { query: `select:mcp__${keys.local}__local_tool_01,mcp__${keys.remote}__remote_tool_01` },
});
export const REMINDER_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-70-resume-swap-blocking",
    "blocking only: turn 1 A+B reveals LOCAL+REMOTE tool 01; the app switches to A+C (REMOTE off, EXTRA on); respawn + session/load; turn 2 calls the removed REMOTE tool",
    {
      holdPromptMs: 0,
      childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
      extra: { tools: 50, delayMs: 2_000 },
      resume: "swap-remote-for-extra",
      modelScript: ({ keys }) => [selectBoth(keys)],
      modelScriptTurn2: ({ keys }) => [
        { name: `mcp__${keys.remote}__remote_tool_01`, args: { query: "removed-server" } },
      ],
    },
  ),
  knob(
    "P-71-reminder-path-blocking",
    "blocking only: startup reminder → select: reveal of LOCAL+REMOTE tool 01 → the model calls both",
    {
      holdPromptMs: 0,
      childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
      modelScript: ({ keys }) => [selectBoth(keys), ...callBoth(keys)],
    },
  ),
];

// ADDENDUM 7 (owner go, 2026-09-27) — later turns without blocking, and context_usage (asked with
// `detail:true`, the parameter qwen reads — acpAgent.ts:7441) as the check on every turn.
export const CONTEXT_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-80-always-load-native-3turns",
    "alwaysLoadTools:true, native prompt timing, no blocking; turn 2 5 s and turn 3 30 s after the previous answer",
    {
      holdPromptMs: 0,
      secondTurnAfterMs: 5_000,
      thirdTurnAfterMs: 30_000,
      transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
    },
  ),
  knob(
    "P-81-ctx-default",
    "context_usage in full (detail:true) on the default config, prompt after discovery",
    {},
  ),
  // The token counts P-82…P-84 pin (6200 = 100 tools × 62) are qwen's estimate for S94's
  // `srv-<uuid>` names — the tool name is part of what it counts — so these cases name the
  // servers by their catalog id explicitly (S99 made the app's key readable and shorter).
  knob(
    "P-82-ctx-always-load",
    "context_usage in full on alwaysLoadTools:true, prompt after discovery",
    {
      serverKeys: "catalog-ids",
      transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
    },
  ),
  knob(
    "P-83-ctx-visible",
    "context_usage in full on tools.visible (all 100), prompt after discovery",
    {
      serverKeys: "catalog-ids",
      transform: (ids) => ({
        settingsMerge: {
          tools: {
            visible: [...toolNames(ids.local, "local", 50), ...toolNames(ids.remote, "remote", 50)],
          },
        },
      }),
    },
  ),
  knob(
    "P-84-ctx-toolsearch-off",
    "context_usage in full on tools.toolSearch.enabled:false, prompt after discovery",
    {
      serverKeys: "catalog-ids",
      transform: () => ({ settingsMerge: { tools: { toolSearch: { enabled: false } } } }),
    },
  ),
];

// ADDENDUM 7a — turn 2 only once qwen logged BOTH servers loaded, turn 3 after it.
export const LATER_TURN_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-85-always-load-native-after-loaded",
    "alwaysLoadTools:true, native timing, no blocking; turn 2 released only after qwen logged both servers loaded; turn 3 5 s later",
    {
      holdPromptMs: 0,
      secondTurnAfterMs: 0,
      secondTurnAfterServersLoaded: true,
      thirdTurnAfterMs: 5_000,
      transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
    },
  ),
];

// ADDENDUM 9 — no MCP in the app (argv __none__, no overlay) + the user's own servers in the USER
// file and the PROJECT file. ADDENDUM 8 — "allow always" answered by the app after the overlay
// was deleted. Both on the log-patched bundle (qwen's effective settings per session).
export const OWN_SERVER_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-90-no-app-mcp",
    "no MCP in the app; a server in the user's settings.json and one in the project's .qwen/settings.json; native timing",
    {
      appMcp: false,
      userServer: true,
      workspaceServer: true,
      holdPromptMs: 0,
    },
  ),
  knob("P-91-no-app-mcp-blocking", "P-90 + QWEN_CODE_LEGACY_MCP_BLOCKING=1", {
    appMcp: false,
    userServer: true,
    workspaceServer: true,
    holdPromptMs: 0,
    childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
  }),
  knob(
    "P-92-allow-always-after-delete",
    "thread in full-access (the app answers a permission with its first allow_always option), LOCAL trust:false, the model calls LOCAL tool 01 after the overlay was deleted; turn 2 3 s later",
    {
      ...formatBase,
      runtimeMode: "full-access",
      localDraft: { trust: false },
      modelScript: callLocalTool01,
      secondTurnAfterMs: 3_000,
    },
  ),
];

// ADDENDUM 10 — the candidate fix config (blocking + alwaysLoadTools) with one tool unchecked in
// the app, and failure visibility: context_usage right after session/new, all fine vs a crash.
const candidateFix: Partial<ProbeKnobs> = {
  holdPromptMs: 0,
  childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
  transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
};
export const CANDIDATE_CASES: ReadonlyArray<ProbeKnobs> = [
  knob(
    "P-93-candidate-one-tool-unchecked",
    "blocking + alwaysLoadTools + LOCAL local_tool_07 unchecked in the app (toolPolicy exception → excludeTools)",
    {
      ...candidateFix,
      localToolPolicy: { defaultDecision: "allow", exceptions: ["local_tool_07"] },
    },
  ),
  knob(
    "P-94-candidate-ctx-all-fine",
    "blocking + alwaysLoadTools; context_usage (detail) at +0 s and +1 s after session/new",
    {
      ...candidateFix,
      serverKeys: "catalog-ids", // its token pins are S94's `srv-<uuid>` names (see P-82)
      statusAtMs: [0, 1_000],
    },
  ),
  knob("P-95-candidate-ctx-local-crash", "P-94 with LOCAL crashing at start", {
    ...candidateFix,
    serverKeys: "catalog-ids",
    local: { tools: 50, delayMs: 25_000, crash: true },
    statusAtMs: [0, 1_000],
  }),
];

// ADDENDUM 11 — the REAL Playwright MCP (`npx -y @playwright/mcp@latest`), configured through the
// app as a user does ("playwright", stdio). The npm cache is chosen with the server's own env var
// (`npm_config_cache`, the form's vars): COLD = a fresh dir per run, WARM = one dir pre-warmed once
// (P-runs.log). The user's ~/.npm is never touched (the app runs with the sandbox HOME anyway).
const PLAYWRIGHT_SEARCHES = ["playwright", "browser", "navigate"].map((query) => ({
  name: "tool_search",
  args: { query },
}));
export const WARM_NPM_CACHE = NodePath.join(sandboxRoot(), "npm-cache-warm");
const playwrightCase = (
  name: string,
  cache: "cold" | "warm",
  config: "default" | "candidate",
  key: "uuid" | "playwright",
): ProbeKnobs =>
  knob(
    name,
    `REAL @playwright/mcp, npm cache ${cache}, ${config === "default" ? "default config (prompt 45 s after session/new)" : "blocking + alwaysLoadTools (native timing)"}, server key ${key === "uuid" ? "srv-<uuid>" : '"playwright"'}; the model searches playwright / browser / navigate`,
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
            value:
              cache === "warm"
                ? WARM_NPM_CACHE
                : NodePath.join(sandboxRoot(), `npm-cache-cold-${name}-${String(Date.now())}`),
          },
        ],
      },
      serverKeys:
        key === "playwright" ? { local: "playwright", remote: "probe-remote" } : "catalog-ids",
      ...(config === "default"
        ? { holdPromptMs: 45_000, statusAtMs: [1_000, 40_000] }
        : {
            holdPromptMs: 0,
            statusAtMs: [0, 5_000],
            childEnv: { QWEN_CODE_LEGACY_MCP_BLOCKING: "1" },
            transform: () => ({ serverMerge: { alwaysLoadTools: true } }),
          }),
      modelScript: () => PLAYWRIGHT_SEARCHES,
    },
  );
export const PLAYWRIGHT_CASES: ReadonlyArray<ProbeKnobs> = [
  playwrightCase("P-101-pw-cold-default-uuid", "cold", "default", "uuid"),
  playwrightCase("P-102-pw-cold-default-key", "cold", "default", "playwright"),
  playwrightCase("P-103-pw-cold-candidate-uuid", "cold", "candidate", "uuid"),
  playwrightCase("P-104-pw-cold-candidate-key", "cold", "candidate", "playwright"),
  playwrightCase("P-105-pw-warm-default-uuid", "warm", "default", "uuid"),
  playwrightCase("P-106-pw-warm-default-key", "warm", "default", "playwright"),
  playwrightCase("P-107-pw-warm-candidate-uuid", "warm", "candidate", "uuid"),
  playwrightCase("P-108-pw-warm-candidate-key", "warm", "candidate", "playwright"),
];

const CASE_TIMEOUT_MS = 600_000;

// ── reading a run's summary ──────────────────────────────────────────────────────────────────
/** The core picture of the baseline: both servers registered, the model told nothing. */
const expectDiscoveredButInvisible = (summary: Summary, proc: SessionProc, turn: string) => {
  expect(registeredIn(summary, proc, keys(summary).local)).toBe(50);
  expect(registeredIn(summary, proc, keys(summary).remote)).toBe(50);
  const request = turnRequest(summary, turn);
  expect(request.mcpToolCount).toBe(0);
  expect(request.mcpToolNamesInMessages).toBe(0);
  expect(request.addedMcpToolsReminder).toBe(false);
  expect(request.hasToolSearch).toBe(true);
};

/** What each case showed (S94-probe.md §3); the finding it guards is named in the report §8. */
const CHECKS: Record<string, (summary: Summary) => void> = {
  "P-01-baseline": (summary) => {
    const [proc] = sessions(summary);
    if (!proc) throw new Error("no session");
    expect(proc.sessionCall).toBe("session/new");
    expectDiscoveredButInvisible(summary, proc, "turn 1");
    // qwen rewrote the version-less overlay it got before answering initialize (adds
    // "$version": 4) — compared with the bytes it was handed (after the knob's transform).
    const handed = proc.settings.find((row) => row.label === "transformed");
    const atCall = proc.settings.find((row) => row.label === "app sends session/new");
    expect(handed?.exists).toBe(true);
    expect(atCall?.exists).toBe(true);
    expect(atCall?.sha256).not.toBe(handed?.sha256);
    // The app deletes it once the start settles.
    expect(
      proc.settings.find((row) => row.label === "before-app-hears session/prompt answer")?.exists,
    ).toBe(false);
    // qwen's workspace status calls the two connected servers "error / disconnected".
    const status = lastWorkspaceMcpStatus(proc);
    expect(
      status.map((server) => `${String(server["status"])}/${String(server["mcpStatus"])}`),
    ).toEqual(["error/disconnected", "error/disconnected"]);
  },
  "P-02-trust-no-foldertrust-key": (summary) =>
    expectDiscoveredButInvisible(summary, sessions(summary)[0] as SessionProc, "turn 1"),
  "P-03-trust-no-server-trust": (summary) =>
    expectDiscoveredButInvisible(summary, sessions(summary)[0] as SessionProc, "turn 1"),
  "P-04-trust-no-allowlist-flag": (summary) =>
    expectDiscoveredButInvisible(summary, sessions(summary)[0] as SessionProc, "turn 1"),
  "P-05-trust-approval-yolo": (summary) =>
    expectDiscoveredButInvisible(summary, sessions(summary)[0] as SessionProc, "turn 1"),
  "P-06-trust-process-cwd-statedir": (summary) =>
    expectDiscoveredButInvisible(summary, sessions(summary)[0] as SessionProc, "turn 1"),
  "P-07-spawn-warm-take": (summary) => {
    const warm = sessions(summary).find((proc) =>
      (proc.settingsPathEnv ?? "").includes("qwen-warm"),
    );
    if (!warm) throw new Error("no warm session");
    expect(warm.settings[0]?.exists).toBe(false); // the slot booted without its settings file
    expect(warm.settings.find((row) => row.label === "app sends session/new")?.exists).toBe(true);
    expectDiscoveredButInvisible(summary, warm, "warm turn");
  },
  "P-08-delay-local-31s": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(0);
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(50);
    expect(debugHas(summary, "Timed out after 30000ms: pool spawn")).toBe(true);
    expect(proc.stderrMcpLines.join("\n")).toContain(keys(summary).local);
  },
  "P-09-delay-remote-6s": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(0);
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(50);
    expect(debugHas(summary, "Timed out after 5000ms: unpooled spawn")).toBe(true);
    expect(proc.stderrMcpLines.join("\n")).toContain(keys(summary).remote);
  },
  "P-10-discovery-timeout-raised": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(50); // 6 s now allowed
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(0); // still dies at 30 s …
    expect(debugHas(summary, "MCP error -32001: Request timed out")).toBe(true); // … on `timeout`
  },
  "P-11-legacy-blocking": (summary) => {
    const request = turnRequest(summary, "turn 1");
    expect(request.mcpToolCount).toBe(0);
    expect(request.mcpToolNamesInMessages).toBe(100); // the startup reminder names them all
  },
  "P-12-prompt-immediate": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    const request = turnRequest(summary, "turn 1");
    expect(request.mcpToolCount).toBe(0);
    expect(request.mcpToolNamesInMessages).toBe(0);
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(50); // … arriving later
  },
  "P-13-toolsearch-disabled": (summary) => {
    const request = turnRequest(summary, "turn 1");
    expect(request.mcpToolCount).toBe(100);
    expect(request.hasToolSearch).toBe(false);
  },
  "P-14-always-load-tools": (summary) => {
    const request = turnRequest(summary, "turn 1");
    expect(request.mcpToolCount).toBe(100);
    expect(request.hasToolSearch).toBe(true);
  },
  "P-15-tools-visible": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(100);
  },
  "P-16-tool-count-2": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(2);
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(2);
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
  },
  "P-17-version-present": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    const present = proc.settings.filter((row) => row.exists && row.label !== "exec");
    expect(new Set(present.map((row) => row.sha256)).size).toBe(1); // qwen no longer rewrites it
    expectDiscoveredButInvisible(summary, proc, "turn 1");
  },
  "P-18-channel-acp": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    const newCall = proc.appCalls.find((call) => call.method === "session/new");
    const sent = newCall?.params as { readonly mcpServers?: ReadonlyArray<unknown> } | undefined;
    expect(sent?.mcpServers).toHaveLength(2);
    expectDiscoveredButInvisible(summary, proc, "turn 1");
    expect(lastWorkspaceMcpStatus(proc)).toHaveLength(0); // session servers never appear there
  },
  "P-19-failure-local-crash": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(0);
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(50);
    expect(debugHas(summary, "MCP error -32000: Connection closed")).toBe(true);
  },
  "P-20-failure-workspace-server": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(summary.mcp["workspace"]).toHaveLength(0); // never spawned
    expect(lastWorkspaceMcpStatus(proc).map((server) => server["name"])).not.toContain(
      "ws-declared",
    );
    expect(proc.requestPermissionCount).toBe(0);
  },
  "P-21-second-turn": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expectDiscoveredButInvisible(summary, proc, "turn 1");
    const second = turnRequest(summary, "turn 2");
    expect(second.mcpToolCount).toBe(0);
    expect(second.addedMcpToolsReminder).toBe(false);
  },
  "P-22-both-timeouts-raised": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(50);
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(50);
  },
  "P-23-workspace-server-no-allowlist": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    expect(debugHas(summary, "Skipping pending-approval MCP server (pool mode): ws-declared")).toBe(
      true,
    );
    const ws = lastWorkspaceMcpStatus(proc).find((server) => server["name"] === "ws-declared");
    expect(ws?.["approvalState"]).toBe("pending");
    expect(proc.requestPermissionCount).toBe(0); // nothing is asked over ACP
    expect(summary.mcp["workspace"]).toHaveLength(0);
  },
  "P-28-always-load-immediate": (summary) => {
    const [proc] = sessions(summary) as [SessionProc];
    // Turn 1 leaves before discovery ends, so the lever has nothing to load yet …
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
    // … although the same session registers all 100 moments later.
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(50);
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(50);
  },
  "P-29-blocking-always-load-immediate": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(100);
  },
  // ── ADDENDUM 2 ──
  ...Object.fromEntries(
    [
      ["P-30-key-uuid-name16", 16],
      ["P-31-key-uuid-name25", 25],
      ["P-32-key-uuid-name40", 40],
      ["P-33-key-short-name16", 16],
      ["P-34-key-short-name25", 25],
      ["P-35-key-short-name40", 40],
    ].map(([name, nameLen]) => [
      name as string,
      (summary: Summary) => {
        const proc = firstSession(summary);
        const local = registryNames(proc, "local_");
        expect(local).toHaveLength(5);
        const key = keys(summary).local;
        const intact = `mcp__${key}__${plainToolName("local", nameLen as number, 3)}`;
        const fits = intact.length <= 63;
        // qwen keeps `mcp__<key>__<tool>` only up to 63 chars; past that it truncates + hashes.
        expect(local.some((tool) => tool.name === intact)).toBe(fits);
        expect(local.every((tool) => tool.name.length <= 63)).toBe(true);
        // The startup reminder names exactly the registry's names.
        const [turnOne] = mainRequests(summary, "turn 1");
        expect(turnOne?.mcpToolNamesInMessagesList).toEqual(
          expect.arrayContaining(local.map((tool) => tool.name)),
        );
        // tool_search for the PLAIN name finds the tool only when its name survived intact.
        const found = completedToolText(proc);
        if (fits) {
          expect(found).toContain(intact);
        } else {
          expect(found).toContain("No tools found matching");
        }
      },
    ]),
  ),
  // ── ADDENDUM 3 (log-patched bundle) ──
  "P-40-format-keys": (summary) => {
    const proc = firstSession(summary);
    const qwenLocal = mcpRows(summary, "local").find(
      (row) => row.event === "process-start" && row.parent === "qwen",
    );
    expect(qwenLocal?.envMarks).toEqual({
      PROBE_MARK_PLAIN: "plain-marker-1",
      PROBE_MARK_SECRET: "secret-marker-2",
    });
    expect(qwenLocal?.cwd?.endsWith("/workspace")).toBe(true);
    const remoteInit = mcpRows(summary, "remote").find(
      (row) => row.method === "initialize" && fromQwen(row),
    );
    expect(remoteInit?.probeHeaders).toEqual({
      "x-probe-config": "cfg-1",
      "x-probe-extra": "extra-1",
    });
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(49);
    const [turnOne] = mainRequests(summary, "turn 1");
    expect(turnOne?.mcpToolsByServer.local).toBe(49);
    expect(turnOne?.toolNames.some((name) => name.endsWith("__local_tool_50"))).toBe(false);
    expect(completedToolText(proc)).toContain("FAKE-MCP-RESULT local local_tool_01");
    expect(proc.requestPermissionCount).toBe(0);
    expect(configDump(summary).settingsWarnings).toEqual([]);
    expect(configDump(summary).migrationWarnings).toEqual([]);
  },
  "P-41-format-timeout": (summary) => {
    const proc = firstSession(summary);
    const started = proc.toolCalls.find((call) => call.status === "in_progress");
    const failed = proc.toolCalls.find((call) => call.status === "failed");
    expect(failed?.content).toContain("MCP error -32001: Request timed out");
    const elapsed = (failed?.ms ?? 0) - (started?.ms ?? 0);
    expect(elapsed).toBeGreaterThan(4_500);
    expect(elapsed).toBeLessThan(6_500);
  },
  "P-42-format-trust-false": (summary) => {
    const proc = firstSession(summary);
    expect(proc.requestPermissionCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(proc.requestPermissions[0]?.params)).toContain("local_tool_01");
  },
  "P-43-format-include-tools": (summary) => {
    expect(registeredIn(summary, firstSession(summary), keys(summary).local)).toBe(2);
  },
  "P-44-format-foldertrust-used": (summary) => {
    const proc = firstSession(summary);
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(50);
    expect(configDump(summary).trustedFolder).toBe(true);
  },
  "P-45-format-foldertrust-removed": (summary) => {
    const proc = firstSession(summary);
    expect(registeredIn(summary, proc, keys(summary).local)).toBe(0);
    expect(registeredIn(summary, proc, keys(summary).remote)).toBe(0);
    expect(configDump(summary).trustedFolder).toBe(false);
    expect(configDump(summary).approvalMode).toBe("default");
    expect(proc.stderrMcpLines.join("\n")).toContain("failed to start");
  },
  // ── ADDENDUM 4 ──
  "P-50-toolsearch-off-native": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
    expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(100);
  },
  "P-51-toolsearch-off-native-blocking": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(100);
    expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(100);
  },
  "P-52-visible-native": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
    expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(100);
  },
  "P-53-visible-native-blocking": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(100);
    expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(100);
  },
  // ── ADDENDUM 5 ──
  "P-60-toolsearch-model": (summary) => {
    // declared MCP tools after each search: default 5, then 20, by server key, then 20s.
    expect(mainRequests(summary, "turn 1").map((request) => request.mcpToolCount)).toEqual([
      0, 5, 25, 30, 50, 70, 90, 100, 100,
    ]);
  },
  ...Object.fromEntries(
    ["P-61-call-default", "P-62-call-blocking-always-load", "P-63-call-toolsearch-off"].map(
      (name) => [
        name,
        (summary: Summary) => {
          const localCall = mcpRows(summary, "local").find((row) => row.method === "tools/call");
          const remoteCall = mcpRows(summary, "remote").find((row) => row.method === "tools/call");
          expect(localCall).toBeDefined();
          expect(remoteCall).toBeDefined();
          const results = mainRequests(summary, "turn 1").map(
            (request) => request.lastToolMessage ?? "",
          );
          expect(results.some((text) => text.includes("FAKE-MCP-RESULT local local_tool_01"))).toBe(
            true,
          );
          expect(
            results.some((text) => text.includes("FAKE-MCP-RESULT remote remote_tool_01")),
          ).toBe(true);
          expect(firstSession(summary).requestPermissionCount).toBe(0);
        },
      ],
    ),
  ),
  // ── ADDENDUM 6 ──
  "P-70-resume-swap-blocking": (summary) => {
    expect(summary.appSpawnReasons).toContain("respawn:mcp-servers-changed");
    const afterReveal = mainRequests(summary, "turn 1").find(
      (request) => request.lastRole === "tool",
    );
    expect(afterReveal?.mcpToolsByServer).toEqual({ local: 1, remote: 1, extra: 0 });
    const [turnTwo, continuation] = mainRequests(summary, "turn 2 (resume)");
    // ONE MCP reminder after the resume: the new process's startup reminder, A + C, no B.
    expect(turnTwo?.mcpReminders).toHaveLength(1);
    const names = turnTwo?.mcpReminders[0]?.names ?? [];
    expect(names.filter((name) => name.includes("__local_tool_"))).toHaveLength(50);
    expect(names.filter((name) => name.includes("__extra_tool_"))).toHaveLength(50);
    expect(names.filter((name) => name.includes("__remote_tool_"))).toHaveLength(0);
    // The tool revealed before the resume is no longer declared.
    expect(turnTwo?.mcpToolCount).toBe(0);
    // Calling the removed server's tool: qwen answers "not found in registry".
    expect(continuation?.lastToolMessage).toContain("not found in registry");
  },
  "P-71-reminder-path-blocking": (summary) => {
    const requests = mainRequests(summary, "turn 1");
    expect(requests[0]?.mcpReminders).toHaveLength(1);
    expect(requests[0]?.mcpReminders[0]?.names).toHaveLength(100);
    expect(requests[0]?.mcpToolCount).toBe(0);
    expect(requests[1]?.mcpToolsByServer).toEqual({ local: 1, remote: 1, extra: 0 });
    expect(mcpRows(summary, "local").some((row) => row.method === "tools/call")).toBe(true);
    expect(mcpRows(summary, "remote").some((row) => row.method === "tools/call")).toBe(true);
    const results = requests.map((request) => request.lastToolMessage ?? "");
    expect(results.some((text) => text.includes("FAKE-MCP-RESULT local local_tool_01"))).toBe(true);
    expect(results.some((text) => text.includes("FAKE-MCP-RESULT remote remote_tool_01"))).toBe(
      true,
    );
  },
  // ── ADDENDUM 7 ──
  "P-80-always-load-native-3turns": (summary) => {
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
    expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(0);
    expect(turnRequest(summary, "turn 3").mcpToolCount).toBe(100);
    const afterTurns = contextUsages(firstSession(summary)).filter(
      (usage) => usage.label === "after session/prompt answer",
    );
    // context_usage after turn 2 already lists REMOTE's 50 while that request carried 0.
    expect(afterTurns.map((usage) => usage.listed)).toEqual([0, 50, 100]);
  },
  ...Object.fromEntries(
    [
      ["P-81-ctx-default", 0, 0],
      ["P-82-ctx-always-load", 100, 6200],
      ["P-83-ctx-visible", 100, 6200],
      ["P-84-ctx-toolsearch-off", 100, 6200],
    ].map(([name, count, tokens]) => [
      name as string,
      (summary: Summary) => {
        const beforePrompt = contextUsages(firstSession(summary)).find((usage) =>
          usage.label.startsWith("+33000"),
        );
        expect(beforePrompt?.showDetails).toBe(true);
        expect(beforePrompt?.listed).toBe(count);
        expect(beforePrompt?.breakdownMcp).toBe(tokens);
        expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(count);
      },
    ]),
  ),
  // ── ADDENDUM 7a ──
  "P-85-always-load-native-after-loaded": (summary) => {
    const proc = firstSession(summary);
    const loadedAt = Math.max(
      ...summary.registered.filter((row) => row.sessionId === proc.sessionId).map((row) => row.ms),
    );
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
    const turnTwo = turnRequest(summary, "turn 2");
    expect(turnTwo.ms).toBeGreaterThan(loadedAt);
    expect(turnTwo.mcpToolCount).toBe(100);
    expect(turnRequest(summary, "turn 3").mcpToolCount).toBe(100);
  },
  // ── ADDENDUM 9 ──
  ...Object.fromEntries(
    ["P-90-no-app-mcp", "P-91-no-app-mcp-blocking"].map((name) => [
      name,
      (summary: Summary) => {
        const proc = firstSession(summary);
        expect(proc.settingsPathEnv).toBeNull();
        expect(summary.mcp["user"]).toHaveLength(0); // never connected
        expect(summary.mcp["workspace"]).toHaveLength(0);
        const dump = summary.sessionConfigs[0] as {
          merged: { mcpServers: Record<string, unknown> };
          effectiveMcpServers: Record<string, unknown>;
        };
        expect(Object.keys(dump.merged.mcpServers).sort()).toEqual([
          "user-declared",
          "ws-declared",
        ]);
        expect(dump.effectiveMcpServers).toEqual({}); // the app's `__none__` allowlist
        expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(0);
      },
    ]),
  ),
  // ── ADDENDUM 8 ──
  "P-92-allow-always-after-delete": (summary) => {
    const proc = firstSession(summary);
    expect(proc.requestPermissionCount).toBe(1);
    const files = summary.settingsFilesAfter as {
      workspace: { text: string };
      system: ReadonlyArray<{ text: string }>;
    };
    // The app answered its first allow_always option (proceed_always_project): qwen wrote the rule
    // into the PROJECT's settings file; the deleted overlay stayed deleted.
    expect(files.workspace.text).toContain(`mcp__${keys(summary).local}__local_tool_01`);
    expect(files.system.every((file) => file.text === "absent")).toBe(true);
    expect(debugHas(summary, "no MCP-relevant change")).toBe(true);
    expect(proc.stderrMcpLines).toEqual([]);
    expect(turnRequest(summary, "turn 2").mcpToolCount).toBe(100);
  },
  // ── ADDENDUM 10 ──
  "P-93-candidate-one-tool-unchecked": (summary) => {
    const request = turnRequest(summary, "turn 1");
    expect(request.mcpToolsByServer.local).toBe(49);
    expect(request.mcpToolsByServer.remote).toBe(50);
    expect(request.toolNames.some((name) => name.endsWith("__local_tool_07"))).toBe(false);
  },
  "P-94-candidate-ctx-all-fine": (summary) => {
    const atZero = contextUsages(firstSession(summary)).find((usage) =>
      usage.label.startsWith("+0ms"),
    );
    expect(atZero?.listed).toBe(100);
    expect(atZero?.breakdownMcp).toBe(6200);
    expect(turnRequest(summary, "turn 1").mcpToolCount).toBe(100);
  },
  "P-95-candidate-ctx-local-crash": (summary) => {
    const proc = firstSession(summary);
    const atZero = contextUsages(proc).find((usage) => usage.label.startsWith("+0ms"));
    expect(atZero?.listed).toBe(50); // REMOTE only — the one in-band trace of the crash
    expect(atZero?.breakdownMcp).toBe(3100);
    // qwen said it on stderr; the app never reads that stream.
    expect(proc.stderrMcpLines.join("\n")).toContain("failed to start");
  },
  // ── ADDENDUM 11 (REAL @playwright/mcp — structural facts; its tool count is not pinned) ──
  ...Object.fromEntries(
    PLAYWRIGHT_CASES.map((knobs) => [
      knobs.name,
      (summary: Summary) => {
        const proc = firstSession(summary);
        const registered = summary.registered.filter((row) => row.sessionId === proc.sessionId);
        expect(registered.length).toBeGreaterThan(0); // it loaded
        const names = registryNames(proc, "browser_").map((tool) => tool.name);
        expect(names.length).toBeGreaterThan(0);
        const readableKey = knobs.serverKeys !== "catalog-ids";
        const hashed = names.filter((name) => /__browser__[0-9a-z]{7}$/.test(name));
        if (readableKey) {
          expect(hashed).toEqual([]); // every name intact: mcp__playwright__<tool>
          expect(names.every((name) => name.startsWith("mcp__playwright__browser_"))).toBe(true);
        } else {
          expect(hashed.length).toBeGreaterThan(0); // srv-<uuid> key ⇒ some names hashed
        }
        const firstSearch = proc.toolCalls.find((call) => call.status === "completed");
        // the candidate config = blocking discovery (+ alwaysLoadTools); every other case also has a
        // transform now (S94's BASELINE drops `$version` explicitly), so it is told by its env
        const candidate = knobs.childEnv?.["QWEN_CODE_LEGACY_MCP_BLOCKING"] === "1";
        const [turnOne] = mainRequests(summary, "turn 1");
        if (candidate) {
          expect(turnOne?.mcpToolCount).toBe(registered[0]?.registered);
          // loaded tools are not search candidates: the search for "playwright" finds nothing
          expect(firstSearch?.content).toContain("No tools found matching 'playwright'");
        } else {
          expect(turnOne?.mcpToolCount).toBe(0);
          expect(firstSearch?.content).toContain("<functions>");
        }
      },
    ]),
  ),
  "P-24-model-calls-tool-search": (summary) => {
    const continuation = (summary.model as unknown as ModelRequest[]).find(
      (request) => request.probeTurn === "turn 1" && request.lastRole === "tool",
    );
    expect(continuation?.mcpToolsByServer.local).toBe(5); // ToolSearch keyword default: 5 results
  },
  "P-25-load-cold-after-mcp-change": (summary) => {
    const load = sessions(summary).find((proc) => proc.sessionCall === "session/load");
    if (!load) throw new Error("no session/load");
    expect(summary.appSpawnReasons).toContain("respawn:mcp-servers-changed");
    expect(load.settings[0]?.exists).toBe(true); // cold: written before the process started
    expect(load.settings.find((row) => row.label === "app sends session/load")?.exists).toBe(true);
    expectDiscoveredButInvisible(summary, load, "turn 2 (resume)");
  },
  "P-26-load-warm-after-mcp-change": (summary) => {
    const load = sessions(summary).find((proc) => proc.sessionCall === "session/load");
    if (!load) throw new Error("no session/load");
    expect(summary.appSpawnReasons).toContain("respawn:mcp-allowed-tools-changed");
    expect(load.settingsPathEnv ?? "").toContain("qwen-warm");
    expect(load.settings[0]?.exists).toBe(false); // warm: the slot booted without it …
    expect(load.settings.find((row) => row.label === "app sends session/load")?.exists).toBe(true); // … it is there at the read
    expect(registeredIn(summary, load, keys(summary).local)).toBe(49); // excludeTools honoured
    expect(registeredIn(summary, load, keys(summary).remote)).toBe(50);
    expect(turnRequest(summary, "turn 2 (resume)").mcpToolCount).toBe(0);
  },
  "P-27-load-after-ttl-expiry": (summary) => {
    const load = sessions(summary).find((proc) => proc.sessionCall === "session/load");
    if (!load) throw new Error("no session/load");
    // Nothing changed, yet the app respawned: the 30-min spawn record read as "changed".
    expect(summary.appSpawnReasons).toContain("respawn:mcp-config-changed");
    expect(load.settings.find((row) => row.label === "app sends session/load")?.exists).toBe(true);
    expectDiscoveredButInvisible(summary, load, "turn 2 (resume)");
  },
};

gated("S94 MCP probe — real qwen 0.21.1 behind the real app", () => {
  for (const knobs of [
    BASELINE,
    ...TRUST_CASES,
    ...KNOB_CASES,
    ...RESUME_CASES,
    ...SERVER_KEY_CASES,
    ...NATIVE_TIMING_CASES,
    ...MODEL_SIDE_CASES,
    ...REMINDER_CASES,
    ...CONTEXT_CASES,
    ...LATER_TURN_CASES,
    ...CANDIDATE_CASES,
  ]) {
    it(
      knobs.name,
      async () => {
        const { summary } = await run(knobs);
        expect(summary.error).toBeNull();
        CHECKS[knobs.name]?.(summary);
      },
      CASE_TIMEOUT_MS,
    );
  }
  // Real network + npx: opt-in on top of the probe gate.
  for (const knobs of PLAYWRIGHT_CASES) {
    it.skipIf(process.env["RU_CODE_MCP_PROBE_PLAYWRIGHT"] !== "1")(
      knobs.name,
      async () => {
        const { summary } = await run(knobs);
        expect(summary.error).toBeNull();
        CHECKS[knobs.name]?.(summary);
      },
      CASE_TIMEOUT_MS,
    );
  }
  for (const knobs of [...FORMAT_CASES, ...OWN_SERVER_CASES]) {
    it.skipIf(logPatchedCliJs === undefined)(
      knobs.name,
      async () => {
        const { summary } = await run(knobs, logPatchedCliJs as string);
        expect(summary.error).toBeNull();
        CHECKS[knobs.name]?.(summary);
      },
      CASE_TIMEOUT_MS,
    );
  }
});
