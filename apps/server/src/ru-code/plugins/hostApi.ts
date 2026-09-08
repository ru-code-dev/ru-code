/**
 * ru-code: the object a server plugin's `activate(host)` receives.
 *
 * WHY it is promise-shaped (D6). A plugin folder cannot resolve bare specifiers
 * (V2 in `WORKFLOW/00-verifications.md`: Node walks parents for `node_modules`
 * and finds none outside the app tree), so a plugin cannot `import "effect"` even
 * if it wanted to — there is no way for it to construct or run an `Effect`. The
 * host boundary is therefore plain values and promises, and every effect is run
 * on the SERVER's runtime, captured once when the host object is built. An
 * Effect-native server host API is backlog, not MVP (mvp-plan §5).
 *
 * WHY logging goes through the runtime and never through `console`. Server logs
 * are structured, level-filtered, span-annotated and written to
 * `<stateDir>/logs/server.log` by the Effect logger; a `console.log` from a
 * plugin would bypass all of that and be invisible in a bug report. Every plugin
 * line is annotated with its plugin id so a noisy plugin can be identified from
 * the log alone. Logging is fire-and-forget (`runFork`): a plugin must never be
 * able to block, and a failing logger must never surface inside plugin code.
 *
 * @module ru-code/plugins/hostApi
 */
import type {
  PluginLocale,
  PluginLogger,
  PluginProjects,
  PluginSessionHook,
  PluginStorage,
  ServerPluginHost,
} from "@smart-tools/plugin-sdk/host";
import * as Effect from "effect/Effect";

/** Handler registered by a plugin under `plugin.invoke` (A5 wires the RPC). */
export type PluginRpcHandler = (payload: unknown) => Promise<unknown>;

/**
 * Map the plugin's `log.{info,warn,error}` onto the server's Effect logger.
 *
 * `runFork` is the captured runtime's `Effect.runForkWith(context)` — see the
 * module doc for why the plugin cannot hand us an Effect itself.
 */
export const makePluginLogger = (input: {
  readonly id: string;
  readonly runFork: (effect: Effect.Effect<void>) => unknown;
}): PluginLogger => {
  const emit =
    (log: (message: string, data?: Readonly<Record<string, unknown>>) => Effect.Effect<void>) =>
    (message: string, data?: Readonly<Record<string, unknown>>): void => {
      input.runFork(log(`[plugin:${input.id}] ${message}`, { plugin: input.id, ...data }));
    };
  return {
    info: emit((message, data) => Effect.logInfo(message, data)),
    warn: emit((message, data) => Effect.logWarning(message, data)),
    error: emit((message, data) => Effect.logError(message, data)),
  };
};

/**
 * Assemble the `ServerPluginHost` for one plugin.
 *
 * Everything here is already bound to THIS plugin: its id, its folder, its
 * database handle and its slot in the RPC table. There is no parameter a plugin
 * could pass to reach another plugin's state.
 */
export const makeServerPluginHost = (input: {
  readonly id: string;
  readonly dir: string;
  readonly log: PluginLogger;
  readonly storage: PluginStorage;
  readonly registerRpc: (method: string, handler: PluginRpcHandler) => void;
  readonly getLocale: () => PluginLocale;
  /**
   * ru-code (A16, SDK 0.2.0): `ServerConfig.cliConfigDir`, or `null` when `cliDetected` is false.
   *
   * The config type carries `cliConfigDir` as a plain `string` and a separate `cliDetected` flag
   * (`config.ts:75-79`), so the two are folded into one nullable value HERE, at the seam, rather
   * than handed to every plugin as a pair it has to remember to check together. A plugin that
   * scanned an undetected CLI's path would enumerate the wrong tree and report it as empty.
   */
  readonly cliConfigDir: string | null;
  /**
   * ru-code (A22, SDK 0.3.0): `<stateDir>/plugins/<id>/` — the folder that already holds this
   * plugin's `data.sqlite`.
   *
   * Passed in rather than derived here for the same reason `cliConfigDir` is: `paths.ts` is the
   * ONE place a plugin path is resolved (its module doc says so), and a second derivation that
   * drifted would hand a plugin a directory the host never created.
   */
  readonly dataDir: string;
  /**
   * ru-code (A22, SDK 0.3.0, owner decision O2-a): the narrowed project slice.
   *
   * The caller has already reduced the app's read model to `{ id, cwd }` and dropped soft-deleted
   * rows, because that reduction is what makes this a NARROW port rather than a window onto
   * `state.sqlite` — doing it here, one layer further out, would put the decision in reach of a
   * later edit to a file that is mostly about assembling an object.
   */
  readonly projects: PluginProjects;
  /**
   * ru-code (A22, SDK 0.3.0, owner decision O1-B): record this plugin's session hook.
   *
   * Storage only; the BUDGET and the failure policy live where the hooks are consumed
   * (`SessionRespawnGate.ts`), because that is the code on the spawn path and a policy split
   * across two files is a policy nobody can read.
   */
  readonly registerSessionHook: (hook: PluginSessionHook) => void;
}): ServerPluginHost => ({
  id: input.id,
  dir: input.dir,
  log: input.log,
  storage: input.storage,
  // Frozen shape, resolved once at activate: the CLI base does not change while the server runs
  // (it is read from the config that was resolved at boot), so a getter would only add a way for
  // a plugin to observe a value that cannot move.
  paths: { cliConfigDir: input.cliConfigDir, dataDir: input.dataDir },
  projects: input.projects,
  getLocale: () => input.getLocale(),
  registerRpc: (method, handler) => {
    input.registerRpc(method, handler);
  },
  registerSessionHook: (hook) => {
    input.registerSessionHook(hook);
  },
});
