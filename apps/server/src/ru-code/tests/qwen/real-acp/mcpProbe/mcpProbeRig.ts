// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalFetch:off cryptoRandomUUID:off
// ru-code: a PLAIN-NODE test rig (process spawning, file polling, one fetch) like the real-qwen
// harness it drives — the Effect-API diagnostics do not apply to it.
// ru-code (S94 probe): THE MCP PROBE RIG — the REAL app, the REAL qwen 0.21.1, fakes everywhere else.
//
// One run = one fresh app server booted from `apps/server/dist/bin.mjs` in a sandbox HOME, with
// `RU_CODE_CLI_JS` pointing at @ru-code/qwen-real-harness `mcpProbe/cliProxy.mjs` (a transparent
// recorder that runs the real qwen bundle). The rig then does over `/ws` exactly what the web does —
// the same `orchestration.dispatchCommand` payloads `useMcp.ts` and the composer build — so the MCP
// servers travel the app's whole path: decider → projectors → SQLite → overlay writer → spawn
// builder → (warm pool) → qwen. Nothing of the app is replaced; the only things the rig owns are
// the two fake MCP servers, the fake model backend and the proxy's recording.
//
// The four angles of every run land in `<outDir>`:
//   cli/proc-*/{meta.json,settings.jsonl,wire.jsonl,probes.jsonl,stderr.log,…}  what we wrote / what qwen reports
//   mcp-local.jsonl, mcp-remote.jsonl, mcp-workspace.jsonl                     what each fake MCP received
//   model-requests.jsonl                                                       what the fake model received
//   qwen-debug/*.txt                                                            qwen's own debug log
//   app-server.log, run-meta.json, summary.json

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { startFakeOpenAIServer } from "@ru-code/qwen-real-harness";
import { MCP_MANAGER_METHODS, McpServerId } from "@smart-tools/qwen-cli-mcp-manager/server";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

// ── locations ─────────────────────────────────────────────────────────────────────────────────
const findRepoRoot = (from: string): string => {
  let dir = from;
  while (!NodeFS.existsSync(NodePath.join(dir, "pnpm-workspace.yaml"))) {
    const parent = NodePath.dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
    dir = parent;
  }
  return dir;
};
export const REPO_ROOT = findRepoRoot(import.meta.dirname);
const PROBE_DIR = NodePath.join(REPO_ROOT, "ru-code/qwen-real-harness/src/mcpProbe");
export const CLI_PROXY = NodePath.join(PROBE_DIR, "cliProxy.mjs");
export const FAKE_MCP_STDIO = NodePath.join(PROBE_DIR, "fakeMcpStdio.mjs");
export const FAKE_MCP_HTTP = NodePath.join(PROBE_DIR, "fakeMcpHttp.mjs");
export const CLOCK_SHIFT = NodePath.join(PROBE_DIR, "clockShift.cjs");
export const BUILT_SERVER = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");

/** The gate: the real bundle (as for the rest of real-acp) AND an explicit opt-in — a run is long. */
export const probeCliJs = (): string | undefined => {
  const cli = process.env["RU_CODE_QWEN_CLI_JS"]?.trim();
  return cli && process.env["RU_CODE_MCP_PROBE"] === "1" ? cli : undefined;
};

// ── knobs ─────────────────────────────────────────────────────────────────────────────────────
export interface FakeServerKnobs {
  readonly tools: number;
  readonly delayMs: number;
  readonly crash?: boolean;
  /** Tool names of exactly this many characters (fake `--name-len`); undefined = `<prefix>_tool_NN`. */
  readonly nameLen?: number;
  /** `tools/call` answers this late (fake `--call-delay-ms`). */
  readonly callDelayMs?: number;
}

/** Fields of the web's `mcp.server-add` draft a knob sets differently (useMcp.ts:184-205). */
export interface DraftOverrides {
  readonly vars?: ReadonlyArray<{
    readonly name: string;
    readonly secret: boolean;
    readonly perProject: boolean;
    readonly required: boolean;
    readonly value: string | null;
  }>;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** http only: `config.headers`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly trust?: boolean;
  readonly timeoutMs?: number | null;
}

/**
 * What the scripted model sees of the run: the catalog ids and the server keys qwen uses — the
 * keys the APP wrote (observed by the proxy, `roles.json`), or a knob's `serverKeys` rename.
 */
export interface ModelScriptContext {
  readonly ids: ProbeServerIds;
  readonly keys: ProbeServerIds;
}

/**
 * `{{key:<role>}}` inside a knob's transform = the key the app gave that server (the proxy
 * substitutes it at exec, cliProxy.mjs PROBE_SERVER_ROLES). Roles: local, remote, extra.
 */
export const serverKeyToken = (role: "local" | "remote" | "extra"): string => `{{key:${role}}}`;

export interface ProbeKnobs {
  /** Run id — also the output folder name, e.g. `P-01-baseline`. */
  readonly name: string;
  readonly purpose: string;
  readonly local: FakeServerKnobs;
  readonly remote: FakeServerKnobs;
  /** `RU_CODE_WARM_ENGINE`: undefined = production default (ON); "0" = off. */
  readonly warmEngine?: "0";
  /** After turn 1 (cold), wait for the project's MCP warm slot and start a 2nd thread on it. */
  readonly warmTake?: boolean;
  /** Proxy holds the app's `session/prompt` until this long after `session/new` was answered. */
  readonly holdPromptMs: number;
  /** Offsets after `session/new` at which the proxy asks qwen's status methods. */
  readonly statusAtMs: ReadonlyArray<number>;
  readonly childEnv?: Readonly<Record<string, string>>;
  /**
   * Extra env for the APP SERVER process (S99): how a case turns on the app's `QG_` switches
   * (`qwen/acpSwitches.ts`). Everything the app spawns inherits it, as from a user's shell.
   */
  readonly appEnv?: Readonly<Record<string, string>>;
  /**
   * The proxy's explicit transform (cliProxy.mjs `PROBE_TRANSFORM`), given the run's catalog ids.
   * A qwen server key is written `serverKeyToken(role)` — the proxy fills in what the app wrote.
   */
  readonly transform?: (ids: ProbeServerIds) => Readonly<Record<string, unknown>>;
  /** Also declare a third fake server in `<workspace>/.qwen/settings.json` (a user's own file). */
  readonly workspaceServer?: boolean;
  /** Send a 2nd turn on the SAME thread this long after the 1st answered. */
  readonly secondTurnAfterMs?: number;
  /** And a 3rd this long after the 2nd answered (needs `secondTurnAfterMs`). */
  readonly thirdTurnAfterMs?: number;
  /**
   * S94 addendum 7a: turn 2 waits (after `secondTurnAfterMs`) until qwen's debug log shows BOTH
   * servers registered in the session (`SessionMcpView[…/<id>] applied N tools`).
   */
  readonly secondTurnAfterServersLoaded?: boolean;
  /**
   * The fake model's first answer to turn 1 is a `tool_search` call with this keyword query
   * (instead of text) — what a model that DOES search would do. Undefined = text only.
   */
  readonly modelToolSearchQuery?: string;
  /**
   * The addendum's `session/load` knob — turn 1 (`session/new`), then an app-side trigger, then
   * turn 2 on the SAME thread, which the app serves by respawning + `session/load`:
   *   cold-add-server  — only REMOTE bound for turn 1; LOCAL bound before turn 2 (the server set
   *                      changes ⇒ the project's warm key no longer matches ⇒ a cold respawn);
   *   warm-toggle-tool — both bound; the project's MCP slot warms; one LOCAL tool is switched off
   *                      before turn 2 (same server set ⇒ the app takes the warm slot);
   *   ttl-expiry       — both bound, NO change; the server's clock is moved 31 min forward before
   *                      turn 2 (the spawn record's 30-min TTL, McpSessionOverlay.ts:33,94,157).
   */
  readonly resume?: "cold-add-server" | "warm-toggle-tool" | "ttl-expiry" | "swap-remote-for-extra";
  /**
   * S94 addendum 6: a THIRD server C (stdio, prefix `extra`), added to the catalog unbound. The
   * `swap-remote-for-extra` resume binds C and unbinds REMOTE between turn 1 and turn 2.
   */
  readonly extra?: FakeServerKnobs;
  /** S94 addendum 9: false = the project has NO MCP server in the app (no server-add, no binding). */
  readonly appMcp?: false;
  /** S94 addendum 9: a server the user declared in `<QWEN_HOME>/settings.json` (`user-declared`). */
  readonly userServer?: boolean;
  /**
   * S94 addendum 11: the LOCAL slot holds a REAL server instead of the fake (the web's form fields:
   * name + stdio command + args); REMOTE is then not bound.
   */
  readonly realLocalServer?: {
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };
  /** S94 addendum 8: the thread's runtime mode (the web's dropdown); default auto-accept-edits. */
  readonly runtimeMode?: "full-access";
  /**
   * S94 addendum 2: the key qwen gets for each server instead of the one the app wrote (the proxy
   * renames the overlay's `mcpServers` keys AND the allowlist tokens). "catalog-ids" = the catalog
   * id `srv-<uuid>` (the app's key before S99). Undefined = the app's own key.
   */
  readonly serverKeys?: ProbeServerIds | "catalog-ids";
  /** S94 addendum 3: draft fields for LOCAL / REMOTE (the web's own form fields). */
  readonly localDraft?: DraftOverrides;
  readonly remoteDraft?: DraftOverrides;
  /** LOCAL binding's tool policy, set as the web's `setToolEnabled` would (adapters.ts:321-337). */
  readonly localToolPolicy?: {
    readonly defaultDecision: "allow" | "deny";
    readonly exceptions: ReadonlyArray<string>;
  };
  /** Extra keys for the USER's own qwen settings file, and a `trustedFolders.json` for QWEN_HOME. */
  readonly userSettings?: Readonly<Record<string, unknown>>;
  readonly trustedFolders?: (workspace: string) => Readonly<Record<string, string>>;
  /**
   * Scripted model for turn 1: each main-loop request (user or tool result last) gets the next
   * tool call; then text. Replaces `modelToolSearchQuery` when set.
   */
  readonly modelScript?: (
    context: ModelScriptContext,
  ) => ReadonlyArray<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }>;
  /** The same for turn 2 (a request belongs to the turn whose `PROBE turn N` text comes LAST). */
  readonly modelScriptTurn2?: (
    context: ModelScriptContext,
  ) => ReadonlyArray<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }>;
  /** Turn 1 is "done" when qwen asks the app for a permission (the app waits for the user). */
  readonly stopOnPermissionRequest?: boolean;
  /**
   * S99: the fake model streams every text answer in this many chunks (a long answer, as a real
   * model streams it) — qwen then writes one ACP frame per chunk. Undefined = one chunk.
   */
  readonly answerChunks?: number;
  /**
   * S99: when that turn's first model request arrives, SIGKILL the qwen process serving it (qwen
   * dies mid-turn — a crash, an OOM kill). The turn then never gets qwen's answer; the case goes on
   * once the proxy recorded the exit, and a 3rd turn (if any) counts one answer less.
   */
  readonly killQwenOnTurn?: "turn 2";
  /**
   * S99 reinstall: the run starts on an OLDER RELEASE — a copy of the built server whose shipped
   * built-in list is `builtins` (McpBuiltinDefinition-shaped) — which the web configures as usual,
   * plus bindings for `bindBuiltins`; it is stopped and the REAL build starts on the same data, so
   * its startup reconciliation meets an existing catalog. The app's catalog + bindings
   * (`mcp.getSnapshot`) are recorded before the stop and at the end (`mcpSnapshots`).
   */
  readonly previousRelease?: {
    readonly builtins: ReadonlyArray<Record<string, unknown>>;
    readonly bindBuiltins: ReadonlyArray<string>;
  };
}

export interface ProbeServerIds {
  readonly local: string;
  readonly remote: string;
}

export interface ProbeRunResult {
  readonly outDir: string;
  readonly summary: ProbeSummary;
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

const readJsonl = (path: string): Array<Record<string, unknown>> => {
  try {
    return NodeFS.readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};

const waitFor = async <A>(
  label: string,
  timeoutMs: number,
  probe: () => A | undefined | null | false,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms: ${label}`);
    await sleep(250);
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const gitHead = (): string => {
  const result = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.stdout.trim();
};

/**
 * An OLDER RELEASE of the built server (the reinstall knob): a directory in the sandbox whose
 * entries link to `apps/server/dist` (and its `node_modules`), except `bin.mjs` — a copy whose
 * shipped built-in list (the
 * `MCP_BUILTINS` literal the bundle inlines, the one starting at builtinId `filesystem`) is
 * `builtins`. Everything else is the same build.
 */
const previousReleaseBin = (
  sandbox: string,
  builtins: ReadonlyArray<Record<string, unknown>>,
): string => {
  const distDir = NodePath.dirname(BUILT_SERVER);
  const releaseDir = NodePath.join(sandbox, "previous-release");
  NodeFS.mkdirSync(releaseDir, { recursive: true });
  for (const entry of NodeFS.readdirSync(distDir)) {
    if (entry !== "bin.mjs") {
      NodeFS.symlinkSync(NodePath.join(distDir, entry), NodePath.join(releaseDir, entry));
    }
  }
  // the copy resolves its packages from where it lies: the server's own dependencies
  NodeFS.symlinkSync(
    NodePath.join(NodePath.dirname(distDir), "node_modules"),
    NodePath.join(releaseDir, "node_modules"),
  );
  const bundle = NodeFS.readFileSync(BUILT_SERVER, "utf8");
  const heads = [...bundle.matchAll(/const [\w$]+ = (\[\n\t\{\n\t\tbuiltinId: `filesystem`,)/g)];
  const [head] = heads;
  if (heads.length !== 1 || head === undefined) {
    throw new Error(
      `the built server's MCP_BUILTINS literal: ${String(heads.length)} matches, not 1`,
    );
  }
  const start = head.index + head[0].length - (head[1] ?? "").length; // the "["
  // its "]" is the first one at column 0 (nested arrays close indented); the bundle may chain
  // declarations after it (`], next = …`), so only the bracket itself is replaced
  const end = bundle.indexOf("\n]", start) + 2;
  NodeFS.writeFileSync(
    NodePath.join(releaseDir, "bin.mjs"),
    `${bundle.slice(0, start)}${JSON.stringify(builtins)}${bundle.slice(end)}`,
  );
  return NodePath.join(releaseDir, "bin.mjs");
};

// ── the proxy's per-process logs ──────────────────────────────────────────────────────────────
interface ProcLog {
  readonly dir: string;
  readonly meta: Record<string, unknown>;
  readonly wire: Array<Record<string, unknown>>;
  readonly lifecycle: Array<Record<string, unknown>>;
}

const readProcs = (cliDir: string): ProcLog[] => {
  let names: string[];
  try {
    names = NodeFS.readdirSync(cliDir).filter((name) => name.startsWith("proc-"));
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
    const dir = NodePath.join(cliDir, name);
    try {
      const meta = JSON.parse(
        NodeFS.readFileSync(NodePath.join(dir, "meta.json"), "utf8"),
      ) as Record<string, unknown>;
      return [
        {
          dir,
          meta,
          wire: readJsonl(NodePath.join(dir, "wire.jsonl")),
          lifecycle: readJsonl(NodePath.join(dir, "lifecycle.jsonl")),
        },
      ];
    } catch {
      return [];
    }
  });
};

/** The keys the app gave LOCAL / REMOTE, each as the first process that had it recorded it. */
const observedKeys = (cliDir: string): ProbeServerIds => {
  let local: string | undefined;
  let remote: string | undefined;
  for (const proc of readProcs(cliDir)) {
    try {
      const roles = JSON.parse(
        NodeFS.readFileSync(NodePath.join(proc.dir, "roles.json"), "utf8"),
      ) as { local?: string; remote?: string };
      local ??= roles.local;
      remote ??= roles.remote;
    } catch {
      /* a process without an overlay */
    }
  }
  if (local === undefined && remote === undefined) {
    throw new Error("no process recorded the app's server keys (roles.json)");
  }
  return { local: local ?? "", remote: remote ?? "" };
};

const msgOf = (row: Record<string, unknown>) => row["msg"] as Record<string, unknown> | undefined;

/** ms at which the proxy saw qwen's answer to the app's `method` call, per process. */
const answerTimes = (proc: ProcLog, method: string): number[] => {
  const ids = new Set(
    proc.wire
      .filter((row) => row["dir"] === "app->qwen" && msgOf(row)?.["method"] === method)
      .map((row) => msgOf(row)?.["id"]),
  );
  return proc.wire
    .filter(
      (row) =>
        row["dir"] === "qwen->app" &&
        msgOf(row)?.["method"] === undefined &&
        ids.has(msgOf(row)?.["id"]),
    )
    .map((row) => row["ms"] as number);
};

// ── WS RPC client (the same construction as apps/server/src/server.test.ts:1005-1031) ─────────
const wsRpcProtocolLayer = (url: string, cookie: string) => {
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(socketUrl, protocols, {
        headers: { cookie },
      }) as unknown as globalThis.WebSocket,
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, infer _E, infer _R> ? Client : never;

const withClient = <A, E>(
  url: string,
  cookie: string,
  body: (client: WsClient) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      makeWsRpcClient.pipe(Effect.flatMap(body), Effect.provide(wsRpcProtocolLayer(url, cookie))),
    ),
  );

// ── the run ───────────────────────────────────────────────────────────────────────────────────
export async function runProbe(
  knobs: ProbeKnobs,
  options: { readonly cliJs: string; readonly outRoot: string; readonly sandboxRoot: string },
): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const outDir = NodePath.join(options.outRoot, knobs.name);
  NodeFS.rmSync(outDir, { recursive: true, force: true });
  NodeFS.mkdirSync(outDir, { recursive: true });
  const sandbox = NodeFS.mkdtempSync(NodePath.join(options.sandboxRoot, `${knobs.name}-`));
  const home = NodePath.join(sandbox, "home");
  const qwenHome = NodePath.join(home, ".qwen");
  const t3Home = NodePath.join(sandbox, "t3home");
  const baseDir = NodePath.join(sandbox, "base");
  const workspace = NodePath.join(sandbox, "workspace");
  for (const dir of [NodePath.join(qwenHome, "bin"), t3Home, baseDir, workspace]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  // The app's preflight looks for `<home>/.qwen/bin/cli.js` (paths.ts linux branch); RU_CODE_CLI_JS
  // wins the actual spawn (cli/config.ts:454), exactly as in the e2e pin harness.
  NodeFS.writeFileSync(NodePath.join(qwenHome, "bin", "cli.js"), "// probe detection stub\n");
  // The user's own qwen settings: telemetry off (as the real-qwen harness), nothing MCP-related.
  const userServerEntry =
    knobs.userServer === true
      ? {
          mcpServers: {
            "user-declared": {
              command: process.execPath,
              args: [
                FAKE_MCP_STDIO,
                "--log",
                NodePath.join(outDir, "mcp-user.jsonl"),
                "--tools",
                "3",
                "--prefix",
                "user",
              ],
            },
          },
        }
      : {};
  NodeFS.writeFileSync(
    NodePath.join(qwenHome, "settings.json"),
    `${JSON.stringify(
      {
        telemetry: { enabled: false },
        usageStatisticsEnabled: false,
        ...userServerEntry,
        ...knobs.userSettings,
      },
      null,
      2,
    )}\n`,
  );
  if (knobs.trustedFolders !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(qwenHome, "trustedFolders.json"),
      `${JSON.stringify(knobs.trustedFolders(workspace), null, 2)}\n`,
    );
  }

  // The catalog ids the web would mint (`useMcp.ts` addServer: `srv-<uuid v4>`), minted up front so a
  // knob's transform can name the tools qwen will register (`mcp__<server>__<tool>`).
  const serverIds: ProbeServerIds = {
    local: `srv-${crypto.randomUUID()}`,
    remote: `srv-${crypto.randomUUID()}`,
  };
  const renamedKeys: ProbeServerIds | undefined =
    knobs.serverKeys === "catalog-ids" ? serverIds : knobs.serverKeys;
  const rawTransform: Record<string, unknown> = {
    ...knobs.transform?.(serverIds),
    ...(renamedKeys !== undefined
      ? {
          renameServers: {
            [serverKeyToken("local")]: renamedKeys.local,
            [serverKeyToken("remote")]: renamedKeys.remote,
          },
        }
      : {}),
  };
  // `@STATEDIR@` = the app's state dir, the cwd a warm slot is spawned with (QwenAdapter.ts:990).
  const transform =
    rawTransform["childCwd"] === "@STATEDIR@"
      ? { ...rawTransform, childCwd: NodePath.join(baseDir, "userdata") }
      : rawTransform;

  const runMeta: Record<string, unknown> = {
    name: knobs.name,
    purpose: knobs.purpose,
    knobs: { ...knobs, transform },
    serverIds,
    appHead: gitHead(),
    qwenCliJs: options.cliJs,
    sandbox,
    startedAt: new Date(startedAt).toISOString(),
    commands: [] as unknown[],
  };
  const commandLog = runMeta["commands"] as unknown[];

  // — the fake model backend: every request body, timestamped —
  const modelRequestsPath = NodePath.join(outDir, "model-requests.jsonl");
  let toolSearchCalled = false;
  // The keys qwen got — known only once the app spawned it, so a script is built at the first
  // request of its turn (by then the proxy has recorded them).
  const qwenKeys = (): ProbeServerIds => renamedKeys ?? observedKeys(NodePath.join(outDir, "cli"));
  const scriptBuilders = { "turn 1": knobs.modelScript, "turn 2": knobs.modelScriptTurn2 };
  const scripts: Record<
    string,
    ReadonlyArray<{ name: string; args: Readonly<Record<string, unknown>> }>
  > = {};
  const scriptOf = (turn: "turn 1" | "turn 2") =>
    (scripts[turn] ??= scriptBuilders[turn]?.({ ids: serverIds, keys: qwenKeys() }) ?? []);
  const scriptSteps: Record<string, number> = { "turn 1": 0, "turn 2": 0 };
  const mock = await startFakeOpenAIServer(({ body, requestIndex }) => {
    NodeFS.appendFileSync(
      modelRequestsPath,
      `${JSON.stringify({ at: nowIso(), ms: Date.now(), requestIndex, body })}\n`,
    );
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    const tools = (body["tools"] as Array<{ function?: { name?: string } }> | undefined) ?? [];
    const serialized = JSON.stringify(body["messages"] ?? []);
    const isTurnOne = serialized.includes("PROBE turn 1");
    // The turn a request serves = the scripted prompt whose text appears LAST (history keeps turn 1).
    const turnMarks = [...serialized.matchAll(/PROBE (turn [12])/g)];
    const currentTurn = turnMarks.at(-1)?.[1] ?? null;
    const lastRole = (body["messages"] as Array<{ role?: string }> | undefined)?.at(-1)?.role;
    const turnScript =
      currentTurn === "turn 1" || currentTurn === "turn 2" ? scriptOf(currentTurn) : [];
    const stepIndex = currentTurn === null ? 0 : (scriptSteps[currentTurn] ?? 0);
    const step = turnScript[stepIndex];
    if (
      knobs.killQwenOnTurn !== undefined &&
      currentTurn === knobs.killQwenOnTurn &&
      lastRole === "user" &&
      runMeta["killedQwen"] === undefined
    ) {
      // the ACP process whose session is serving this turn: the newest one that set one up
      const serving = readProcs(NodePath.join(outDir, "cli")).findLast(
        (proc) =>
          proc.meta["isAcp"] === true &&
          proc.wire.some((row) => msgOf(row)?.["method"] === "session/prompt"),
      );
      const childPid = serving?.lifecycle.find((row) => typeof row["childPid"] === "number")?.[
        "childPid"
      ] as number | undefined;
      if (childPid !== undefined) {
        runMeta["killedQwen"] = {
          pid: childPid,
          proc: NodePath.basename(serving?.dir ?? ""),
          ms: Date.now(),
        };
        process.kill(childPid, "SIGKILL");
      }
    }
    if (
      step !== undefined &&
      currentTurn !== null &&
      tools.length > 0 &&
      (lastRole === "user" || lastRole === "tool")
    ) {
      scriptSteps[currentTurn] = stepIndex + 1;
      return {
        toolCalls: [
          {
            id: `call_probe_${currentTurn.replace(" ", "")}_${String(stepIndex + 1)}`,
            type: "function" as const,
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          },
        ],
        usage,
      };
    }
    if (
      knobs.modelToolSearchQuery !== undefined &&
      !toolSearchCalled &&
      isTurnOne &&
      tools.some((tool) => tool.function?.name === "tool_search")
    ) {
      toolSearchCalled = true;
      return {
        toolCalls: [
          {
            id: "call_probe_tool_search",
            type: "function" as const,
            function: {
              name: "tool_search",
              arguments: JSON.stringify({ query: knobs.modelToolSearchQuery }),
            },
          },
        ],
        usage,
      };
    }
    return knobs.answerChunks === undefined
      ? { content: "PROBE-ANSWER ok", usage }
      : {
          contentChunks: Array.from(
            { length: knobs.answerChunks },
            (_, index) => `PROBE-ANSWER part ${String(index)}. `,
          ),
          usage,
        };
  });

  // — the REMOTE fake MCP (streamable HTTP), its own process —
  const remotePortFile = NodePath.join(sandbox, "remote.port");
  const remote = NodeChildProcess.spawn(
    process.execPath,
    [
      FAKE_MCP_HTTP,
      "--log",
      NodePath.join(outDir, "mcp-remote.jsonl"),
      "--port-file",
      remotePortFile,
      "--tools",
      String(knobs.remote.tools),
      "--prefix",
      "remote",
      "--delay-ms",
      String(knobs.remote.delayMs),
      ...(knobs.remote.nameLen !== undefined ? ["--name-len", String(knobs.remote.nameLen)] : []),
      ...(knobs.remote.callDelayMs !== undefined
        ? ["--call-delay-ms", String(knobs.remote.callDelayMs)]
        : []),
    ],
    { stdio: "ignore" },
  );
  const remotePort = await waitFor("remote MCP port", 10_000, () =>
    NodeFS.existsSync(remotePortFile) ? NodeFS.readFileSync(remotePortFile, "utf8").trim() : null,
  );
  const remoteUrl = `http://127.0.0.1:${remotePort}/mcp`;

  // — the LOCAL fake MCP (stdio): its argv is what the user types into the app's form —
  const localArgs = [
    FAKE_MCP_STDIO,
    "--log",
    NodePath.join(outDir, "mcp-local.jsonl"),
    "--tools",
    String(knobs.local.tools),
    "--prefix",
    "local",
    "--delay-ms",
    String(knobs.local.delayMs),
    ...(knobs.local.crash === true ? ["--crash"] : []),
    ...(knobs.local.nameLen !== undefined ? ["--name-len", String(knobs.local.nameLen)] : []),
    ...(knobs.local.callDelayMs !== undefined
      ? ["--call-delay-ms", String(knobs.local.callDelayMs)]
      : []),
  ];

  const extraServerArgs =
    knobs.extra === undefined
      ? null
      : [
          FAKE_MCP_STDIO,
          "--log",
          NodePath.join(outDir, "mcp-extra.jsonl"),
          "--tools",
          String(knobs.extra.tools),
          "--prefix",
          "extra",
          "--delay-ms",
          String(knobs.extra.delayMs),
        ];

  // — a server the USER declared in the project's own qwen settings (knob) —
  if (knobs.workspaceServer === true) {
    NodeFS.mkdirSync(NodePath.join(workspace, ".qwen"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(workspace, ".qwen", "settings.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            "ws-declared": {
              command: process.execPath,
              args: [
                FAKE_MCP_STDIO,
                "--log",
                NodePath.join(outDir, "mcp-workspace.jsonl"),
                "--tools",
                "3",
                "--prefix",
                "ws",
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  // — boot the app: a CLEAN env (no vitest/NODE_ENV leakage), the pin harness's switches —
  const clockOffsetFile = NodePath.join(sandbox, "clock-offset-ms");
  const serverEnv: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    LANG: process.env["LANG"] ?? "C.UTF-8",
    HOME: home,
    T3CODE_HOME: t3Home,
    TZ: "UTC",
    T3CODE_NO_BROWSER: "1",
    T3CODE_LOG_LEVEL: "Debug",
    RU_CODE_ACP_PROTOCOL_LOG: "1",
    RU_CODE_CLI_JS: CLI_PROXY,
    OPENAI_API_KEY: "fake-key",
    OPENAI_BASE_URL: mock.baseUrl,
    OPENAI_MODEL: "fake-model",
    PROBE_REAL_QWEN_CLI: options.cliJs,
    PROBE_LOG_DIR: NodePath.join(outDir, "cli"),
    PROBE_HOLD_PROMPT_MS: String(knobs.holdPromptMs),
    PROBE_STATUS_AT_MS: knobs.statusAtMs.join(","),
    PROBE_CHILD_ENV_JSON: JSON.stringify(knobs.childEnv ?? {}),
    PROBE_TRANSFORM: JSON.stringify(transform),
    // How the proxy tells the servers apart in the app's overlay: a string only that entry holds.
    PROBE_SERVER_ROLES: JSON.stringify({
      local: knobs.realLocalServer?.args.at(-1) ?? NodePath.join(outDir, "mcp-local.jsonl"),
      remote: remoteUrl,
      extra: NodePath.join(outDir, "mcp-extra.jsonl"),
    }),
    ...(knobs.warmEngine !== undefined ? { RU_CODE_WARM_ENGINE: knobs.warmEngine } : {}),
    ...(knobs.resume === "ttl-expiry"
      ? { NODE_OPTIONS: `--require ${CLOCK_SHIFT}`, PROBE_CLOCK_OFFSET_FILE: clockOffsetFile }
      : {}),
    ...knobs.appEnv,
  };
  runMeta["serverEnv"] = serverEnv;
  const serverPids: number[] = [];
  runMeta["serverPids"] = serverPids;
  const cliDir = NodePath.join(outDir, "cli");
  const summaryHolder: { summary?: ProbeSummary } = {};
  try {
    /** One app server on `bin`: spawned in its own group, ready, and a browser session for /ws. */
    const bootServer = async (bin: string, logName: string) => {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = NodeChildProcess.spawnSync(
          process.execPath,
          [
            "-e",
            "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
          ],
          { encoding: "utf8" },
        );
        const value = Number(probe.stdout);
        if (Number.isFinite(value) && value > 0) resolve(value);
        else reject(new Error(`no free port: ${probe.stderr}`));
      });
      const serverArgv = [
        bin,
        "start",
        "--foreground",
        "--no-browser",
        "--port",
        String(port),
        "--base-dir",
        baseDir,
      ];
      runMeta[logName === "app-server.log" ? "serverArgv" : "previousServerArgv"] = serverArgv;
      const serverLog = NodeFS.openSync(NodePath.join(outDir, logName), "w");
      const server = NodeChildProcess.spawn(process.execPath, serverArgv, {
        cwd: sandbox,
        env: serverEnv,
        detached: true,
        stdio: ["ignore", serverLog, serverLog],
      });
      NodeFS.closeSync(serverLog);
      const pid = server.pid ?? -1;
      serverPids.push(pid);
      // readiness + the pairing credential, from the server's own runtime-state file
      const runtimeState = NodePath.join(baseDir, "userdata", "server-runtime.json");
      const pairingUrl = await waitFor("server-runtime.json pairingUrl", 90_000, () => {
        try {
          const state = JSON.parse(NodeFS.readFileSync(runtimeState, "utf8")) as {
            pairingUrl?: string;
          };
          return state.pairingUrl ?? null;
        } catch {
          return null;
        }
      });
      await waitFor("GET /healthz", 60_000, () => {
        const result = NodeChildProcess.spawnSync(
          "curl",
          [
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            `http://127.0.0.1:${String(port)}/healthz`,
          ],
          { encoding: "utf8" },
        );
        return result.stdout.trim() === "200";
      });
      const pairing = new URL(pairingUrl);
      const credential =
        pairing.searchParams.get("token") ??
        new URLSearchParams(pairing.hash.replace(/^#/, "")).get("token") ??
        "";
      const sessionResponse = await fetch(
        `http://127.0.0.1:${String(port)}/api/auth/browser-session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential }),
        },
      );
      const setCookie = sessionResponse.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0] ?? "";
      runMeta["auth"] = { status: sessionResponse.status, cookieSet: cookie.length > 0 };
      if (!sessionResponse.ok || cookie.length === 0) {
        throw new Error(`browser-session auth failed: ${String(sessionResponse.status)}`);
      }
      return { pid, wsUrl: `ws://127.0.0.1:${String(port)}/ws`, cookie };
    };

    // The server the web talks to: an older release first (reinstall knob), else the real build.
    let target = await bootServer(
      knobs.previousRelease === undefined
        ? BUILT_SERVER
        : previousReleaseBin(sandbox, knobs.previousRelease.builtins),
      knobs.previousRelease === undefined ? "app-server.log" : "app-server-previous.log",
    );

    const projectId = ProjectId.make("probe-project");
    const localId = McpServerId.make(serverIds.local);
    const remoteId = McpServerId.make(serverIds.remote);
    const modelSelection = { instanceId: ProviderInstanceId.make("qwen"), model: "" };

    const dispatch = async (label: string, command: unknown) => {
      const at = Date.now();
      try {
        const result = await withClient(target.wsUrl, target.cookie, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](
            command as Parameters<
              (typeof client)[typeof ORCHESTRATION_WS_METHODS.dispatchCommand]
            >[0],
          ),
        );
        commandLog.push({ label, at, ms: Date.now() - at, command, result });
        return result;
      } catch (error) {
        commandLog.push({ label, at, ms: Date.now() - at, command, error: String(error) });
        throw error;
      }
    };

    // The project, then the two servers and their bindings — the web's own payloads
    // (useMcp.ts addServer / addBindingToProject).
    await dispatch("project.create", {
      type: "project.create",
      commandId: CommandId.make(crypto.randomUUID()),
      projectId,
      title: "probe",
      workspaceRoot: workspace,
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: modelSelection,
      createdAt: nowIso(),
    });
    if (knobs.appMcp !== false)
      await dispatch("mcp.server-add local", {
        type: "mcp.server-add",
        commandId: CommandId.make(crypto.randomUUID()),
        serverId: localId,
        draft: {
          name: knobs.realLocalServer?.name ?? "probe-local",
          config: knobs.realLocalServer
            ? {
                transport: "stdio",
                command: knobs.realLocalServer.command,
                args: [...knobs.realLocalServer.args],
              }
            : { transport: "stdio", command: process.execPath, args: localArgs },
          vars: [...(knobs.localDraft?.vars ?? [])],
          extraArgs: [],
          extraHeaders: { ...knobs.localDraft?.extraHeaders },
          trust: knobs.localDraft?.trust ?? true,
          timeoutMs: knobs.localDraft?.timeoutMs ?? null,
        },
        createdAt: nowIso(),
      });
    if (knobs.appMcp !== false)
      await dispatch("mcp.server-add remote", {
        type: "mcp.server-add",
        commandId: CommandId.make(crypto.randomUUID()),
        serverId: remoteId,
        draft: {
          name: "probe-remote",
          config: {
            transport: "http",
            httpUrl: remoteUrl,
            headers: { ...knobs.remoteDraft?.headers },
          },
          vars: [...(knobs.remoteDraft?.vars ?? [])],
          extraArgs: [],
          extraHeaders: { ...knobs.remoteDraft?.extraHeaders },
          trust: knobs.remoteDraft?.trust ?? true,
          timeoutMs: knobs.remoteDraft?.timeoutMs ?? null,
        },
        createdAt: nowIso(),
      });
    const extraId = McpServerId.make(`srv-${crypto.randomUUID()}`);
    if (extraServerArgs !== null) {
      runMeta["extraServerId"] = extraId;
      await dispatch("mcp.server-add extra", {
        type: "mcp.server-add",
        commandId: CommandId.make(crypto.randomUUID()),
        serverId: extraId,
        draft: {
          name: "probe-extra",
          config: { transport: "stdio", command: process.execPath, args: extraServerArgs },
          vars: [],
          extraArgs: [],
          extraHeaders: {},
          trust: true,
          timeoutMs: null,
        },
        createdAt: nowIso(),
      });
    }
    const bindEnabled = (label: string, serverId: McpServerId) =>
      dispatch(`mcp.binding-set ${label} enabled`, {
        type: "mcp.binding-set",
        commandId: CommandId.make(crypto.randomUUID()),
        projectId,
        serverId,
        patch: { enabled: true },
      });
    const initialBindings: ReadonlyArray<readonly [string, McpServerId]> =
      knobs.appMcp === false
        ? []
        : knobs.realLocalServer !== undefined
          ? [["local", localId]]
          : knobs.resume === "cold-add-server"
            ? [["remote", remoteId]]
            : [
                ["local", localId],
                ["remote", remoteId],
              ];
    for (const [label, serverId] of initialBindings) {
      await bindEnabled(label, serverId);
    }
    if (knobs.localToolPolicy !== undefined) {
      await dispatch("mcp.binding-set local toolPolicy", {
        type: "mcp.binding-set",
        commandId: CommandId.make(crypto.randomUUID()),
        projectId,
        serverId: localId,
        patch: {
          toolPolicy: {
            defaultDecision: knobs.localToolPolicy.defaultDecision,
            exceptions: [...knobs.localToolPolicy.exceptions],
          },
        },
      });
    }
    const mcpSnapshot = () =>
      withClient(target.wsUrl, target.cookie, (client) =>
        client[MCP_MANAGER_METHODS.mcpGetSnapshot]({ projectId }),
      );
    if (knobs.previousRelease !== undefined) {
      for (const builtinId of knobs.previousRelease.bindBuiltins) {
        await bindEnabled(`builtin ${builtinId}`, McpServerId.make(`srv-builtin-${builtinId}`));
      }
      runMeta["mcpSnapshots"] = { previousRelease: await mcpSnapshot() };
      // stop the older release (its whole group), then the real build on the same data
      const previousPid = target.pid;
      process.kill(-previousPid, "SIGTERM");
      await waitFor("the older release exited", 30_000, () => !isAlive(previousPid));
      NodeFS.rmSync(NodePath.join(baseDir, "userdata", "server-runtime.json"), { force: true });
      target = await bootServer(BUILT_SERVER, "app-server.log");
    }
    const startTurn = async (threadId: ThreadId, text: string, createThread: boolean) => {
      if (createThread) {
        await dispatch(`thread.create ${threadId}`, {
          type: "thread.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          projectId,
          title: `probe ${threadId}`,
          modelSelection,
          runtimeMode: knobs.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          chatViewMode: null,
          branch: null,
          worktreePath: null,
          createdAt: nowIso(),
        });
      }
      await dispatch(`thread.turn.start ${threadId}`, {
        type: "thread.turn.start",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection,
        runtimeMode: knobs.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: nowIso(),
      });
    };

    const promptAnswers = () =>
      readProcs(cliDir).flatMap((proc) =>
        answerTimes(proc, "session/prompt").map((ms) => ({ proc, ms })),
      );
    const turnBudget = knobs.holdPromptMs + 150_000;

    // Turn 1 — a fresh thread in the MCP project (the first MCP start of a project is always cold).
    const threadA = ThreadId.make("probe-thread-a");
    await startTurn(threadA, "PROBE turn 1: list the tools you have.", true);
    const permissionAsked = () =>
      readProcs(cliDir).some((proc) =>
        proc.wire.some(
          (row) =>
            row["dir"] === "qwen->app" && msgOf(row)?.["method"] === "session/request_permission",
        ),
      );
    await waitFor("turn 1 answered (session/prompt answer on the wire)", turnBudget, () =>
      promptAnswers().length >= 1 || (knobs.stopOnPermissionRequest === true && permissionAsked())
        ? true
        : null,
    );

    if (knobs.resume !== undefined) {
      const markTrigger = (what: string) => {
        runMeta["resumeTrigger"] = { what, ms: Date.now(), at: nowIso() };
      };
      if (knobs.resume === "cold-add-server") {
        markTrigger("mcp.binding-set LOCAL enabled (server set changes)");
        await bindEnabled("local", localId);
      } else if (knobs.resume === "warm-toggle-tool") {
        const slot = await waitFor("an MCP warm slot warmed up", 120_000, () =>
          readProcs(cliDir).find((proc) => {
            const env = proc.meta["envSelected"] as Record<string, string> | undefined;
            return (
              proc.meta["isAcp"] === true &&
              (env?.["QWEN_CODE_SYSTEM_SETTINGS_PATH"] ?? "").includes("qwen-warm") &&
              answerTimes(proc, "authenticate").length > 0
            );
          }),
        );
        runMeta["warmSlotProcBeforeResume"] = NodePath.basename(slot.dir);
        markTrigger("mcp.binding-set LOCAL toolPolicy {allow, exceptions:[local_tool_50]}");
        // The web's setToolEnabled(…, "local_tool_50", false) payload (adapters.ts:321-337).
        await dispatch("mcp.binding-set local toolPolicy", {
          type: "mcp.binding-set",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId,
          serverId: localId,
          patch: { toolPolicy: { defaultDecision: "allow", exceptions: ["local_tool_50"] } },
        });
      } else if (knobs.resume === "swap-remote-for-extra") {
        markTrigger("mcp.binding-set EXTRA enabled + mcp.binding-set REMOTE disabled (A+B → A+C)");
        await bindEnabled("extra", extraId);
        await dispatch("mcp.binding-set remote disabled", {
          type: "mcp.binding-set",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId,
          serverId: remoteId,
          patch: { enabled: false },
        });
      } else {
        markTrigger("server clock +31 min (no MCP change)");
        NodeFS.writeFileSync(clockOffsetFile, String(31 * 60 * 1000));
        await sleep(1_000);
      }
      await startTurn(threadA, "PROBE turn 2 (resume): list the tools you have.", false);
      await waitFor("resume turn answered", turnBudget, () =>
        promptAnswers().length >= 2 ? true : null,
      );
    }

    if (knobs.secondTurnAfterMs !== undefined) {
      await sleep(knobs.secondTurnAfterMs);
      if (knobs.secondTurnAfterServersLoaded === true) {
        const debugDir = NodePath.join(qwenHome, "debug");
        const loaded = (id: string) =>
          new RegExp(`SessionMcpView\\[[^/\\]]+/${id}\\] applied \\d+ tools`);
        await waitFor("both servers registered in the session (debug log)", 120_000, () => {
          let text = "";
          try {
            for (const file of NodeFS.readdirSync(debugDir)) {
              if (file.endsWith(".txt"))
                text += NodeFS.readFileSync(NodePath.join(debugDir, file), "utf8");
            }
          } catch {
            return null;
          }
          const keys = qwenKeys();
          return loaded(keys.local).test(text) && loaded(keys.remote).test(text) ? true : null;
        });
        runMeta["secondTurnReleasedMs"] = Date.now();
      }
      await startTurn(threadA, "PROBE turn 2: list the tools you have.", false);
      const killed = knobs.killQwenOnTurn === "turn 2";
      if (killed) {
        await waitFor("the killed qwen's exit recorded by the proxy", turnBudget, () =>
          readProcs(cliDir).some((proc) =>
            proc.lifecycle.some(
              (row) => row["event"] === "child-exit" && row["signal"] === "SIGKILL",
            ),
          )
            ? true
            : null,
        );
      } else {
        await waitFor("turn 2 answered", turnBudget, () =>
          promptAnswers().length >= 2 ? true : null,
        );
      }
      if (knobs.thirdTurnAfterMs !== undefined) {
        await sleep(knobs.thirdTurnAfterMs);
        await startTurn(threadA, "PROBE turn 3: list the tools you have.", false);
        await waitFor("turn 3 answered", turnBudget, () =>
          promptAnswers().length >= (killed ? 2 : 3) ? true : null,
        );
      }
    }

    if (knobs.warmTake === true) {
      // The project's MCP slot: an --acp process spawned AFTER turn 1 whose settings env points
      // under qwen-warm/, warmed (authenticate answered) and not yet bound.
      const slot = await waitFor("an MCP warm slot warmed up", 120_000, () =>
        readProcs(cliDir).find((proc) => {
          const env = proc.meta["envSelected"] as Record<string, string> | undefined;
          const path = env?.["QWEN_CODE_SYSTEM_SETTINGS_PATH"] ?? "";
          return (
            proc.meta["isAcp"] === true &&
            path.includes("qwen-warm") &&
            answerTimes(proc, "authenticate").length > 0
          );
        }),
      );
      runMeta["warmSlotProc"] = NodePath.basename(slot.dir);
      const threadB = ThreadId.make("probe-thread-b");
      await startTurn(threadB, "PROBE warm turn: list the tools you have.", true);
      await waitFor("warm turn answered", turnBudget, () =>
        readProcs(cliDir).some(
          (proc) => proc.dir === slot.dir && answerTimes(proc, "session/prompt").length > 0,
        )
          ? true
          : null,
      );
    }

    if (knobs.previousRelease !== undefined) {
      runMeta["mcpSnapshots"] = {
        ...(runMeta["mcpSnapshots"] as Record<string, unknown>),
        reinstalled: await mcpSnapshot(),
      };
    }

    // Let every scheduled status probe fire: the last offset after the LAST session/new answer.
    const lastSessionNew = Math.max(
      0,
      ...readProcs(cliDir).flatMap((proc) => [
        ...answerTimes(proc, "session/new"),
        ...answerTimes(proc, "session/load"),
      ]),
    );
    const lastOffset = Math.max(0, ...knobs.statusAtMs);
    const settleUntil = Math.max(lastSessionNew + lastOffset + 3_000, Date.now() + 3_000);
    await sleep(Math.max(0, settleUntil - Date.now()));
  } catch (error) {
    runMeta["error"] = String(error instanceof Error ? (error.stack ?? error.message) : error);
  } finally {
    // — teardown: the server group, every qwen child the proxy started, the fakes —
    for (const serverPid of serverPids) {
      try {
        process.kill(-serverPid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    await sleep(2_000);
    for (const serverPid of serverPids) {
      try {
        process.kill(-serverPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    const leftovers: number[] = [];
    for (const proc of readProcs(cliDir)) {
      for (const row of proc.lifecycle) {
        const childPid = row["childPid"];
        if (typeof childPid === "number" && isAlive(childPid)) {
          leftovers.push(childPid);
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      }
    }
    try {
      remote.kill("SIGKILL");
    } catch {
      /* gone */
    }
    await mock.close();
    const stray = NodeChildProcess.spawnSync("pgrep", ["-af", sandbox], { encoding: "utf8" });
    runMeta["teardown"] = {
      killedLeftoverQwenPids: leftovers,
      strayAfterTeardown: stray.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== ""),
    };
    // qwen's own debug log (QWEN_DEBUG_LOG_FILE=1 → <QWEN_HOME>/debug/<sessionId>.txt)
    const debugDir = NodePath.join(qwenHome, "debug");
    if (NodeFS.existsSync(debugDir)) {
      NodeFS.cpSync(debugDir, NodePath.join(outDir, "qwen-debug"), {
        recursive: true,
        // `latest` is a symlink into the sandbox — the evidence is the files themselves.
        filter: (source) => !NodeFS.lstatSync(source).isSymbolicLink(),
      });
    }
    // The settings files qwen may WRITE (S94 addendum 8): the user's, the project's, and every
    // system path a process was pointed at — as they are after the run.
    const readOrAbsent = (path: string) => {
      try {
        return NodeFS.readFileSync(path, "utf8");
      } catch {
        return "absent";
      }
    };
    runMeta["settingsFilesAfter"] = {
      user: {
        path: NodePath.join(qwenHome, "settings.json"),
        text: readOrAbsent(NodePath.join(qwenHome, "settings.json")),
      },
      workspace: {
        path: NodePath.join(workspace, ".qwen", "settings.json"),
        text: readOrAbsent(NodePath.join(workspace, ".qwen", "settings.json")),
      },
      system: [
        ...new Set(
          readProcs(cliDir)
            .map(
              (proc) =>
                (proc.meta["envSelected"] as Record<string, string> | undefined)?.[
                  "QWEN_CODE_SYSTEM_SETTINGS_PATH"
                ],
            )
            .filter((path): path is string => typeof path === "string"),
        ),
      ].map((path) => ({ path, text: readOrAbsent(path) })),
    };
    // the app's overlay dir as it was left (the app deletes the file once the start settles)
    const overlayRoot = NodePath.join(baseDir, "userdata", "mcp", "overlays");
    runMeta["overlayDirAfterRun"] = NodeFS.existsSync(overlayRoot)
      ? NodeFS.readdirSync(overlayRoot, { recursive: true })
      : "absent";
    runMeta["serverKeys"] = (() => {
      try {
        return qwenKeys();
      } catch {
        return null;
      }
    })();
    runMeta["endedAt"] = nowIso();
    runMeta["durationMs"] = Date.now() - startedAt;
    summaryHolder.summary = summarize(outDir, runMeta);
    NodeFS.writeFileSync(
      NodePath.join(outDir, "run-meta.json"),
      `${JSON.stringify(runMeta, null, 2)}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(outDir, "summary.json"),
      `${JSON.stringify(summaryHolder.summary, null, 2)}\n`,
    );
  }
  return { outDir, summary: summaryHolder.summary as ProbeSummary };
}

// ── the four angles, reduced to facts ─────────────────────────────────────────────────────────
/** One `SessionMcpView[<session>/<server>] applied N tools (filtered to M registered)` debug line. */
export interface RegisteredTools {
  readonly ms: number;
  readonly sessionId: string;
  readonly server: string;
  readonly applied: number;
  readonly registered: number;
}

export interface ProbeSummary {
  readonly name: string;
  readonly error: string | null;
  readonly serverIds: ProbeServerIds | null;
  /** The server keys qwen got (the app's, observed by the proxy, or a knob's rename). */
  readonly serverKeys: ProbeServerIds | null;
  /** qwen's per-session MCP registrations, from its debug log. */
  readonly registered: ReadonlyArray<RegisteredTools>;
  readonly sessionConfigs: ReadonlyArray<Record<string, unknown>>;
  /** S94 addendum 8: the user / project / system settings files as they are after the run. */
  readonly settingsFilesAfter: Record<string, unknown> | null;
  /** The app's own respawn reasons, in order (`spawnReason: '…'` in its server log). */
  readonly appSpawnReasons: ReadonlyArray<string>;
  readonly acpProcs: ReadonlyArray<Record<string, unknown>>;
  readonly otherInvocations: ReadonlyArray<Record<string, unknown>>;
  readonly mcp: Record<string, ReadonlyArray<Record<string, unknown>>>;
  readonly model: ReadonlyArray<Record<string, unknown>>;
  readonly debugLogMcpLines: ReadonlyArray<string>;
}

export function summarize(outDir: string, runMeta: Record<string, unknown>): ProbeSummary {
  const procs = readProcs(NodePath.join(outDir, "cli"));
  const acpProcs = procs
    .filter((proc) => proc.meta["isAcp"] === true)
    .map((proc) => {
      const settings = readJsonl(NodePath.join(proc.dir, "settings.jsonl")).map((row) => ({
        label: row["label"],
        ms: row["ms"],
        exists: row["exists"],
        sha256: row["sha256"] ?? null,
        size: row["size"] ?? null,
      }));
      const probes = readJsonl(NodePath.join(proc.dir, "probes.jsonl")).map((row) => {
        const result = row["result"] as Record<string, unknown> | undefined;
        return {
          label: row["label"],
          method: row["method"],
          params: row["params"],
          error: row["error"] ?? null,
          result,
        };
      });
      const appCalls = proc.wire
        .filter((row) => row["dir"] === "app->qwen" && typeof msgOf(row)?.["method"] === "string")
        .map((row) => ({
          ms: row["ms"],
          method: msgOf(row)?.["method"],
          params:
            msgOf(row)?.["method"] === "session/prompt"
              ? "(prompt)"
              : (msgOf(row)?.["params"] ?? null),
          note: row["note"] ?? null,
        }));
      const env = proc.meta["envSelected"] as Record<string, string> | undefined;
      let stderr = "";
      try {
        stderr = NodeFS.readFileSync(NodePath.join(proc.dir, "stderr.log"), "utf8");
      } catch {
        stderr = "";
      }
      const sessionCall = proc.wire.find(
        (row) =>
          row["dir"] === "app->qwen" &&
          (msgOf(row)?.["method"] === "session/new" || msgOf(row)?.["method"] === "session/load"),
      );
      const sessionCallId = sessionCall ? msgOf(sessionCall)?.["id"] : undefined;
      const sessionAnswer = proc.wire.find(
        (row) =>
          row["dir"] === "qwen->app" &&
          msgOf(row)?.["method"] === undefined &&
          sessionCallId !== undefined &&
          msgOf(row)?.["id"] === sessionCallId,
      );
      const sessionId =
        ((msgOf(sessionAnswer ?? {})?.["result"] as Record<string, unknown> | undefined)?.[
          "sessionId"
        ] as string | undefined) ??
        ((msgOf(sessionCall ?? {})?.["params"] as Record<string, unknown> | undefined)?.[
          "sessionId"
        ] as string | undefined) ??
        null;
      return {
        proc: NodePath.basename(proc.dir),
        sessionCall: sessionCall ? msgOf(sessionCall)?.["method"] : null,
        sessionCallMs: sessionCall?.["ms"] ?? null,
        sessionId,
        /** Every tool call qwen reported to the app (session/update tool_call / tool_call_update). */
        toolCalls: proc.wire
          .filter((row) => {
            const update = (msgOf(row)?.["params"] as Record<string, unknown> | undefined)?.[
              "update"
            ] as Record<string, unknown> | undefined;
            return (
              row["dir"] === "qwen->app" &&
              msgOf(row)?.["method"] === "session/update" &&
              (update?.["sessionUpdate"] === "tool_call" ||
                update?.["sessionUpdate"] === "tool_call_update")
            );
          })
          .map((row) => {
            const params = msgOf(row)?.["params"] as Record<string, unknown> | undefined;
            const update = (params?.["update"] ?? {}) as Record<string, unknown>;
            return {
              ms: row["ms"],
              kind: update["sessionUpdate"],
              toolCallId: update["toolCallId"] ?? null,
              title: update["title"] ?? null,
              status: update["status"] ?? null,
              content: JSON.stringify(update["content"] ?? null).slice(0, 4000),
            };
          }),
        requestPermissions: proc.wire
          .filter(
            (row) =>
              row["dir"] === "qwen->app" && msgOf(row)?.["method"] === "session/request_permission",
          )
          .map((row) => ({ ms: row["ms"], params: msgOf(row)?.["params"] ?? null })),
        requestPermissionCount: proc.wire.filter(
          (row) =>
            row["dir"] === "qwen->app" && msgOf(row)?.["method"] === "session/request_permission",
        ).length,
        argv: proc.meta["argv"],
        cwd: proc.meta["cwd"],
        settingsPathEnv: env?.["QWEN_CODE_SYSTEM_SETTINGS_PATH"] ?? null,
        qwenHomeEnv: env?.["QWEN_HOME"] ?? null,
        spawnedMs: proc.meta["ms"],
        answers: {
          initialize: answerTimes(proc, "initialize"),
          authenticate: answerTimes(proc, "authenticate"),
          sessionNew: answerTimes(proc, "session/new"),
          sessionLoad: answerTimes(proc, "session/load"),
          sessionPrompt: answerTimes(proc, "session/prompt"),
        },
        appCalls,
        settings,
        probes,
        stderrMcpLines: stderr
          .split("\n")
          .filter((line) => /mcp/i.test(line))
          .slice(0, 50),
        lifecycle: proc.lifecycle,
      };
    });
  const otherInvocations = procs
    .filter((proc) => proc.meta["isAcp"] !== true)
    .map((proc) => ({
      proc: NodePath.basename(proc.dir),
      argv: proc.meta["argv"],
      ms: proc.meta["ms"],
    }));

  const mcp: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const kind of ["local", "remote", "workspace", "extra", "user"]) {
    const rows = readJsonl(NodePath.join(outDir, `mcp-${kind}.jsonl`));
    mcp[kind] = rows
      .filter((row) => row["event"] !== "send")
      .map((row) => ({
        ms: row["ms"],
        event: row["event"],
        pid: row["pid"] ?? null,
        method: row["method"] ?? null,
        clientInfo: row["clientInfo"] ?? null,
        userAgent: (row["headers"] as Record<string, unknown> | undefined)?.["user-agent"] ?? null,
        envMarks: row["envMarks"] ?? undefined,
        cwd: row["cwd"] ?? undefined,
        probeHeaders:
          row["headers"] === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(row["headers"] as Record<string, unknown>).filter(([name]) =>
                  name.startsWith("x-probe"),
                ),
              ),
        parent:
          typeof row["parentCmdline"] === "string"
            ? (row["parentCmdline"] as string).includes("cliProxy") ||
              (row["parentCmdline"] as string).includes("qwen-build")
              ? "qwen"
              : "app"
            : undefined,
      }));
  }

  const model = readJsonl(NodePath.join(outDir, "model-requests.jsonl")).map((row) => {
    const body = row["body"] as Record<string, unknown>;
    const tools = (body["tools"] as Array<Record<string, unknown>> | undefined) ?? [];
    const names = tools.map(
      (tool) =>
        ((tool["function"] as Record<string, unknown> | undefined)?.["name"] as string) ?? "?",
    );
    const text = JSON.stringify(body["messages"] ?? []);
    const mcpNamesInMessages = new Set(text.match(/mcp__[A-Za-z0-9_-]+/g) ?? []);
    const lastUser = JSON.stringify(
      ((body["messages"] as Array<Record<string, unknown>> | undefined) ?? []).findLast(
        (message) => message["role"] === "user",
      )?.["content"] ?? "",
    );
    const lastRole = ((body["messages"] as Array<Record<string, unknown>> | undefined) ?? []).at(
      -1,
    )?.["role"];
    return {
      ms: row["ms"],
      requestIndex: row["requestIndex"],
      /**
       * Which scripted turn this request serves: the LAST mark in its last user message (qwen merges
       * an unanswered prompt into the next one), null for side queries.
       */
      probeTurn:
        [...lastUser.matchAll(/PROBE (turn 1|turn 2 \(resume\)|turn 2|turn 3|warm turn)/g)].at(
          -1,
        )?.[1] ?? null,
      /** "tool" when this request follows a tool result (the same turn's continuation). */
      lastRole: lastRole ?? null,
      stream: body["stream"] ?? null,
      toolCount: names.length,
      mcpToolCount: names.filter((name) => name.startsWith("mcp__")).length,
      mcpToolsByServer: {
        local: names.filter((name) => name.includes("local_tool_")).length,
        remote: names.filter((name) => name.includes("remote_tool_")).length,
        extra: names.filter((name) => name.includes("extra_tool_")).length,
      },
      /** Request size: the JSON body in bytes, and the `tools` array alone. */
      bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      toolsBytes: Buffer.byteLength(JSON.stringify(body["tools"] ?? [])),
      /** Every <system-reminder> block that names an MCP tool, in message order, with its names. */
      mcpReminders: [...text.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)]
        .map((match) => match[1] ?? "")
        .filter((block) => block.includes("mcp__"))
        .map((block) => ({
          head: block.slice(0, 400),
          names: [...new Set(block.match(/mcp__[A-Za-z0-9_-]+/g) ?? [])],
        })),
      hasToolSearch: names.includes("tool_search"),
      toolNames: names,
      mcpToolNamesInMessages: mcpNamesInMessages.size,
      mcpToolNamesInMessagesList: [...mcpNamesInMessages].sort(),
      /** The model's view of the last tool result (the newest `role:"tool"` message), verbatim. */
      lastToolMessage:
        (() => {
          const message = (
            (body["messages"] as Array<Record<string, unknown>> | undefined) ?? []
          ).findLast((entry) => entry["role"] === "tool");
          if (message === undefined) return null;
          const content = message["content"];
          return (typeof content === "string" ? content : JSON.stringify(content)).slice(0, 6000);
        })() ?? null,
      // qwen's late-MCP reminder (environmentContext.ts:240,245,251 — buildChangedMcpToolsReminder)
      addedMcpToolsReminder:
        text.includes("MCP tools became available after startup") ||
        text.includes("The available MCP tools changed after startup") ||
        text.includes("MCP tools are now available"),
      messagesMentionLocalTools: (text.match(/local_tool_\d\d/g) ?? []).length,
      messagesMentionRemoteTools: (text.match(/remote_tool_\d\d/g) ?? []).length,
      firstUserText:
        ((body["messages"] as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((message) => message["role"] === "user")
          .map((message) => JSON.stringify(message["content"]).slice(0, 120))
          .at(-1) ?? null,
    };
  });

  const debugLogMcpLines: string[] = [];
  const registered: RegisteredTools[] = [];
  /** The log-only patch's per-session settings dump (S94/P-patch-logonly.diff). */
  const sessionConfigs: Array<Record<string, unknown>> = [];
  const debugDir = NodePath.join(outDir, "qwen-debug");
  if (NodeFS.existsSync(debugDir)) {
    for (const file of NodeFS.readdirSync(debugDir)) {
      const text = NodeFS.readFileSync(NodePath.join(debugDir, file), "utf8");
      for (const line of text.split("\n")) {
        const view =
          /^(\S+Z) .*SessionMcpView\[([^/\]]+)\/([^\]]+)\] applied (\d+) tools \(filtered to (\d+) registered\)/.exec(
            line,
          );
        const dump = /^(\S+Z) .*\[S94-PROBE\] session-config (\{.*\})\s*$/.exec(line);
        if (dump) {
          sessionConfigs.push({
            ms: Date.parse(dump[1] as string),
            file,
            ...(JSON.parse(dump[2] as string) as Record<string, unknown>),
          });
          continue;
        }
        if (view) {
          registered.push({
            ms: Date.parse(view[1] as string),
            sessionId: view[2] as string,
            server: view[3] as string,
            applied: Number(view[4]),
            registered: Number(view[5]),
          });
        }
        if (
          /mcp|MCP|Pool acquire|SessionMcpView|pending-approval|Tool registry|settings-cache/.test(
            line,
          )
        ) {
          debugLogMcpLines.push(`${file}: ${line.slice(0, 400)}`);
        }
      }
    }
  }

  let appLog = "";
  try {
    appLog = NodeFS.readFileSync(NodePath.join(outDir, "app-server.log"), "utf8");
  } catch {
    appLog = "";
  }
  const appSpawnReasons = [...appLog.matchAll(/spawnReason: '([^']+)'/g)].map(
    (match) => match[1] as string,
  );
  return {
    name: String(runMeta["name"]),
    error: (runMeta["error"] as string | undefined) ?? null,
    serverIds: (runMeta["serverIds"] as ProbeServerIds | undefined) ?? null,
    serverKeys: (runMeta["serverKeys"] as ProbeServerIds | null | undefined) ?? null,
    registered,
    sessionConfigs,
    settingsFilesAfter:
      (runMeta["settingsFilesAfter"] as Record<string, unknown> | undefined) ?? null,
    appSpawnReasons,
    acpProcs,
    otherInvocations,
    mcp,
    model,
    debugLogMcpLines: debugLogMcpLines.slice(0, 400),
  };
}
