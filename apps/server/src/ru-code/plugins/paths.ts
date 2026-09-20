/**
 * ru-code: where plugin folders live, resolved in exactly one place.
 *
 * WHY a module of its own. A plugin is a folder the user drops in — it is NOT
 * part of the install payload, so it may not live anywhere the updater's version
 * GC can reach. `<baseDir>/plugins/<id>/` (= `~/.ru-code/plugins/<id>/`) is the
 * one location that survives an installer run and an auto-update, which is what
 * makes "copy the folder, restart, it works" true across upgrades. Several
 * consumers must agree on that path (the boot loader here, later the manifest
 * scanner and the plugin asset HTTP route), and a second derivation that drifts
 * would silently serve a different directory than the one that was scanned — so
 * the path is derived from `ServerConfig.baseDir` here and nowhere else.
 *
 * `RU_CODE_PLUGINS_DIR` overrides the directory. TESTS ONLY: it exists so a unit
 * test or an e2e run can point the host at a fixture directory without writing
 * into the developer's real base dir. Nothing in the product sets it, and it is
 * deliberately not a CLI flag — it is not a supported way to relocate plugins.
 *
 * v2 (V2-20/V2-21) — there is a SECOND root: the SHIPPED set, which lives inside
 * the release payload (`versions/<v>/plugins/<id>`, a sibling of `client/`) and
 * is therefore replaced wholesale by every install and every auto-update. It is
 * NOT derived from `baseDir`: it has to be found relative to the code that is
 * running, which is the only thing that identifies "this version's payload".
 * See {@link resolveShippedPluginsDir}.
 *
 * @module ru-code/plugins/paths
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";

/** Folder under `baseDir` that holds one subfolder per installed plugin. */
export const PLUGINS_DIR_NAME = "plugins";

/**
 * `candidate` is `root` itself or lives beneath it.
 *
 * ru-code (A5): lives HERE, not in `scan.ts`, because three modules containment-
 * check a path against a root — `scan.ts` (the plugin directory), `manifest.ts`
 * (a declared entry) and `httpRoutes.ts` (a served file) — and `scan.ts` already
 * imports `manifest.ts`, so keeping it there would have made the pair circular.
 * `paths.ts` is the module all three already depend on.
 */
export const isWithinRoot = (path: Path.Path, root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/** Test-only override of the plugins directory (see the module doc). */
export const PLUGINS_DIR_ENV_VAR = "RU_CODE_PLUGINS_DIR";

/**
 * Pure resolution, so tests can exercise the override without a live process env.
 * An empty/whitespace override is treated as unset — an env var set to "" is an
 * accident, never an instruction to scan the filesystem root.
 */
export const resolvePluginsDir = (input: {
  readonly path: Path.Path;
  readonly baseDir: string;
  readonly override: string | undefined;
}): string => {
  const override = input.override?.trim();
  return override !== undefined && override.length > 0
    ? input.path.resolve(override)
    : input.path.join(input.baseDir, PLUGINS_DIR_NAME);
};

/** `<baseDir>/plugins`, or the test-only `RU_CODE_PLUGINS_DIR` override. */
export const pluginsDir: Effect.Effect<string, never, ServerConfig.ServerConfig | Path.Path> =
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return resolvePluginsDir({
      path,
      baseDir: serverConfig.baseDir,
      override: process.env[PLUGINS_DIR_ENV_VAR],
    });
  });

/**
 * Test-only override of the SHIPPED plugins directory.
 *
 * Same warning as `RU_CODE_PLUGINS_DIR`, and for the same reason: it exists so a unit test or an
 * e2e run can point the shipped root at a payload-shaped fixture instead of having to build a
 * release. Nothing in the product sets it, it is not a CLI flag, and it is NOT a supported way to
 * relocate the shipped set — the shipped set is defined by the payload the app is running from.
 */
export const SHIPPED_PLUGINS_DIR_ENV_VAR = "RU_CODE_SHIPPED_PLUGINS_DIR";

/**
 * Where {@link resolveShippedPluginsDir} probes, in order, relative to THIS module's directory.
 *
 * Exported so the test names the same two strings the resolver uses rather than re-deriving them.
 *
 *  1. `plugins` — the payload/dist sibling. `vp pack` emits `bin.mjs` and every code-split chunk
 *     FLAT into `apps/server/dist/`, and `prepare-release` copies that flat set plus `client/` and
 *     `plugins/` into `versions/<v>/`. So `<import.meta.dirname>` is `apps/server/dist` when the
 *     built app runs from `dist/`, `versions/<v>/` when the installed app runs from the payload,
 *     and the Electron resources dir in the desktop artifact (which copies the whole of
 *     `apps/server/dist`). One probe, three channels — exactly the trick
 *     `ServerConfig.resolveStaticDir` already uses for `client/`.
 *  2. `../../../dist/plugins` — `pnpm dev`, where this module runs from
 *     `apps/server/src/ru-code/plugins/` and three levels up is `apps/server/`. (The S6 brief
 *     spelled this `../dist/plugins`, which is the walk from `apps/server/src/`; `paths.ts` is
 *     three directories deeper, so the walk is longer. Same destination.)
 */
export const SHIPPED_PLUGINS_DIR_PROBES: ReadonlyArray<string> = [
  "plugins",
  "../../../dist/plugins",
];

/**
 * Pure resolution, so the probe order can be tested without `import.meta.dirname`.
 *
 * An override wins OUTRIGHT — it is not probed and there is no fallback behind it. A test that
 * points the shipped root at an empty fixture must get "no shipped plugins", never the developer's
 * real `dist/plugins`. Empty/whitespace is treated as unset, the same accident-not-an-instruction
 * rule `resolvePluginsDir` applies.
 */
export const shippedPluginsDirCandidates = (input: {
  readonly path: Path.Path;
  readonly moduleDir: string;
  readonly override: string | undefined;
}): ReadonlyArray<string> => {
  const override = input.override?.trim();
  if (override !== undefined && override.length > 0) return [input.path.resolve(override)];
  return SHIPPED_PLUGINS_DIR_PROBES.map((probe) =>
    input.path.resolve(input.path.join(input.moduleDir, probe)),
  );
};

/**
 * The shipped plugins root, or `undefined` when this build ships none.
 *
 * `undefined` is a normal answer, not a degraded one: a release need not carry plugins (a fork, a
 * minimal build, a clone without the `ru-code-packages` symlink — `ru-code/packaging/shipped-plugins.json`
 * skips what it cannot stage), and `pnpm dev` before a `pnpm stage:plugins` has none either. The
 * host simply scans one root instead of two.
 *
 * A candidate must be a real DIRECTORY: a file called `plugins` beside the bundle would otherwise
 * be handed to `scanPluginsDir`, which would read it as an empty root and hide the mistake.
 */
export const resolveShippedPluginsDir: Effect.Effect<
  string | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const candidates = shippedPluginsDirCandidates({
    path,
    moduleDir: import.meta.dirname,
    override: process.env[SHIPPED_PLUGINS_DIR_ENV_VAR],
  });
  for (const candidate of candidates) {
    const stat = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => null));
    if (stat !== null && stat.type === "Directory") return candidate;
  }
  return undefined;
});

/** File name of a plugin's own SQLite database inside its state folder. */
export const PLUGIN_DB_FILENAME = "data.sqlite";

/**
 * `<stateDir>/plugins/<id>` — the plugin's own data folder (D2).
 *
 * Deliberately under `stateDir`, NOT under the plugin folder: deleting the
 * dropped-in folder must not destroy the user's data (D11 keeps it), and the
 * plugin folder is replaced wholesale on every re-install. Deliberately one
 * folder per plugin: the host opens exactly this file for that plugin, so the
 * app's own `state.sqlite` is not reachable from a plugin at all.
 *
 * NOT derived from `pluginsDir`: `RU_CODE_PLUGINS_DIR` relocates where plugin
 * CODE is read from (tests, e2e fixtures) and must not relocate user data.
 */
export const pluginStateDir = (
  id: string,
): Effect.Effect<string, never, ServerConfig.ServerConfig | Path.Path> =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(serverConfig.stateDir, PLUGINS_DIR_NAME, id);
  });

/** `<stateDir>/plugins/<id>/data.sqlite` — the only database a plugin can reach. */
export const pluginDbPath = (
  id: string,
): Effect.Effect<string, never, ServerConfig.ServerConfig | Path.Path> =>
  Effect.gen(function* () {
    const dir = yield* pluginStateDir(id);
    const path = yield* Path.Path;
    return path.join(dir, PLUGIN_DB_FILENAME);
  });
