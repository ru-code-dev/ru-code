/**
 * ru-code v2: the `ServerCtx` a server plugin's seams receive (architecture.md §2.2).
 *
 * v1 handed a plugin a HOST OBJECT with `registerRpc` / `registerSessionHook` on it, so the
 * contract was "call these during activate, in this order". v2 has no registration API at all: a
 * plugin EXPORTS seams and the host passes this ctx into each call. What is left here is therefore
 * only what the app alone can supply — the plugin's own database, the two paths it would otherwise
 * guess, the project read model, and the logger.
 *
 * WHY it is promise-shaped (D6). A plugin folder cannot resolve bare specifiers (V2: Node walks
 * parents for `node_modules` and finds none outside the app tree), so it cannot `import "effect"`
 * even if it wanted to. Every effect a plugin triggers runs on the SERVER's runtime, captured once
 * when the ctx is built.
 *
 * WHY logging goes through the runtime and never through `console`. Server logs are structured,
 * level-filtered, span-annotated and written to `<stateDir>/logs/server.log`; a `console.log` from
 * a plugin would bypass all of that and be invisible in a bug report. Every line is annotated with
 * the plugin id, and logging is fire-and-forget (`runFork`): a plugin must never be able to block,
 * and a failing logger must never surface inside plugin code.
 *
 * @module ru-code/plugins/ctx
 */
import type {
  PluginLogger,
  PluginPaths,
  PluginProjects,
  PluginStorage,
  ServerCtx,
} from "@smart-tools/plugin-sdk/host";
import * as Effect from "effect/Effect";

import { getLocale } from "@ru-code/localization";

/** Map `log.{info,warn,error}` onto the server's Effect logger, annotated with the plugin id. */
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
 * Assemble the `ServerCtx` for one plugin.
 *
 * Everything is already bound to THIS plugin: its id, its database handle, its data folder. There
 * is no argument a plugin could pass to reach another plugin's state. `paths` is frozen at build
 * time rather than a getter — the CLI base is resolved once at boot and cannot move while the
 * server runs, so a getter would only add a way to observe a value that never changes.
 */
export const makeServerCtx = (input: {
  readonly id: string;
  readonly log: PluginLogger;
  readonly storage: PluginStorage;
  readonly paths: PluginPaths;
  readonly projects: PluginProjects;
  /**
   * ru-code S69 (V2-58): where `ctx.publish(name, value)` goes — the host's state hub, already bound
   * to this plugin's id by the caller (`PluginHost.ts`), so nothing here can address another plugin.
   */
  readonly publish: (name: string, value: unknown) => void;
}): ServerCtx => ({
  pluginId: input.id,
  log: input.log,
  storage: input.storage,
  paths: input.paths,
  projects: input.projects,
  // V2-58: the plugin's live values. Synchronous and never throws — the hub checks the name, the
  // JSON, the size and the names cap, keeps the last value, and forwards only a change
  // (`state.ts`).
  publish: input.publish,
  // ru-code: plugins - the app's CURRENT language (V2-51). A FUNCTION and not a frozen string:
  // `serverSettings.ts` calls `setLocale` whenever the user changes the setting, so a value
  // captured here would answer the language the server booted with for the life of the process.
  // `getLocale()` is the same reader every server-side `L(en, ru)` in this app already uses.
  locale: () => getLocale(),
});
