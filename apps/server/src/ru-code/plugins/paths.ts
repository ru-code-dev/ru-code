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
 * @module ru-code/plugins/paths
 */
import * as Effect from "effect/Effect";
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
