/**
 * ru-code: the server-side plugin host — scan, activate, report, invoke.
 *
 * This is the module that turns "a folder appeared in `~/.ru-code/plugins/`"
 * into a running server plugin, and the ONE place that knows a plugin's state.
 * Three consumers read it and must all see the SAME instance: the boot phase
 * (`serverRuntimeStartup.ts`, which calls `start`), the HTTP asset route
 * (`httpRoutes.ts`, which serves `manifests.json` and the plugin's web files),
 * and — from A5 — the `plugin.invoke` / `plugin.list` ws handlers. Hence a
 * module-level `PluginHostLayer` (MODULE-LEVEL on purpose): layer
 * memoization makes every `Layer.provide(PluginHostLayer)` in one graph resolve
 * to a single host. A second instance would have an empty status table and every
 * plugin URL would 404.
 *
 * FAILURE POSTURE (guardrail 8), the whole point of this module. Each plugin is
 * activated in five steps — import, shape-check, open storage, migrate, activate
 * — and EVERY step is caught per plugin. Whatever goes wrong, the outcome is a
 * `PluginStatus` row, never a thrown startup. Concretely:
 *   - unreadable / malformed / mis-identified manifest  ⇒ `skipped` + reason;
 *   - entry that throws on import, a default export that is not a definition,
 *     a failing migration, an `activate` that throws or rejects ⇒ `failed` +
 *     message, and the NEXT plugin still loads;
 *   - a manifest with only `web` ⇒ `loaded`, `hasServer: false` (nothing to run
 *     on the server, but the web half must still be told about it).
 *
 * WHY storage is opened before `activate` even when the plugin declares no
 * migrations: `host.storage` is a plain object on the host, so a plugin may call
 * `storage.query` on its very first line. Making the open lazy would mean either
 * a promise-returning proxy that can fail long after activation, or a plugin
 * whose first query fails for a reason it cannot see. Eager-at-activate makes
 * "this plugin's database could not be opened" a load failure with a message,
 * which is what an author can act on. The cost is one (empty) sqlite file per
 * server plugin.
 *
 * @module ru-code/plugins/PluginHost
 */
import {
  manifestEnabled,
  manifestEnabledIsMalformed,
  PluginRpcError,
  type PluginStatus,
  type WebManifestList,
} from "@smart-tools/plugin-sdk/contracts";
import type { PluginManifest } from "@smart-tools/plugin-sdk/contracts";
import type { PluginSettingsRow, PluginStateFrame, PluginStatePosition } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import type {
  PluginProject,
  ServerCtx,
  ServerPlugin,
  SessionSeam,
} from "@smart-tools/plugin-sdk/host";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { makePluginLogger, makeServerCtx } from "./ctx.ts";
import { makePluginStateHub } from "./state.ts";
import { describeNonJson, findNonJson } from "@smart-tools/plugin-sdk/state";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { pluginSkipReason, readPluginEnablement, writePluginSwitch } from "./disabled.ts";
import { loadPluginModule } from "./loader.ts";
import { sharedVersionDrift } from "./manifest.ts";
import { pluginDbPath, pluginsDir, pluginStateDir, resolveShippedPluginsDir } from "./paths.ts";
import { scanPluginsDir } from "./scan.ts";
import { makePluginStorage, openPluginSqlClient, runPluginMigrations } from "./storage.ts";

/**
 * A plugin's `activate()` rejecting or throwing. Tagged so the failure stays
 * typed inside the host instead of an `unknown` in the error channel.
 */
class PluginActivateError extends Schema.TaggedErrorClass<PluginActivateError>()(
  "PluginActivateError",
  { pluginId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} activate() failed`;
  }
}

/**
 * What a `Cause` is allowed to say in `PluginStatus.error` (A7 finding L4).
 *
 * `PluginStatus.error` is served by `GET /plugins/manifests.json` — UNAUTHENTICATED, with
 * `access-control-allow-origin: *` (A4 finding L7) — so it must never carry a stack trace or
 * a host filesystem path. `Cause.pretty` renders exactly those, so it stays in the server
 * LOG; the status gets the failure's own message (a defect's `String()`, first line only,
 * since a rendered object can run to many lines).
 *
 * Exported for its test: the branch that needs it is practically unreachable at runtime,
 * which is precisely why the disclosure posture has to be pinned somewhere.
 */
export const statusErrorFromCause = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  const message = squashed instanceof Error ? squashed.message : String(squashed);
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  return firstLine === "" ? "plugin activation failed" : firstLine;
};

/**
 * ru-code (A13, A12 finding R1-M2): what `PluginStatus.error` is allowed to disclose.
 *
 * `GET /plugins/manifests.json` is UNAUTHENTICATED and answers `access-control-allow-origin: *`
 * (A4 finding L7, `httpRoutes.ts:59-66`), so every string that reaches a status row is readable by
 * any origin the user's browser visits. A7's L4 fix set that rule but wired it only into the
 * `Cause` branch ({@link statusErrorFromCause}); the ORDINARY branches passed Node's own message
 * through, and Node's module errors are made of absolute paths:
 *
 *   "failed to import server/index.mjs: Cannot find module
 *    '/home/<user>/.ru-code/plugins/notes/server/nope.mjs' imported from /home/<user>/…"
 *
 * — the OS username and the install layout, handed out for free. So one function guards the field:
 * first line only (a rendered object runs to many), then every absolute path replaced. A path
 * under the plugins directory keeps its plugin-relative tail (`<plugin>/notes/server/nope.mjs`),
 * which is the part an author can act on; anything else becomes `<path>`.
 *
 * The FULL text still goes to the operator's server log, exactly as `statusErrorFromCause` already
 * does for the defect branch — this only narrows what crosses the network.
 *
 * ru-code (A13 round 2, A12 finding R2-M1): ERASE THE ROOTS YOU KNOW, then sweep the residue.
 *
 * The first version tried to RECOGNISE a path with one regex, and the regex was ASCII-only
 * (`\w` without the `u` flag is `[A-Za-z0-9_]`) with no space in its class. So it stopped at the
 * first segment containing anything else and — because its lookbehind then blocked every later
 * separator in the same string — served the REST of the path verbatim. The two default install
 * shapes are exactly the ones it could not read:
 *
 *   C:\Users\John Smith\AppData\ru-code\plugins\…   → `<plugin> Smith\AppData\ru-code\plugins\…`
 *   /Users/z/Library/Application Support/ru-code/…  → `<plugin> Support/ru-code/plugins/…`
 *   /home/Захар/.ru-code/plugins/…                  → `<plugin>Захар<plugin>`
 *
 * So the order is inverted. The host KNOWS its own roots — the plugins dir, the state dir, the
 * base dir, the user's home and the process cwd — and a plain string replacement of those cannot
 * be defeated by an alphabet. They are applied LONGEST FIRST, because they nest (the plugins dir
 * lives under the base dir, which usually lives under home), so the most specific token wins and
 * the plugin-relative tail of a path inside the plugins dir still survives — that tail is the part
 * an author can act on. Only what is left over meets a regex, and that one is Unicode-aware
 * (`\p{L}` with `u`), allows spaces, and is deliberately blunt: two or more separated segments
 * become `<path>`, whatever they are spelled with.
 *
 * A root shorter than two characters, or a bare separator, is ignored: `process.cwd() === "/"`
 * must not turn every slash in the message into a token.
 */

/** The roots this host can name, so they never have to be recognised. */
export interface PluginPathRoots {
  /** `<baseDir>/plugins` — a path inside it keeps its plugin-relative tail. */
  readonly pluginsRoot?: string;
  /**
   * v2 (V2-21): the SHIPPED root inside the version payload, when this build has one.
   *
   * It needs its own token for exactly the reason the others do. In a real install it is
   * `<baseDir>/bin/versions/<v>/plugins`, so `<base>` would erase most of it — but in a dev run
   * and in the desktop artifact it is an arbitrary absolute path that no other token covers, and
   * `PluginStatus.error` is served by `GET /plugins/manifests.json` unauthenticated (A12 finding
   * R1-M2). Listed first so the longest-first sort keeps it ahead of `<base>`.
   */
  readonly shippedPluginsRoot?: string;
  readonly stateDir?: string;
  readonly baseDir?: string;
  /**
   * ru-code (A16): the CLI's config dir, now that the host HANDS it to plugins
   * (`host.paths.cliConfigDir`, SDK 0.2.0).
   *
   * It has to be here for the same reason the other three are. `PluginStatus.error` is served by
   * `GET /plugins/manifests.json`, unauthenticated and with `access-control-allow-origin: *`
   * (A12 finding R1-M2), and a plugin that scans `<cliConfigDir>/projects` will sooner or later
   * put that path into a message the host relays verbatim — `ENOENT: … /home/<user>/.qwen/projects`.
   * Giving a plugin a path it did not have to guess must not also give every origin the user's
   * home directory.
   */
  readonly cliConfigDir?: string;
}

/**
 * ru-code (A22): `host.paths.dataDir` needs no root of its own.
 *
 * It is `<stateDir>/plugins/<id>/`, and `stateDir` is already in this table — the roots are
 * applied LONGEST FIRST and a plain string replacement of an ancestor covers every descendant, so
 * `<stateDir>/plugins/catalogs/skill-catalog/x/meta.json` sanitizes to
 * `<state>/plugins/catalogs/skill-catalog/x/meta.json` with the user's home already gone. Adding a
 * `<data>` token would only rename the same erasure. `PluginHost.test.ts` pins this rather than
 * leaving it as a claim, because the field is new and the status row it protects is served
 * unauthenticated (A12 finding R1-M2).
 */

/** A path-shaped run of two or more segments, in any alphabet. See the doc above. */
const RESIDUAL_PATH =
  /(?<![\p{L}\p{N}_:>])(?:[A-Za-z]:)?[\\/](?:[\p{L}\p{N}_.@~%+ -]+[\\/])+[\p{L}\p{N}_.@~%+ -]*/gu;

/** `os.homedir()` throws on a host with no home; a sanitizer must never be the thing that fails. */
const safely = (read: () => string): string | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const rootTokens = (roots: PluginPathRoots | undefined): ReadonlyArray<[string, string]> =>
  (
    [
      [roots?.pluginsRoot, "<plugin>"],
      [roots?.shippedPluginsRoot, "<shipped>"],
      [roots?.stateDir, "<state>"],
      [roots?.baseDir, "<base>"],
      [roots?.cliConfigDir, "<cli-config>"],
      [safely(() => NodeOS.homedir()), "<home>"],
      [safely(() => process.cwd()), "<cwd>"],
    ] satisfies ReadonlyArray<[string | undefined, string]>
  )
    .filter((entry): entry is [string, string] => {
      const root = entry[0];
      return (
        root !== undefined && root.length > 1 && root !== "/" && !/^[A-Za-z]:[\\/]?$/.test(root)
      );
    })
    // Longest first: the roots NEST, so the most specific one has to claim its prefix before a
    // shorter ancestor swallows it (`<home>/.ru-code/plugins/x` must read `<plugin>/x`).
    .sort((left, right) => right[0].length - left[0].length);

export const sanitizeStatusError = (message: string, roots?: PluginPathRoots): string => {
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") return "plugin failed to load";
  let sanitized = firstLine;
  for (const [root, token] of rootTokens(roots)) {
    sanitized = sanitized.split(root).join(token);
  }
  return sanitized.replace(RESIDUAL_PATH, (match) => {
    // Segments may contain spaces, so a match can end in the whitespace before the next word
    // (`… (ENOENT)`); give that whitespace back rather than gluing the token to what follows.
    const trimmed = match.replace(/\s+$/u, "");
    return `<path>${match.slice(trimmed.length)}`;
  });
};

const describeError = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : (() => {
          try {
            return JSON.stringify(cause) ?? String(cause);
          } catch {
            return String(cause);
          }
        })();

/**
 * ru-code v2 (decision V2-7): the structured `data` a plugin's thrown error may carry.
 *
 * v1 gave a plugin one host-owned `reason` and a free-text `detail`, so every non-trivial plugin
 * encoded its own failure kind into `Error.message` and parsed it back on the other side (two
 * ~90-line `failure.ts` files did exactly that, in two plugins). A handler may now throw
 * `Object.assign(new Error("…"), { data: { kind: "quota-exceeded" } })` and the payload reaches
 * the web half untouched.
 *
 * Only a JSON value is taken — by the SAME rule the success channel is held to (S37, rule 37).
 * `data` rides the same `Schema.Unknown` field, so a `Map`, a `BigInt`, a cycle or one key holding
 * `undefined` would fail inside effect's RPC encoder AFTER the handler's side effects already ran,
 * and the plugin would get an untyped defect instead of the error it threw. It costs the FIELD:
 * the plugin still gets its `reason` and its `detail`.
 *
 * It used to be `JSON.parse(JSON.stringify(data))`, which is not the wire's rule: it turns a `NaN`
 * into `null` and drops an `undefined` key, so a payload the plugin's two halves disagree about
 * arrived looking fine. One walk, the same predicate, and the field is either exactly what the
 * handler attached or absent.
 */
const structuredErrorData = (cause: unknown): { readonly data?: unknown } => {
  if (typeof cause !== "object" || cause === null) return {};
  const data = (cause as { readonly data?: unknown }).data;
  if (data === undefined) return {};
  return findNonJson(data, "data") === null ? { data } : {};
};

/**
 * Accept both shapes a server entry may default-export.
 *
 * `defineServerPlugin({ migrations, rpc, session, activate })` is the documented form. A bare
 * FUNCTION is also accepted as `activate`: it is the smallest possible plugin (the pack-gate
 * fixtures are exactly that) and refusing it would make the simplest hello-world the one shape
 * that does not work.
 *
 * v2 (V2-2): there is no required member any more. A plugin that only exports `rpc`, or only
 * `migrations`, is a whole plugin — so the only thing rejected here is a default export that is
 * neither a function nor an object, which is what `export default 42` or a missing default is.
 * Each seam is narrowed to the shape the host will actually call, so a plugin that exports
 * `rpc: "yes"` loses that seam instead of crashing the host on the first invoke.
 */
export const normalizeServerPlugin = (value: unknown): ServerPlugin | null => {
  if (typeof value === "function")
    return { activate: value as NonNullable<ServerPlugin["activate"]> };
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const plugin: {
    migrations?: NonNullable<ServerPlugin["migrations"]>;
    rpc?: NonNullable<ServerPlugin["rpc"]>;
    session?: SessionSeam;
    activate?: NonNullable<ServerPlugin["activate"]>;
    deactivate?: NonNullable<ServerPlugin["deactivate"]>;
  } = {};
  const isObject = (v: unknown): boolean => typeof v === "object" && v !== null;
  if (Array.isArray(candidate["migrations"])) {
    plugin.migrations = candidate["migrations"] as NonNullable<ServerPlugin["migrations"]>;
  }
  if (isObject(candidate["rpc"])) plugin.rpc = candidate["rpc"] as NonNullable<ServerPlugin["rpc"]>;
  if (isObject(candidate["session"])) plugin.session = candidate["session"] as SessionSeam;
  if (typeof candidate["activate"] === "function") {
    plugin.activate = candidate["activate"] as NonNullable<ServerPlugin["activate"]>;
  }
  if (typeof candidate["deactivate"] === "function") {
    plugin.deactivate = candidate["deactivate"] as NonNullable<ServerPlugin["deactivate"]>;
  }
  return plugin;
};

/**
 * ru-code (A5, A4 finding H1): the wall-clock budget for ONE plugin lifecycle
 * step — import, migrations, activate.
 *
 * WHY this exists. Guardrail 8 says the host never dies because of a plugin, and
 * every step below was already caught per plugin — but a `catch` only helps a
 * step that FINISHES. A4 reproduced the other half: a server plugin whose
 * `activate()` returns a promise that never settles blocked boot completely —
 * no `server-runtime.json` sentinel, `/healthz` never answered, `ru-code start`
 * gave up with «Демон не запустился вовремя», and an orphan node process kept
 * the port. Recovery meant deleting the folder from a shell, because the app
 * could not start far enough to say why. A hang is at least as likely as a throw
 * in real plugin code (an `await fetch(...)` to a dead endpoint, an unreleased
 * lock), so it gets the same posture as a throw: that plugin `failed`, boot
 * continues.
 *
 * 15 s and not less: a first-run migration over a cold sqlite file on a slow
 * disk is legitimately slow, and a false timeout would disable a working plugin.
 * 15 s and not more: three steps at 15 s is the worst case one bad plugin can
 * add to boot, and the launcher's own start deadline is well beyond that.
 *
 * The timed-out promise itself cannot be cancelled (that is Node, not Effect) —
 * interrupting the fiber only stops the host WAITING on it. That is the whole
 * requirement: the status table gets its row and the scan moves on.
 */
const PLUGIN_STEP_TIMEOUT = Duration.seconds(15);
const PLUGIN_STEP_TIMEOUT_LABEL = "15s";

/**
 * Run one lifecycle step under the budget above.
 *
 * `Effect.result` INSIDE the timeout so a step's own typed failure stays a
 * `Result` and only the timeout produces `Option.none` — the caller then tells a
 * plugin that failed from a plugin that hung, and reports each differently.
 */
const timedStep = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<Result.Result<A, E>>, never, R> =>
  Effect.result(effect).pipe(Effect.timeoutOption(PLUGIN_STEP_TIMEOUT));

const statusFor = (input: {
  readonly manifest: PluginManifest;
  readonly state: PluginStatus["state"];
  readonly error?: string;
  /** Every root the host can name, so `sanitizeStatusError` erases rather than guesses (R2-M1). */
  readonly roots?: PluginPathRoots;
}): PluginStatus => {
  // ru-code (A9 finding LOW-3): `hasWeb` / `web` / `styles` describe what the
  // browser can actually FETCH, not what the manifest claims. `resolvePluginDir`
  // serves `loaded` plugins only, so for any other state those three fields were
  // a promise the asset route does not keep — it 404s every one of them. One
  // state, one answer (the `resolvePluginDir` posture, A4 finding L1).
  const reachable = input.state === "loaded";
  const web = reachable ? input.manifest.web : undefined;
  const styles = reachable ? input.manifest.styles : undefined;
  return {
    id: input.manifest.id,
    // VERBATIM, one string or `{ en, ru }` (S38 step 11). The server does not know the app's
    // language — the locale is a browser fact — so what the author wrote goes on the wire and the
    // WEB resolves it once, in the loader.
    name: input.manifest.name,
    version: input.manifest.version,
    state: input.state,
    hasWeb: web !== undefined,
    hasServer: input.manifest.server !== undefined,
    // ru-code (A5, A4 finding M3): the web loader used to hard-code `web/index.mjs`
    // because the status carried only `hasWeb`. Both `web` and `styles` are
    // manifest-relative and are joined onto `/plugins/<id>/` by the browser.
    ...(web === undefined ? {} : { web }),
    ...(styles === undefined ? {} : { styles }),
    // ru-code (A13, A12 finding R1-M2): EVERY error string that leaves this function is
    // sanitized, whichever branch built it — there is no path into `PluginStatus.error` that
    // skips this line.
    ...(input.error === undefined ? {} : { error: sanitizeStatusError(input.error, input.roots) }),
    // Optional and verbatim, like `name`. Absent means the author said nothing, and the app draws
    // nothing — never a placeholder.
    ...(input.manifest.description === undefined
      ? {}
      : { description: input.manifest.description }),
  };
};

/**
 * v2 (V2-21): one log line for a plugin folder that lost an id collision.
 *
 * The ONLY channel this has. `manifests.json` is keyed by id and carries the winner, and there is
 * no plugins settings surface to raise a toast on (D-e: log-only for now). Both directories are
 * named, unsanitized, because this is the operator's log — not `PluginStatus.error`, which is
 * served unauthenticated. Nothing is deleted: the shadowed folder stays exactly where its owner
 * put it (D11).
 */
const shadowed = (
  id: string,
  dir: string,
  claimedFrom: ReadonlyMap<string, string>,
): Effect.Effect<void> =>
  Effect.logWarning("ru-code plugins: shadowed by the shipped copy", {
    id,
    loadedFrom: claimedFrom.get(id),
    ignored: dir,
  });

/** The one plugin service. See the module doc for why it is module-level. */
export class PluginHost extends Context.Service<
  PluginHost,
  {
    /**
     * Scan the plugins directory and activate every server plugin found.
     *
     * Idempotent: a second call logs a warning and does nothing (hot re-scan is
     * backlog — the drop-in contract is "copy the folder, restart").
     */
    readonly start: Effect.Effect<void>;

    /** Every scanned plugin with its outcome, in directory order. */
    readonly list: Effect.Effect<ReadonlyArray<PluginStatus>>;

    /** ru-code S38 (V2-43): `list` plus root, saved switch and running switch — the Settings rows. */
    readonly settings: Effect.Effect<ReadonlyArray<PluginSettingsRow>>;

    /** ru-code S38 (V2-43): record the user's switch for one plugin; answers with the fresh rows. */
    readonly setEnabled: (
      pluginId: string,
      enabled: boolean,
    ) => Effect.Effect<ReadonlyArray<PluginSettingsRow>, PluginRpcError>;

    /** What `GET /plugins/manifests.json` serves to the web bootstrap. */
    readonly manifestsForWeb: Effect.Effect<WebManifestList>;

    /** Call a method a plugin exported under its `rpc` seam. */
    readonly invoke: (
      pluginId: string,
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, PluginRpcError>;

    /**
     * Absolute folder of a `loaded` plugin, else `undefined`.
     *
     * The asset route serves ONLY from a folder this returns, so an unknown,
     * skipped or failed id can never be turned into a filesystem path.
     */
    readonly resolvePluginDir: (pluginId: string) => Effect.Effect<string | undefined>;

    /**
     * ru-code v2 (decision V2-5): the `session` seam of every `loaded` plugin that exports one, in
     * load order, each with the ctx its calls take.
     *
     * The consumer is `SessionRespawnGate`, on the spawn path. A plain synchronous read because
     * the gate runs per turn and must not pay for a service call to find out there are no seams —
     * which is the case on every install with no such plugin.
     *
     * A plugin that is not `loaded` never appears here: a plugin whose `activate` threw, or one
     * that was skipped, must not keep running on the user's critical path.
     */
    readonly sessions: Effect.Effect<
      ReadonlyArray<{
        readonly pluginId: string;
        readonly session: SessionSeam;
        readonly ctx: ServerCtx;
      }>
    >;

    /**
     * ru-code S69 (V2-58): one subscriber's `plugin.state` stream — the snapshot of every plugin's
     * current values, then every change. Every plugin's names on one stream, because a tab hosts
     * every plugin: the web host routes each value to that plugin's own cell, and no plugin can read
     * another's (`apps/web/src/ru-code/plugins/state.ts`). See `state.ts`.
     */
    readonly stateFrames: Stream.Stream<PluginStateFrame>;

    /**
     * ru-code S104 (V2-73): where the state hub stands — this process's `boot` and the count of
     * changes it accepted. `plugin.invoke` reads it when a handler returns, so the web host can
     * resolve a command only once its tab holds everything published before the answer.
     */
    readonly statePosition: Effect.Effect<PluginStatePosition>;

    /** How many tabs hold a `plugin.state` stream right now. Diagnostics and specs. */
    readonly stateSubscriberCount: Effect.Effect<number>;
  }
>()("t3/ru-code/plugins/PluginHost") {}

/**
 * One projection row as a plugin sees it (V2-15).
 *
 * Exported because it is the whole of the claim `ServerCtx.projects.list()` makes, and the unit
 * tier can exercise a pure function without standing up a read model: `name` is the project's own
 * TITLE, not `basename(cwd)` — the derivation the catalogs port had to use, which showed the folder
 * for every renamed project (catalogs Host/SDK request R3).
 */
export const toPluginProject = (row: {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}): PluginProject => ({ id: row.projectId, name: row.title, cwd: row.workspaceRoot });

const make = Effect.gen(function* () {
  // The layer's own scope: every plugin database is closed when the server stops.
  const hostScope = yield* Effect.scope;
  // Captured ONCE: the plugin boundary is promise-shaped (D6), so every effect a
  // plugin triggers — a log line, a storage query — has to be executed on the
  // server's own runtime rather than yielded. The same services also make `start`
  // self-contained, so the service surface is plain `Effect<…, never, never>`.
  const runtimeContext = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runFork = Effect.runForkWith(runtimeContext);
  const runPromise = Effect.runPromiseWith(runtimeContext);
  /**
   * ru-code S69 (V2-58): the state hub — every plugin's last published values, one per host, and
   * every tab's `plugin.state` stream.
   *
   * Its `report` is the SERVER's half of the V2-42 channel: the host talking ABOUT a plugin, one
   * line per `(pluginId, code)` (the hub de-duplicates), at WARNING because it names a call the
   * plugin made that the host refused. It is not a toast and not a status row — a server plugin's
   * author reads `<stateDir>/logs/server.log`, and the app's user is not the audience for either.
   */
  const stateHub = makePluginStateHub({
    report: ({ pluginId, code, message }) => {
      runFork(
        Effect.logWarning("ru-code plugins: publish refused", { plugin: pluginId, code, message }),
      );
    },
    // S104 (V2-73): one per host, i.e. per server process — a restart is a new name, which is how a
    // tab tells a count that started again from one that went backwards.
    boot: NodeCrypto.randomUUID(),
  });
  const path = yield* Path.Path;
  const rootDir = yield* pluginsDir;
  // v2 (V2-20/V2-21): the SHIPPED root, inside the version payload — `undefined` when this build
  // carries none, which is a normal answer (see `resolveShippedPluginsDir`). Resolved ONCE here,
  // beside `rootDir`, so `start` has both roots in hand and nothing downstream re-derives either.
  const shippedRootDir = yield* resolveShippedPluginsDir;
  // ru-code (A13 round 2, A12 finding R2-M1): the roots `sanitizeStatusError` erases by name.
  // Captured once here, where the config is already in hand, so no status branch can be built
  // without them.
  const serverConfig = yield* ServerConfig.ServerConfig;
  // ru-code (A16): `cliConfigDir` is a plain string on the config plus a separate `cliDetected`
  // flag; folded here into the one nullable value the SDK's `host.paths.cliConfigDir` promises.
  const cliConfigDir = serverConfig.cliDetected ? serverConfig.cliConfigDir : null;
  const pathRoots: PluginPathRoots = {
    pluginsRoot: rootDir,
    ...(shippedRootDir === undefined ? {} : { shippedPluginsRoot: shippedRootDir }),
    stateDir: serverConfig.stateDir,
    baseDir: serverConfig.baseDir,
    // Only when it is real: `sanitizeStatusError` ignores short/empty roots anyway, but an
    // undetected CLI has no path to erase and should not add a token to the table.
    ...(cliConfigDir === null ? {} : { cliConfigDir }),
  };

  // Plain Maps, not Refs, on purpose: everything here is written on the boot fiber and read
  // afterwards. v2 replaced three registration tables with ONE — the loaded plugin and the ctx its
  // seams are called with — because a plugin no longer registers anything: the host reads
  // `plugin.rpc` / `plugin.session` off the object it imported (V2-2).
  const statuses = new Map<string, PluginStatus>();
  /** Which root each scanned id came from, for the Settings row (V2-43). */
  const roots = new Map<string, "shipped" | "user">();
  /**
   * Whether each scanned id was ENABLED in THIS process — what the running server decided at boot.
   *
   * The Settings switch writes the file, and the file is the answer from the next boot; until then
   * this is the other half of the comparison the "restart to apply" line is made of.
   */
  const runningEnabled = new Map<string, boolean>();
  const directories = new Map<string, string>();
  const loaded = new Map<string, { readonly plugin: ServerPlugin; readonly ctx: ServerCtx }>();
  let started = false;

  // ru-code (A22, O2-a; V2-15): the app's project read model, narrowed to `{ id, name, cwd }`.
  //
  // `ProjectionProjectRepositoryLive` is provided ONTO this layer below rather than required of
  // every caller, the self-provisioning idiom the app's own host layers use: the plugin host is
  // provided from three places (`server.ts`, `ws.ts`, the tests) and widening
  // its requirement list would make every one of them name a service no plugin can see anyway.
  const projectRepo = yield* ProjectionProjectRepository;

  /**
   * `{ id, name, cwd }` for every LIVE project. Soft-deleted rows are dropped HERE, at the seam, so
   * no plugin can be handed a project the user removed — the same filter the compiled-in catalog
   * layers applied before A25 moved them into `@smart-tools/plugin-catalogs`.
   *
   * `name` is the project's TITLE (V2-15, closing catalogs R3): the row already carries it, and a
   * port that had to derive a label from `basename(cwd)` showed the folder for a renamed project.
   */
  const liveProjects = (
    repo: ProjectionProjectRepositoryShape,
  ): Effect.Effect<ReadonlyArray<PluginProject>> =>
    repo.listAll().pipe(
      Effect.map((rows) => rows.filter((row) => row.deletedAt === null).map(toPluginProject)),
      // A read failure is an EMPTY list, never a rejection: `host.projects` is promise-shaped and
      // a plugin that has to try/catch "which projects exist" will not, so the honest degraded
      // answer is "none I can see" — which for a catalog plugin means global-only, exactly what a
      // fresh install looks like. The operator sees the cause in the log.
      Effect.catchCause((cause) =>
        Effect.logError("ru-code plugins: host.projects.listLive failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<PluginProject>)),
      ),
    );

  // v2 (architecture.md §2.2): ONE method, `{ id, name, cwd }` rows. A plugin that needs one
  // project's cwd filters the list; a second lookup method bought nothing but a second failure mode.
  const pluginProjects = { list: () => runPromise(liveProjects(projectRepo)) };

  /** Run one server plugin's activation steps; never fails. */
  const activateServerPlugin = (entry: {
    readonly dir: string;
    readonly manifest: PluginManifest;
    readonly serverEntry: string;
  }): Effect.Effect<
    PluginStatus,
    never,
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  > =>
    Effect.gen(function* () {
      const { dir, manifest } = entry;
      const failed = (error: string) =>
        statusFor({ manifest, state: "failed", error, roots: pathRoots });

      const entryPath = path.join(dir, entry.serverEntry);
      const imported = yield* timedStep(loadPluginModule(entryPath));
      if (Option.isNone(imported)) {
        return failed(
          `import of ${entry.serverEntry} timed out after ${PLUGIN_STEP_TIMEOUT_LABEL}`,
        );
      }
      const module_ = imported.value;
      if (Result.isFailure(module_)) {
        return failed(
          `failed to import ${entry.serverEntry}: ${describeError(module_.failure.cause)}`,
        );
      }

      const plugin = normalizeServerPlugin(module_.success);
      if (plugin === null) {
        return failed(
          `${entry.serverEntry} default export is not a plugin (expected defineServerPlugin({ … }) or a function)`,
        );
      }

      const dbPath = yield* pluginDbPath(manifest.id);
      const opened = yield* Effect.result(
        openPluginSqlClient({ id: manifest.id, dbPath }).pipe(Scope.provide(hostScope)),
      );
      if (Result.isFailure(opened)) {
        return failed(`failed to open plugin database: ${describeError(opened.failure)}`);
      }
      const sql = opened.success;

      // `runPluginMigrations` cannot fail (it encodes failure in its outcome), so this step needs
      // the budget but not the `Result` half of `timedStep`.
      const migrationRun = yield* runPluginMigrations(sql, plugin.migrations ?? []).pipe(
        Effect.timeoutOption(PLUGIN_STEP_TIMEOUT),
      );
      if (Option.isNone(migrationRun)) {
        return failed(`migrations timed out after ${PLUGIN_STEP_TIMEOUT_LABEL}`);
      }
      const migrated = migrationRun.value;
      if (!migrated.ok) return failed(`migration "${migrated.failedId}" failed: ${migrated.error}`);
      if (migrated.applied.length > 0) {
        yield* Effect.logInfo("ru-code plugins: applied migrations", {
          id: manifest.id,
          migrations: migrated.applied,
        });
      }

      const ctx = makeServerCtx({
        id: manifest.id,
        log: makePluginLogger({ id: manifest.id, runFork }),
        storage: makePluginStorage({ sql, run: runPromise }),
        // The plugin's own folder — the parent of the `data.sqlite` opened above, so the two can
        // never name different directories.
        paths: { dataDir: yield* pluginStateDir(manifest.id), cliConfigDir },
        projects: pluginProjects,
        // V2-58: bound to THIS plugin's id, like everything else on the ctx — there is no argument
        // a plugin can pass to publish under another's name.
        publish: (name: string, value: unknown) => {
          stateHub.publish(manifest.id, name, value);
        },
      });

      // `activate` is OPTIONAL in v2 (V2-2): a plugin that only exports `rpc` needs no lifecycle.
      if (plugin.activate !== undefined) {
        const activate = plugin.activate.bind(plugin);
        const activateRun = yield* timedStep(
          Effect.tryPromise({
            // The call is inside the async body so a SYNCHRONOUS throw in `activate` becomes a
            // rejected promise instead of escaping here.
            try: async () => {
              await activate(ctx);
            },
            catch: (cause) => new PluginActivateError({ pluginId: manifest.id, cause }),
          }),
        );
        if (Option.isNone(activateRun)) {
          return failed(`activate timed out after ${PLUGIN_STEP_TIMEOUT_LABEL}`);
        }
        if (Result.isFailure(activateRun.value)) {
          return failed(`activate() failed: ${describeError(activateRun.value.failure.cause)}`);
        }
      }

      // Only a plugin that got this far is reachable: `invoke` and `sessions` both read this table,
      // and a plugin whose activate threw must not keep answering RPCs or running on the spawn path.
      loaded.set(manifest.id, { plugin, ctx });

      // `deactivate` on the host's own scope, so it runs when the server stops and is subject to
      // the same budget and the same "a plugin may not take the host down" rule as everything else.
      if (plugin.deactivate !== undefined) {
        const deactivate = plugin.deactivate.bind(plugin);
        yield* Scope.addFinalizer(
          hostScope,
          Effect.promise(async () => {
            await deactivate(ctx);
          }).pipe(
            Effect.timeoutOption(PLUGIN_STEP_TIMEOUT),
            Effect.catchCause((cause) =>
              Effect.logWarning("ru-code plugins: deactivate() failed", {
                id: manifest.id,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.asVoid,
          ),
        );
      }

      return statusFor({ manifest, state: "loaded", roots: pathRoots });
    }).pipe(
      // This branch is practically unreachable (every step above is already caught), but what
      // reaches it is a `Cause` — a defect or an interrupt — and `Cause.pretty` renders STACK
      // FRAMES and absolute paths into a field `GET /plugins/manifests.json` serves
      // UNAUTHENTICATED. So: the pretty cause goes to the operator's LOG, the status carries the
      // message alone.
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("ru-code plugins: activation defect", {
            id: entry.manifest.id,
            cause: Cause.pretty(cause),
          });
          return statusFor({
            manifest: entry.manifest,
            state: "failed",
            error: statusErrorFromCause(cause),
            roots: pathRoots,
          });
        }),
      ),
      Effect.withSpan("plugins.activateServerPlugin", { attributes: { id: entry.manifest.id } }),
    );

  /**
   * The roots `start` scans, in precedence order: SHIPPED first, then the user's.
   *
   * v2 (V2-21). Order is the whole precedence rule — the first root to claim an id keeps it — so
   * it is expressed here once rather than as a branch inside the loop. `scanPluginsDir` sorts each
   * root's entries by folder name, so `manifests.json` order stays deterministic
   * (`registry.ts:24,37` depends on it): every shipped plugin, name-sorted, then every user
   * plugin, name-sorted.
   *
   * The two roots are de-duplicated by resolved path, because `RU_CODE_SHIPPED_PLUGINS_DIR` and
   * `RU_CODE_PLUGINS_DIR` are both test-only overrides and a run that points them at the same
   * fixture must scan it ONCE — otherwise every plugin in it would report itself as its own
   * shadow.
   */
  const scanRoots: ReadonlyArray<{ readonly kind: "shipped" | "user"; readonly dir: string }> = [
    ...(shippedRootDir === undefined || path.resolve(shippedRootDir) === path.resolve(rootDir)
      ? []
      : [{ kind: "shipped", dir: shippedRootDir } as const]),
    { kind: "user", dir: rootDir } as const,
  ];

  const start = Effect.gen(function* () {
    if (started) {
      yield* Effect.logWarning("ru-code plugins: start() called twice, ignoring");
      return;
    }
    started = true;

    /** Which root each id was claimed from, for the collision log line. */
    const claimedFrom = new Map<string, string>();
    // v2 (V2-21): read ONCE, before any root is walked. The list lives in `<stateDir>`, which
    // neither release channel writes, so it outlives every install, update and rollback. V2-43: it
    // now answers "on" as well as "off", and it is the user's answer either way.
    const switches = yield* readPluginEnablement;

    for (const root of scanRoots) {
      const entries = yield* scanPluginsDir(root.dir);
      for (const entry of entries) {
        // D8 makes the folder name the id for every entry that decoded, and it is the only id a
        // REFUSED folder has — so both the collision rule and the opt-out key on it, and neither
        // has to trust a `plugin.json` first.
        const folderId = path.basename(entry.dir);

        // v2 (V2-21): ONE id, ONE row, ONE loaded plugin. The shipped set replaced app features,
        // so it wins; the user's folder is left exactly where it is (D11 — the host never deletes
        // a user's folder) and the collision is a log line, not a second `manifests.json` row —
        // that table is keyed by id, and a synthetic id would make the web loader fetch
        // `/plugins/<synthetic>/web/index.mjs`. Whatever state the shipped entry reached — loaded,
        // failed, skipped or disabled — is the state that stands: "shipped wins" is a rule about
        // WHICH copy is the app's, not about which copy happens to work today, and a silent
        // fallback to a stale user copy is precisely the invisible shadow this ordering prevents.
        if (claimedFrom.has(folderId)) {
          yield* shadowed(folderId, entry.dir, claimedFrom);
          continue;
        }

        // v2 (V2-21, V2-43): the switch, checked BEFORE anything inside the folder runs — no
        // `import()`, no storage open, no migration. A disabled plugin is inert, not merely hidden,
        // and it makes no difference whether the user switched it off or the manifest shipped it
        // off: the row carries which, and nothing runs either way.
        //
        // A REFUSED folder has no manifest to read a switch out of, so it counts as manifest-on —
        // it will be skipped one branch below for the reason it was refused, which is the reason
        // worth showing.
        const enabledByManifest = entry.ok ? manifestEnabled(entry.manifest) : true;
        if (entry.ok && manifestEnabledIsMalformed(entry.manifest)) {
          yield* Effect.logDebug(
            "ru-code plugins: `enabled` in plugin.json is not a boolean, reading it as true",
            { id: folderId, dir: entry.dir, enabled: entry.manifest.enabled },
          );
        }
        roots.set(folderId, root.kind);
        // Recorded for EVERY claimed folder, not only the ones that load: the Settings row names
        // the folder of a plugin that is skipped or failed too — that is the row a user is looking
        // at when they want to know which folder to look in. It does not widen what the asset
        // route serves: `resolvePluginDir` answers for `loaded` plugins only, and that guard is
        // the gate, not this map.
        directories.set(folderId, entry.dir);
        const skipReason = pluginSkipReason(switches, folderId, enabledByManifest);
        runningEnabled.set(folderId, skipReason === null);
        if (skipReason !== null) {
          statuses.set(
            folderId,
            entry.ok
              ? statusFor({
                  manifest: entry.manifest,
                  state: "skipped",
                  error: skipReason,
                })
              : {
                  id: folderId,
                  name: folderId,
                  version: "",
                  state: "skipped",
                  hasWeb: false,
                  hasServer: false,
                  error: skipReason,
                },
          );
          claimedFrom.set(folderId, entry.dir);
          yield* Effect.logInfo("ru-code plugins: skipped", {
            id: folderId,
            origin: root.kind,
            dir: entry.dir,
            reason: skipReason,
          });
          continue;
        }

        if (!entry.ok) {
          const status: PluginStatus = {
            id: folderId,
            name: folderId,
            version: "",
            state: "skipped",
            hasWeb: false,
            hasServer: false,
            // Same disclosure rule as every other status row (A13, A12 finding R1-M2): the
            // scanner's reasons are host-authored today, but this field is served unauthenticated
            // and must not depend on that staying true.
            error: sanitizeStatusError(entry.reason, pathRoots),
          };
          statuses.set(folderId, status);
          claimedFrom.set(folderId, entry.dir);
          yield* Effect.logWarning("ru-code plugins: skipped", {
            id: folderId,
            origin: root.kind,
            error: entry.reason,
          });
          continue;
        }

        const manifest = entry.manifest;
        directories.set(manifest.id, entry.dir);
        claimedFrom.set(manifest.id, entry.dir);

        // v2: a MAJOR mismatch already skipped the folder in `readPluginManifest`; what is left is
        // drift an operator should be able to see without reading the plugin's `plugin.json`.
        const drift = sharedVersionDrift(manifest.shared);
        if (drift.drifted.length > 0) {
          yield* Effect.logWarning("ru-code plugins: shared runtime drift", {
            id: manifest.id,
            drift: drift.drifted,
          });
        }

        if (manifest.server === undefined) {
          const status = statusFor({ manifest, state: "loaded", roots: pathRoots });
          statuses.set(manifest.id, status);
          yield* Effect.logInfo("ru-code plugins: loaded", {
            id: manifest.id,
            origin: root.kind,
            state: status.state,
            hasServer: false,
          });
          continue;
        }

        const status = yield* activateServerPlugin({
          dir: entry.dir,
          manifest,
          serverEntry: manifest.server,
        });
        statuses.set(manifest.id, status);
        if (status.state === "loaded") {
          yield* Effect.logInfo("ru-code plugins: loaded", {
            id: status.id,
            origin: root.kind,
            state: status.state,
            hasServer: true,
          });
        } else {
          yield* Effect.logWarning("ru-code plugins: failed", {
            id: status.id,
            origin: root.kind,
            state: status.state,
            error: status.error,
          });
        }
      }
    }

    yield* Effect.logDebug("ru-code plugins: scan complete", {
      dirs: scanRoots.map((root) => root.dir),
      total: statuses.size,
    });
  }).pipe(Effect.provide(runtimeContext), Effect.withSpan("plugins.start"));

  const list = Effect.sync((): ReadonlyArray<PluginStatus> => [...statuses.values()]);

  /**
   * ru-code S38 (V2-43): one row per scanned plugin, for the Settings ▸ Plugins section.
   *
   * It is `list` plus the three things a switch needs and a status row does not carry: which ROOT
   * the folder came from (a shipped plugin cannot be uninstalled by deleting it, which is the whole
   * reason the switch exists), what the SAVED file says now, and what THIS PROCESS decided at boot.
   * The page compares the last two to decide whether to show "restart the app to apply" — the host
   * does not decide it, because "is a restart needed" is a sentence, and sentences are the web's.
   *
   * The file is re-read on every call rather than cached: it is a few hundred bytes, it can be
   * hand-edited between two calls, and a settings page showing a stale switch would be the one
   * defect this surface must not have.
   */
  const settings = Effect.gen(function* () {
    const switches = yield* readPluginEnablement;
    return [...statuses.values()].map((status): PluginSettingsRow => {
      return {
        id: status.id,
        // The localized pair, verbatim — the page resolves it with the app's own locale.
        name: status.name,
        ...(status.description === undefined ? {} : { description: status.description }),
        version: status.version,
        root: roots.get(status.id) ?? "user",
        // The folder the row is ABOUT. A user who is deciding whether to switch a plugin off wants
        // to know which folder it is, and for a `user` plugin it is also the thing they would
        // delete instead. Absent only for an id the scan never claimed, which cannot reach here.
        ...(directories.get(status.id) === undefined
          ? {}
          : { dir: directories.get(status.id) as string }),
        state: status.state,
        ...(status.error === undefined ? {} : { error: status.error }),
        // The SAVED answer cannot read the manifest of a plugin the user never switched — the
        // manifest is on disk and the scan already read it, so `runningEnabled` carries that half
        // and an untouched plugin's saved answer is simply what is running.
        enabledSaved: switches.disabled.has(status.id)
          ? false
          : switches.enabled.has(status.id)
            ? true
            : (runningEnabled.get(status.id) ?? true),
        enabledRunning: runningEnabled.get(status.id) ?? true,
      };
    });
  }).pipe(Effect.provide(runtimeContext));

  /**
   * Record the user's switch for one plugin and answer with the fresh rows.
   *
   * The id must be one this host SCANNED: an unknown id is a typed `unknown-plugin` rather than a
   * silent write, because a settings page that accepted any string would let a typo put an inert
   * entry into a file a human reads.
   */
  const setEnabled = (
    pluginId: string,
    enabled: boolean,
  ): Effect.Effect<ReadonlyArray<PluginSettingsRow>, PluginRpcError> =>
    Effect.gen(function* () {
      if (!statuses.has(pluginId)) {
        return yield* new PluginRpcError({ reason: "unknown-plugin", detail: pluginId });
      }
      yield* writePluginSwitch(pluginId, enabled);
      return yield* settings;
    }).pipe(Effect.provide(runtimeContext));

  const invoke = (
    pluginId: string,
    method: string,
    payload: unknown,
  ): Effect.Effect<unknown, PluginRpcError> =>
    Effect.gen(function* () {
      const status = statuses.get(pluginId);
      if (status === undefined) {
        return yield* new PluginRpcError({ reason: "unknown-plugin", detail: pluginId });
      }
      if (status.state !== "loaded") {
        return yield* new PluginRpcError({
          reason: "plugin-disabled",
          detail: `${pluginId} is ${status.state}${status.error === undefined ? "" : `: ${status.error}`}`,
        });
      }
      const entry = loaded.get(pluginId);
      const handler = entry?.plugin.rpc?.[method];
      if (entry === undefined || typeof handler !== "function") {
        return yield* new PluginRpcError({
          reason: "unknown-method",
          detail: `${pluginId}.${method}`,
        });
      }
      const answer = yield* Effect.tryPromise({
        //  · `Promise.resolve(...)` — a handler that forgets `async` and returns a plain value used
        //    to surface `internalCall(...).then is not a function`, a minified host internal in the
        //    plugin author's error;
        //  · `?? null` — `undefined` is not a JSON value, so the wire schema rejected it AFTER the
        //    handler's side effects had already run. The most natural write-only handler is
        //    `async (p, ctx) => { await ctx.storage.exec("DELETE FROM notes") }` and it returns
        //    `undefined`. `null` is the JSON spelling of "nothing".
        try: async () => (await Promise.resolve(handler(payload, entry.ctx))) ?? null,
        catch: (cause) =>
          // v2 (V2-7): a handler may attach STRUCTURED `data` to its error, and it is forwarded
          // verbatim — that is what replaces the reason-encoded-into-a-message workaround every
          // non-trivial v1 plugin grew. Only a plain JSON value is taken; anything else is dropped
          // rather than risking an unencodable payload on the wire.
          new PluginRpcError({
            reason: "plugin-failed",
            detail: describeError(cause),
            ...structuredErrorData(cause),
          }),
      });

      // ru-code S37 (rule 37, "boundaries validate"): the ENGINE knows JSON and nothing else
      // about a plugin's data — and this is the last place that knowledge can be applied. One
      // step further and the value is inside effect's RPC encoder, where a non-JSON answer dies
      // as an untyped `Die` defect the web half cannot switch on (the S37 defect: the scan
      // SUCCEEDED, the board said «the server is not connected»). Checked for EVERY plugin, not
      // just the one that tripped: the host cannot know which plugin will produce one next, and
      // the cost is one walk of an answer that is about to be walked by the serializer anyway.
      //
      // DEBUG, not error or warning: a plugin bug is not an operator's incident, and the plugin
      // is told properly through the typed error below. The path is the whole point — effect's
      // own message can only ever say `["value"]`.
      const offending = findNonJson(answer);
      if (offending !== null) {
        yield* Effect.logDebug("ru-code plugins: invoke answer is not JSON", {
          pluginId,
          method,
          path: offending.path,
          found: describeNonJson(offending.found),
        });
        return yield* new PluginRpcError({
          reason: "invalid-answer",
          detail: `${pluginId}.${method} answered with ${describeNonJson(offending.found)} at ${offending.path}`,
        });
      }
      return answer;
    }).pipe(Effect.withSpan("plugins.invoke", { attributes: { pluginId, method } }));

  const sessions = Effect.sync(
    (): ReadonlyArray<{
      readonly pluginId: string;
      readonly session: SessionSeam;
      readonly ctx: ServerCtx;
    }> => {
      const rows: Array<{
        readonly pluginId: string;
        readonly session: SessionSeam;
        readonly ctx: ServerCtx;
      }> = [];
      for (const [pluginId, entry] of loaded) {
        // `loaded` only — a plugin that was skipped or whose activate threw must not keep running
        // inside every spawn.
        if (statuses.get(pluginId)?.state !== "loaded") continue;
        if (entry.plugin.session === undefined) continue;
        rows.push({ pluginId, session: entry.plugin.session, ctx: entry.ctx });
      }
      return rows;
    },
  );

  return {
    start,
    list,
    settings,
    setEnabled,
    manifestsForWeb: list,
    invoke,
    sessions,
    // ru-code (A5, A4 finding L1): `loaded` ONLY. The directory table is filled
    // for every manifest that decoded, so this used to keep serving `web/**` and
    // `assets/**` for a plugin whose server half had `failed` — broader than the
    // status model implies, and a shape the web loader (which skips non-`loaded`
    // plugins) already assumes is impossible. One state, one answer.
    resolvePluginDir: (pluginId: string) =>
      Effect.sync(() =>
        statuses.get(pluginId)?.state === "loaded" ? directories.get(pluginId) : undefined,
      ),
    stateFrames: stateHub.frames,
    statePosition: Effect.sync(() => stateHub.position()),
    stateSubscriberCount: Effect.sync(() => stateHub.subscriberCount()),
  } satisfies PluginHost["Service"];
});

/**
 * MODULE-LEVEL on purpose: `server.ts`,
 * `httpRoutes.ts` and — from A5 — `ws.ts` all provide THIS reference, so layer
 * memoization yields one host, one status table, one RPC table.
 */
export const PluginHostLayer: Layer.Layer<
  PluginHost,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | SqlClient.SqlClient
> = Layer.effect(PluginHost, make).pipe(
  // ru-code (A22, O2-a): the read-model repository behind `host.projects`, provided HERE rather
  // than required of every caller — the same self-provisioning idiom. It costs
  // this layer one ambient service (`SqlClient`, already present everywhere the host is provided,
  // because the app's whole read model runs on it) and costs `server.ts` / `ws.ts` nothing.
  Layer.provide(ProjectionProjectRepositoryLive),
);

/** Alias matching the house `layer` naming for tests and local composition. */
export const layer = PluginHostLayer;
