// ru-code v2: the web half of the loader.
//
// Boot order (`main.tsx`): `import "./index.css"` → `createRoot(...).render(...)` →
// `void loadPlugins()`. Plugins load AFTER the first paint and NEVER block it: the earlier design
// awaited this function before `createRoot`, which let a plugin whose `activate()` never settles
// white-screen the app permanently. Everything a plugin contributes is read reactively out of the
// registry, so a page or a panel that lands a moment after first paint simply appears.
//
// Failure posture: missing ⇒ empty, malformed ⇒ skip + log, a plugin that throws ⇒ that plugin
// disabled, a plugin that HANGS ⇒ that plugin disabled after `PLUGIN_LOAD_TIMEOUT_MS`.
// `loadPlugins()` never rejects. Plugins load CONCURRENTLY: one slow plugin must not delay the
// others, and the budget is per plugin, not per batch.
//
// WHAT v2 CHANGED. v1 imported the entry, dug an `activate` out of the default export and handed
// it a host object of registration methods; whatever it registered, wherever, was the plugin's
// contribution. v2 imports the entry, treats the default export AS the plugin (V2-2), records it,
// and calls `activate` only if it exports one — a plugin with no lifecycle is a whole plugin.

import { localizedText, WebManifestList } from "@smart-tools/plugin-sdk/contracts";
import type { WebPlugin } from "@smart-tools/plugin-sdk/host";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getLocale, L } from "@ru-code/localization";

import { makeWebCtx } from "./ctx";
import { reportPluginProblem } from "./problems";
import { addLoadedPlugin } from "./registry";
import { markPluginsPass, type PluginLoadPass } from "./registry";
import { recordPluginDisplayName, recordPluginStatus, type WebPluginStatus } from "./status";

/** `GET /plugins/manifests.json` — served by the app's own server, same origin. */
const MANIFESTS_URL = "/plugins/manifests.json";

/** The fixed folder layout's web entry, used when a status declares no `web` path. */
const WEB_ENTRY_PATH = "web/index.mjs";

/**
 * Per-plugin budget for import + activate, together.
 *
 * A plugin that never settles is at least as likely as one that throws — an `await fetch(...)` to
 * a dead endpoint, an unreleased lock — and it used to take the whole app with it. Ten seconds is
 * generous for a local `import()` of a bundled module and short enough that the status settles
 * while the user is still looking at the boot.
 */
export const PLUGIN_LOAD_TIMEOUT_MS = 10_000;

/** A relative path is only usable if it stays inside the plugin's own folder. */
function containedRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^\/+/, "");
  if (trimmed === "" || trimmed.includes("\0")) return null;
  if (trimmed.split("/").some((segment) => segment === ".." || segment === ".")) return null;
  return trimmed;
}

/**
 * Where this plugin's web entry lives.
 *
 * The DECODED status is the source: a manifest may point `web` anywhere, and hard-coding
 * `web/index.mjs` used to advertise such a plugin as loadable and then 404 it, with the toast
 * blaming the plugin for a gap in the host's own contract. The fixed layout is the fallback for a
 * plugin that declares no `web` at all. Containment is re-checked here as well as on the server:
 * the path becomes a URL under this plugin's prefix, and a `..` would aim it at another's folder.
 */
export function resolveWebEntryPath(status: { readonly web?: unknown }): string {
  return containedRelativePath(status.web) ?? WEB_ENTRY_PATH;
}

export interface LoadPluginsOptions {
  /** How a plugin's web entry is imported. Injected so tests drive the loader without a server. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Injected for tests; production uses the page's `fetch`. */
  readonly fetchManifests?: (url: string) => Promise<Response>;
  /** Injected for tests; production appends to `document.head`. */
  readonly appendStylesheet?: (href: string) => void;
  /** Per-plugin import+activate budget; defaults to {@link PLUGIN_LOAD_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

const decodeManifests = Schema.decodeUnknownOption(WebManifestList);

/** Tells a plugin's `<link>` apart from the app's own stylesheets. */
export const PLUGIN_STYLESHEET_ATTRIBUTE = "data-ru-code-plugin-styles";

/** The shape {@link findAppStylesheet} needs — a `<head>` child, and nothing else. */
type HeadChild = { readonly tagName: string; getAttribute(name: string): string | null };

/**
 * The first node in `<head>` the APP itself paints with: a `<link rel="stylesheet">` in a
 * production build, a `<style>` under a dev server. Sheets this loader inserted carry
 * {@link PLUGIN_STYLESHEET_ATTRIBUTE} and are skipped, so plugins keep their relative order and
 * every one of them still lands before the app's first sheet.
 */
export const findAppStylesheet = <T extends HeadChild>(children: Iterable<T>): T | null => {
  for (const child of children) {
    if (child.getAttribute(PLUGIN_STYLESHEET_ATTRIBUTE) !== null) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === "style") return child;
    if (tag === "link" && (child.getAttribute("rel") ?? "").trim().toLowerCase() === "stylesheet") {
      return child;
    }
  }
  return null;
};

/**
 * Insert a plugin stylesheet BEFORE the app's own.
 *
 * This used to be `appendChild`, and it removed the app's sidebar: a plugin sheet is a `<link>` in
 * the app's document, so its `.hidden{display:none}` and the app's
 * `@media(width>=48rem){.md\:block}` met at the same specificity and source order decided — which
 * appending handed to the plugin.
 *
 * Since V2-14 the SDK NESTS every rule of a plugin sheet under `[data-plugin-root="<id>"]`, so a
 * plugin's rules cannot select app DOM at all and this ordering is no longer what contains them.
 * It still matters for the one thing scoping deliberately leaves global — the `:root` variable
 * blocks Tailwind emits for its own default tokens — which must lose to the app's own.
 */
function defaultAppendStylesheet(href: string): void {
  // Once per href: a page can legitimately reload plugins in one session (the e2e suite does).
  if (document.head.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`) !== null) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute(PLUGIN_STYLESHEET_ATTRIBUTE, "");
  const firstAppSheet = findAppStylesheet(document.head.children);
  if (firstAppSheet === null) {
    document.head.appendChild(link);
    return;
  }
  document.head.insertBefore(link, firstAppSheet);
}

/**
 * The default export, as a `WebPlugin` — or `null` when it is not one.
 *
 * Every seam is optional, so the only thing rejected here is an export that is not an object at
 * all: `export default 42`, or a module with no default. A seam of the wrong shape is dropped by
 * the seam RUNNER, where the surface it would have filled is, so a plugin never loses a good
 * surface to a bad one.
 */
export function resolveWebPlugin(moduleDefault: unknown): WebPlugin | null {
  if (typeof moduleDefault !== "object" || moduleDefault === null) return null;
  return moduleDefault as WebPlugin;
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** The one title a failed plugin gets, whichever half of it failed. */
/**
 * The name to DRAW for one manifest row, resolved once per plugin (S38 step 11).
 *
 * The wire carries what the author wrote — a string or `{ en, ru }` — because the server does not
 * know the app's language. This is the one place it becomes a string, and everything downstream
 * (the registry, the seams, the tab strip, the composer sections, the status record) keeps the
 * plain `string` it has always had.
 *
 * An empty or undrawable one falls back to the plugin ID: a plugin can never be nameless on screen,
 * and the id is the thing its folder is called, which is what a person would go looking for.
 */
const displayNameOfManifest = (manifest: {
  readonly id: string;
  readonly name: unknown;
}): string => {
  const resolved = localizedText(manifest.name, getLocale());
  return resolved === "" ? manifest.id : resolved;
};

const failedToLoadTitle = (name: string): string =>
  L(`Plugin "${name}" failed to load`, `Плагин «${name}» не загрузился`);

/** The failure a hanging plugin produces — its own type so it reads clearly in a status and a toast. */
export class PluginLoadTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${String(ms)}ms`);
    this.name = "PluginLoadTimeout";
  }
}

/** A promise that rejects once `ms` have passed. Never resolves. */
function rejectAfter(ms: number, signal: { cancel: () => void }): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new PluginLoadTimeoutError(ms));
    }, ms);
    signal.cancel = () => {
      clearTimeout(handle);
    };
  });
}

/**
 * Race one plugin's whole import+activate against the budget.
 *
 * The timer is cleared on settle so a fast plugin does not hold a 10 s handle open. A timed-out
 * plugin's promise is abandoned, not cancelled — there is no way to cancel a running `activate()` —
 * but its status is already `failed` and everything it can still touch is its own.
 */
async function withTimeout<A>(work: () => Promise<A>, ms: number): Promise<A> {
  const signal = { cancel: () => {} };
  try {
    return await Promise.race([work(), rejectAfter(ms, signal)]);
  } finally {
    signal.cancel();
  }
}

export async function loadPlugins(
  options: LoadPluginsOptions = {},
): Promise<Exclude<PluginLoadPass, "pending">> {
  // V2-27: the outcome is announced from a `finally`, so every exit below — no `manifests.json`, an
  // unreachable server, a payload that does not decode, a throw, and the ordinary end — says
  // something to a consumer rather than leaving it waiting. A consumer that DELETES state for a
  // plugin that is not contributing needs that; before it, the right panel's reconcile closed a
  // restored plugin tab a second before its plugin loaded.
  //
  // S15 A1: and it needs more than "finished". The three early returns below end the pass without
  // ever having READ a plugin list, so the empty registry they leave behind is not evidence that a
  // plugin is gone — it is the absence of evidence. `"read"` is returned only past the decode, and
  // only `"read"` licenses a deletion. The `finally` also covers the throw path: if the pass dies
  // anywhere, the outcome stays `"unreadable"` and nothing downstream deletes on it.
  //
  // RETURNED as well as published, so the outcome is part of this function's own contract and can
  // be proved without reaching into the registry for it (`loadPlugins.test.ts`). `main.tsx` calls
  // this with `void` and does not care.
  let outcome: Exclude<PluginLoadPass, "pending"> = "unreadable";
  try {
    outcome = await loadPluginsPass(options);
  } finally {
    markPluginsPass(outcome);
  }
  return outcome;
}

async function loadPluginsPass(
  options: LoadPluginsOptions,
): Promise<Exclude<PluginLoadPass, "pending">> {
  const fetchManifests = options.fetchManifests ?? ((url: string) => fetch(url));
  const appendStylesheet = options.appendStylesheet ?? defaultAppendStylesheet;
  const importModule =
    options.importModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<unknown>);
  const timeoutMs = options.timeoutMs ?? PLUGIN_LOAD_TIMEOUT_MS;

  let payload: unknown;
  try {
    const response = await fetchManifests(MANIFESTS_URL);
    if (!response.ok) {
      // 404 is the normal answer on a deployment with no plugins dir — not worth a toast.
      console.info(`[plugins] ${MANIFESTS_URL} → ${String(response.status)}; no plugins loaded`);
      return "unreadable";
    }
    payload = await response.json();
  } catch (error) {
    console.info(`[plugins] ${MANIFESTS_URL} unreachable (${describe(error)}); no plugins loaded`);
    return "unreadable";
  }

  const decoded = decodeManifests(payload);
  if (Option.isNone(decoded)) {
    console.warn(`[plugins] ${MANIFESTS_URL} did not match WebManifestList; no plugins loaded`);
    return "unreadable";
  }

  // CONCURRENT: one plugin's 10 s hang must not push the next plugin's page 10 s further out. Each
  // task records ITS OWN status the moment it settles — a hanging plugin no longer hides the
  // healthy ones' diagnostics for the rest of its budget — and passes its manifest index `order` to
  // BOTH sinks, so the status list and the loaded-plugin registry read back in manifest order
  // rather than completion order. (Until S5 only the status list did; every rendered surface —
  // composer sections, footer entries, `[data-plugin-root]` — took whatever order the activates
  // happened to settle in. S4-parity §2.2 caught it.)
  await Promise.all(
    decoded.value.map(async (manifest, order): Promise<void> => {
      const record = (status: WebPluginStatus) => {
        recordPluginStatus(status, order);
      };
      const displayName = displayNameOfManifest(manifest);
      recordPluginDisplayName(manifest.id, displayName);

      if (manifest.state !== "loaded" || !manifest.hasWeb) {
        // A plugin the SERVER refused — a throwing activate, a failed migration, a manifest that
        // did not decode, a `shared` major mismatch — used to be completely silent in the UI. To a
        // user, a server failure and a web failure are the same event: "I dropped in a plugin and
        // it is not there". `state === "loaded" && !hasWeb` is NOT a failure — it is a server-only
        // plugin working exactly as intended — and stays silent.
        if (manifest.state !== "loaded") {
          reportPluginProblem({
            kind: "error",
            pluginId: manifest.id,
            code: "load-failed",
            title: failedToLoadTitle(displayName),
            ...(manifest.error === undefined ? {} : { detail: manifest.error }),
          });
        }
        record({
          id: manifest.id,
          name: displayName,
          version: manifest.version,
          state: manifest.state === "loaded" ? "skipped" : manifest.state,
          ...(manifest.error === undefined ? {} : { error: manifest.error }),
        });
        return;
      }

      // OUTSIDE the race: the ctx is a plain object of closures and nothing it holds runs until a
      // seam is called, so building it cannot be what times out.
      const ctx = makeWebCtx({ id: manifest.id, name: displayName });
      try {
        if (manifest.styles !== undefined) {
          appendStylesheet(`/plugins/${manifest.id}/${manifest.styles}`);
        }
        const entry = resolveWebEntryPath(manifest);
        await withTimeout(async () => {
          // The URL is only known at runtime, so Vite must not resolve or bundle it — the whole
          // point is that this module did not exist when the app was built.
          const module = await importModule(`/plugins/${manifest.id}/${entry}`);
          const plugin = resolveWebPlugin((module as { default?: unknown }).default);
          if (plugin === null) {
            throw new TypeError("web entry has no default export object");
          }
          // `activate` FIRST, and only then registered: a plugin whose lifecycle threw or hung is
          // `failed`, and a failed plugin contributes nothing — the same rule the server half
          // applies to `sessions` and `rpc`. `activate` is optional (V2-2); a plugin without one
          // is registered immediately.
          await plugin.activate?.(ctx);
          addLoadedPlugin({ id: manifest.id, name: displayName, order, plugin, ctx });
        }, timeoutMs);
        record({
          id: manifest.id,
          name: displayName,
          version: manifest.version,
          state: "loaded",
        });
      } catch (error) {
        // Per plugin: every other plugin still loads, so one bad plugin never costs the others.
        const detail = describe(error);
        reportPluginProblem({
          kind: "error",
          pluginId: manifest.id,
          code: "load-failed",
          title: failedToLoadTitle(displayName),
          detail,
        });
        record({
          id: manifest.id,
          name: displayName,
          version: manifest.version,
          state: "failed",
          error: detail,
        });
      }
    }),
  );

  // S15 A1: past the decode, so the list WAS read. Every plugin in it has now loaded, failed, timed
  // out or been skipped — each task above records its own status before settling, and none of them
  // rethrows — so "absent from the registry" is from here on a fact about the plugin rather than a
  // fact about the loader.
  return "read";
}
