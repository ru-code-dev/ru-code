/**
 * ru-code: the plugin entry loader — the one place the server pulls code that
 * was not present when the server was built.
 *
 * WHY it is written this way. A plugin folder lives outside the app tree, so its
 * entry can only be reached by a specifier computed at runtime:
 * `import(pathToFileURL(abs).href)`. That is load-bearing twice over.
 *
 *  - It must survive the shipped bundler. `vp pack` runs tsdown/rolldown over
 *    this file (`apps/server/vite.config.ts`, `pack:` block); a bundler that
 *    rewrote or statically resolved this specifier would make the whole
 *    folder-drop model impossible. V1 in `WORKFLOW/00-verifications.md` proved
 *    rolldown 1.2.6 emits it verbatim, and the app already relies on the same
 *    mechanism in production every launch
 *    (`ru-code/auto-update/wrapper/wrapperSource.ts:261`).
 *  - It must be a `file://` URL, not a bare path: on Windows an absolute path is
 *    not a valid ESM specifier, and a relative-looking one would be resolved
 *    against this module instead of against the plugin folder.
 *
 * V2 in the same file records the other half of the contract: a plugin folder
 * cannot resolve bare specifiers at all (`ERR_MODULE_NOT_FOUND` — Node walks
 * parents for `node_modules` and finds none outside the app tree), so a plugin
 * imports nothing shared and receives the host's own already-loaded modules
 * through the host object instead. This module only opens the door; it makes no
 * assumption about what is behind it beyond "the default export".
 *
 * Failure posture (project rule): a plugin may never take the host down. A
 * missing plugins directory means "no plugins", not an error; a plugin whose
 * entry throws on import is logged and skipped, and every other plugin still
 * loads.
 *
 * This module is deliberately the MINIMAL reachable slice — no manifest parsing,
 * no host API, no status tracking. Those live in `PluginHost.ts`, which is what
 * calls `loadPluginModule` at boot (A0's standalone boot probe was replaced by
 * it); keeping the dynamic `import()` reachable from `src/bin.ts` is what makes
 * the bundler behavior a thing we test rather than a thing we hope for.
 *
 * @module ru-code/plugins/loader
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";

export class PluginLoadError extends Schema.TaggedErrorClass<PluginLoadError>()("PluginLoadError", {
  entryPath: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to import plugin entry ${this.entryPath}`;
  }
}

/**
 * Import a plugin entry by absolute path and hand back its default export.
 *
 * The specifier is computed here on purpose — see the module doc. Do not
 * "simplify" it into a constant or a template the bundler can analyse.
 */
export const loadPluginModule = (absPath: string): Effect.Effect<unknown, PluginLoadError> =>
  Effect.tryPromise({
    try: async () => {
      const href = NodeURL.pathToFileURL(absPath).href;
      const mod = (await import(href)) as { readonly default?: unknown };
      return mod.default;
    },
    catch: (cause) => new PluginLoadError({ entryPath: absPath, cause }),
  }).pipe(Effect.withSpan("plugins.loadPluginModule", { attributes: { entryPath: absPath } }));
