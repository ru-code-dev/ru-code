/**
 * ru-code: the server-side plugin host — scan, activate, report, invoke.
 *
 * This is the module that turns "a folder appeared in `~/.ru-code/plugins/`"
 * into a running server plugin, and the ONE place that knows a plugin's state.
 * Three consumers read it and must all see the SAME instance: the boot phase
 * (`serverRuntimeStartup.ts`, which calls `start`), the HTTP asset route
 * (`httpRoutes.ts`, which serves `manifests.json` and the plugin's web files),
 * and — from A5 — the `plugin.invoke` / `plugin.list` ws handlers. Hence a
 * module-level `PluginHostLayer`, exactly like `PixsoAssistantHostLayer`
 * (`ru-code/pixso-assistant/ports.ts`, "MODULE-LEVEL on purpose"): layer
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
  PluginRpcError,
  type PluginStatus,
  type WebManifestList,
} from "@smart-tools/plugin-sdk/contracts";
import type { PluginManifest } from "@smart-tools/plugin-sdk/contracts";
import * as NodeOS from "node:os";
import type { PluginSessionHook, ServerPluginDefinition } from "@smart-tools/plugin-sdk/host";
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

import { getLocale } from "@ru-code/localization";

import * as ServerConfig from "../../config.ts";
import { makePluginLogger, makeServerPluginHost, type PluginRpcHandler } from "./hostApi.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectId } from "@t3tools/contracts";
import { loadPluginModule } from "./loader.ts";
import { pluginDbPath, pluginsDir, pluginStateDir } from "./paths.ts";
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
 * Accept both shapes a server entry may default-export.
 *
 * `definePlugin({ migrations, activate })` is the documented form. A bare
 * function is also accepted as `activate`: it is the smallest possible plugin
 * (A0's pack-gate fixtures are exactly that) and refusing it would make the
 * simplest hello-world the one shape that does not work.
 */
export const normalizeServerDefinition = (value: unknown): ServerPluginDefinition | null => {
  if (typeof value === "function") {
    return { activate: value as ServerPluginDefinition["activate"] };
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly activate?: unknown; readonly migrations?: unknown };
  if (typeof candidate.activate !== "function") return null;
  const migrations = Array.isArray(candidate.migrations)
    ? (candidate.migrations as ServerPluginDefinition["migrations"])
    : undefined;
  return {
    activate: candidate.activate as ServerPluginDefinition["activate"],
    ...(migrations === undefined ? {} : { migrations }),
  };
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
  };
};

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

    /** What `GET /plugins/manifests.json` serves to the web bootstrap. */
    readonly manifestsForWeb: Effect.Effect<WebManifestList>;

    /** Call a method a plugin registered with `host.registerRpc`. */
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
     * ru-code (A22, SDK 0.3.0, owner decision O1-B): every session hook a `loaded` plugin
     * registered, in load order, each tagged with the plugin that owns it.
     *
     * The consumer is `SessionRespawnGate`, on the spawn path. It is a plain synchronous read
     * because the gate runs per turn and must not pay for a service call to find out there are no
     * hooks — which is the case on every install that has none.
     *
     * A plugin that is not `loaded` never appears here: a failed activate may still have called
     * `registerSessionHook` before it threw, and a disabled plugin must not keep running on the
     * user's critical path.
     */
    readonly sessionHooks: Effect.Effect<
      ReadonlyArray<{ readonly pluginId: string; readonly hook: PluginSessionHook }>
    >;
  }
>()("t3/ru-code/plugins/PluginHost") {}

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
  const path = yield* Path.Path;
  const rootDir = yield* pluginsDir;
  // ru-code (A13 round 2, A12 finding R2-M1): the roots `sanitizeStatusError` erases by name.
  // Captured once here, where the config is already in hand, so no status branch can be built
  // without them.
  const serverConfig = yield* ServerConfig.ServerConfig;
  // ru-code (A16): `cliConfigDir` is a plain string on the config plus a separate `cliDetected`
  // flag; folded here into the one nullable value the SDK's `host.paths.cliConfigDir` promises.
  const cliConfigDir = serverConfig.cliDetected ? serverConfig.cliConfigDir : null;
  const pathRoots: PluginPathRoots = {
    pluginsRoot: rootDir,
    stateDir: serverConfig.stateDir,
    baseDir: serverConfig.baseDir,
    // Only when it is real: `sanitizeStatusError` ignores short/empty roots anyway, but an
    // undetected CLI has no path to erase and should not add a token to the table.
    ...(cliConfigDir === null ? {} : { cliConfigDir }),
  };

  // Plain Maps, not Refs, on purpose: `registerRpc` is called synchronously from
  // inside plugin code, which has no way to run an Effect (D6). Everything here
  // is written on the boot fiber and read afterwards.
  const statuses = new Map<string, PluginStatus>();
  const directories = new Map<string, string>();
  const handlers = new Map<string, Map<string, PluginRpcHandler>>();
  // ru-code (A22, O1-B): one hook per plugin, last-one-wins — the SDK says a second
  // `registerSessionHook` replaces the first, and a Map keyed by plugin id is that rule.
  const sessionHookTable = new Map<string, PluginSessionHook>();
  let started = false;

  // ru-code (A22, O2-a): the app's project read model, narrowed to `{ id, cwd }` for plugins.
  //
  // `ProjectionProjectRepositoryLive` is provided ONTO this layer below rather than required of
  // every caller, the self-provisioning idiom the app's own host layers use: the plugin host is
  // provided from three places (`server.ts`, `ws.ts`, the tests) and widening
  // its requirement list would make every one of them name a service no plugin can see anyway.
  const projectRepo = yield* ProjectionProjectRepository;

  /**
   * `{ id, cwd }` for every LIVE project. Soft-deleted rows are dropped HERE, at the seam, so no
   * plugin can be handed a project the user removed — the same filter the compiled-in catalog
   * layers applied before A25 moved them into `@smart-tools/plugin-catalogs`.
   */
  const liveProjects = (
    repo: ProjectionProjectRepositoryShape,
  ): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly cwd: string }>> =>
    repo.listAll().pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.deletedAt === null)
          .map((row) => ({ id: row.projectId as string, cwd: row.workspaceRoot })),
      ),
      // A read failure is an EMPTY list, never a rejection: `host.projects` is promise-shaped and
      // a plugin that has to try/catch "which projects exist" will not, so the honest degraded
      // answer is "none I can see" — which for a catalog plugin means global-only, exactly what a
      // fresh install looks like. The operator sees the cause in the log.
      Effect.catchCause((cause) =>
        Effect.logError("ru-code plugins: host.projects.listLive failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<{ readonly id: string; readonly cwd: string }>)),
      ),
    );

  /** A project's workspace root, or `null` when it does not exist or was soft-deleted. */
  const projectCwd = (
    repo: ProjectionProjectRepositoryShape,
    projectId: string,
  ): Effect.Effect<string | null> =>
    Effect.suspend(() => repo.getById({ projectId: ProjectId.make(projectId) })).pipe(
      Effect.map((option) => {
        const project = Option.getOrNull(option);
        return project !== null && project.deletedAt === null ? project.workspaceRoot : null;
      }),
      // Same posture as `liveProjects`, and the same reason a MALFORMED id lands here: `ProjectId`
      // is a branded decode, so `getCwd("../../etc")` throws inside `make` rather than returning —
      // `Effect.suspend` is what turns that into this catch instead of a synchronous throw out of
      // the promise the plugin awaited.
      Effect.catchCause((cause) =>
        Effect.logError("ru-code plugins: host.projects.getCwd failed", {
          projectId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );

  const pluginProjects = {
    listLive: () => runPromise(liveProjects(projectRepo)),
    getCwd: (projectId: string) =>
      typeof projectId === "string" && projectId.trim() !== ""
        ? runPromise(projectCwd(projectRepo, projectId))
        : Promise.resolve(null),
  };

  const registerRpcFor =
    (pluginId: string) =>
    (method: string, handler: PluginRpcHandler): void => {
      if (typeof method !== "string" || method.trim().length === 0) {
        runFork(
          Effect.logWarning("ru-code plugins: registerRpc called with an invalid method name", {
            id: pluginId,
          }),
        );
        return;
      }
      if (typeof handler !== "function") {
        runFork(
          Effect.logWarning("ru-code plugins: registerRpc called with a non-function handler", {
            id: pluginId,
            method,
          }),
        );
        return;
      }
      let table = handlers.get(pluginId);
      if (table === undefined) {
        table = new Map();
        handlers.set(pluginId, table);
      }
      if (table.has(method)) {
        // Last one wins, but never silently: a double registration is a bug in
        // the plugin and the author needs to see it.
        runFork(
          Effect.logWarning("ru-code plugins: method re-registered, replacing handler", {
            id: pluginId,
            method,
          }),
        );
      }
      table.set(method, handler);
    };

  /** Run one server plugin's five activation steps; never fails. */
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
      const loaded = imported.value;
      if (Result.isFailure(loaded)) {
        return failed(
          `failed to import ${entry.serverEntry}: ${describeError(loaded.failure.cause)}`,
        );
      }

      const definition = normalizeServerDefinition(loaded.success);
      if (definition === null) {
        return failed(
          `${entry.serverEntry} default export is not a plugin definition (expected definePlugin({ activate }) or a function)`,
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

      // `runPluginMigrations` cannot fail (it encodes failure in its outcome), so
      // this step needs the budget but not the `Result` half of `timedStep`.
      const migrationRun = yield* runPluginMigrations(sql, definition.migrations ?? []).pipe(
        Effect.timeoutOption(PLUGIN_STEP_TIMEOUT),
      );
      if (Option.isNone(migrationRun)) {
        return failed(`migrations timed out after ${PLUGIN_STEP_TIMEOUT_LABEL}`);
      }
      const migrated = migrationRun.value;
      if (!migrated.ok) {
        return failed(`migration "${migrated.failedId}" failed: ${migrated.error}`);
      }
      if (migrated.applied.length > 0) {
        yield* Effect.logInfo("ru-code plugins: applied migrations", {
          id: manifest.id,
          migrations: migrated.applied,
        });
      }

      // ru-code (A22): the plugin's own folder — the parent of the `data.sqlite` opened above, so
      // the two can never name different directories.
      const dataDir = yield* pluginStateDir(manifest.id);

      const host = makeServerPluginHost({
        id: manifest.id,
        dir,
        log: makePluginLogger({ id: manifest.id, runFork }),
        storage: makePluginStorage({ sql, run: runPromise }),
        registerRpc: registerRpcFor(manifest.id),
        getLocale,
        cliConfigDir,
        dataDir,
        projects: pluginProjects,
        registerSessionHook: (hook) => {
          if (typeof hook !== "object" || hook === null) {
            runFork(
              Effect.logWarning("ru-code plugins: registerSessionHook called with a non-object", {
                id: manifest.id,
              }),
            );
            return;
          }
          if (sessionHookTable.has(manifest.id)) {
            // Last one wins, but never silently — the same posture `registerRpc` takes.
            runFork(
              Effect.logWarning("ru-code plugins: session hook re-registered, replacing", {
                id: manifest.id,
              }),
            );
          }
          sessionHookTable.set(manifest.id, hook);
        },
      });

      const activateRun = yield* timedStep(
        Effect.tryPromise({
          // The call is inside the async body so a SYNCHRONOUS throw in
          // `activate` becomes a rejected promise instead of escaping here.
          try: async () => {
            await definition.activate(host);
          },
          catch: (cause) => new PluginActivateError({ pluginId: manifest.id, cause }),
        }),
      );
      if (Option.isNone(activateRun)) {
        return failed(`activate timed out after ${PLUGIN_STEP_TIMEOUT_LABEL}`);
      }
      const activated = activateRun.value;
      if (Result.isFailure(activated)) {
        return failed(`activate() failed: ${describeError(activated.failure.cause)}`);
      }

      return statusFor({ manifest, state: "loaded", roots: pathRoots });
    }).pipe(
      // ru-code (A5, A4 finding L8; A7 finding L4): this branch is practically
      // unreachable (every step above is already caught), but what reaches it is
      // a `Cause` — a defect or an interrupt — and `describeError` is written for
      // an `Error`/string, so it would have JSON-stringified a Cause object into
      // `PluginStatus.error`. `Cause.pretty` reads it properly but renders STACK
      // FRAMES and absolute paths, and that field is served UNAUTHENTICATED by
      // `GET /plugins/manifests.json` (`access-control-allow-origin: *`, A4 L7).
      // So: the pretty cause goes to the operator's LOG, and the status carries
      // the message alone.
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

  const start = Effect.gen(function* () {
    if (started) {
      yield* Effect.logWarning("ru-code plugins: start() called twice, ignoring");
      return;
    }
    started = true;

    const entries = yield* scanPluginsDir(rootDir);
    for (const entry of entries) {
      if (!entry.ok) {
        const id = path.basename(entry.dir);
        const status: PluginStatus = {
          id,
          name: id,
          version: "",
          state: "skipped",
          hasWeb: false,
          hasServer: false,
          // Same disclosure rule as every other status row (A13, A12 finding R1-M2): the scanner's
          // reasons are host-authored today, but this field is served unauthenticated and must not
          // depend on that staying true.
          error: sanitizeStatusError(entry.reason, pathRoots),
        };
        statuses.set(id, status);
        yield* Effect.logWarning("ru-code plugins: skipped", { id, error: entry.reason });
        continue;
      }

      const manifest = entry.manifest;
      directories.set(manifest.id, entry.dir);

      if (manifest.server === undefined) {
        const status = statusFor({ manifest, state: "loaded", roots: pathRoots });
        statuses.set(manifest.id, status);
        yield* Effect.logInfo("ru-code plugins: loaded", {
          id: manifest.id,
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
          state: status.state,
          hasServer: true,
        });
      } else {
        yield* Effect.logWarning("ru-code plugins: failed", {
          id: status.id,
          state: status.state,
          error: status.error,
        });
      }
    }

    yield* Effect.logDebug("ru-code plugins: scan complete", {
      dir: rootDir,
      total: statuses.size,
    });
  }).pipe(Effect.provide(runtimeContext), Effect.withSpan("plugins.start"));

  const list = Effect.sync((): ReadonlyArray<PluginStatus> => [...statuses.values()]);

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
      const handler = handlers.get(pluginId)?.get(method);
      if (handler === undefined) {
        return yield* new PluginRpcError({
          reason: "unknown-method",
          detail: `${pluginId}.${method}`,
        });
      }
      return yield* Effect.tryPromise({
        // ru-code (A13, A12 findings R1-M3 and R1-L11):
        //  · `Promise.resolve(...)` — a handler that forgets `async` and returns a plain value
        //    used to surface `internalCall(...).then is not a function`, a minified host internal
        //    in the plugin author's error;
        //  · `?? null` — `undefined` is not a JSON value, so the wire schema
        //    (`contracts/rpc.ts`, `success: Schema.Unknown`) rejected it with "Expected JSON
        //    value" AFTER the handler's side effects had already run. The most natural write-only
        //    handler is `async () => { await host.storage.exec("DELETE FROM notes") }` and it
        //    returned `undefined`. `null` is the JSON spelling of "nothing"; documented in the
        //    SDK's `registerRpc` comment and README §5.
        try: async () => (await Promise.resolve(handler(payload))) ?? null,
        catch: (cause) =>
          new PluginRpcError({ reason: "plugin-failed", detail: describeError(cause) }),
      });
    }).pipe(Effect.withSpan("plugins.invoke", { attributes: { pluginId, method } }));

  const sessionHooks = Effect.sync(
    (): ReadonlyArray<{ readonly pluginId: string; readonly hook: PluginSessionHook }> => {
      const rows: Array<{ readonly pluginId: string; readonly hook: PluginSessionHook }> = [];
      for (const [pluginId, hook] of sessionHookTable) {
        // `loaded` only — a plugin whose activate threw AFTER registering a hook, or one that was
        // disabled, must not keep running inside every spawn.
        if (statuses.get(pluginId)?.state !== "loaded") continue;
        rows.push({ pluginId, hook });
      }
      return rows;
    },
  );

  return {
    start,
    list,
    manifestsForWeb: list,
    invoke,
    sessionHooks,
    // ru-code (A5, A4 finding L1): `loaded` ONLY. The directory table is filled
    // for every manifest that decoded, so this used to keep serving `web/**` and
    // `assets/**` for a plugin whose server half had `failed` — broader than the
    // status model implies, and a shape the web loader (which skips non-`loaded`
    // plugins) already assumes is impossible. One state, one answer.
    resolvePluginDir: (pluginId: string) =>
      Effect.sync(() =>
        statuses.get(pluginId)?.state === "loaded" ? directories.get(pluginId) : undefined,
      ),
  } satisfies PluginHost["Service"];
});

/**
 * MODULE-LEVEL on purpose (the pixso-assistant discipline): `server.ts`,
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
