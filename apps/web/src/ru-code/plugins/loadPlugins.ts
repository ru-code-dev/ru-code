// ru-code: the web half of the plugin loader (mvp-plan §1.4).
//
// Boot order (main.tsx): `import "./index.css"` → `createRoot(...).render(...)` →
// `void loadPlugins()`. Plugins load AFTER the first paint and NEVER block it (A4 finding
// H2/M2): the earlier design awaited this function before `createRoot`, which let a plugin
// whose `activate()` never settles white-screen the app permanently. The registries a plugin
// writes into are reactive now (`useOverlayPanels()`, the composer item store), so a panel or
// a composer item that lands a moment after first paint simply appears.
//
// Failure posture (mvp-plan guardrail 8): missing ⇒ empty, malformed ⇒ skip + log, a plugin
// that throws ⇒ that plugin disabled, a plugin that HANGS ⇒ that plugin disabled after
// `PLUGIN_LOAD_TIMEOUT_MS`. `loadPlugins()` never rejects. Plugins are loaded concurrently:
// one slow plugin must not delay the others, and the timeout is per plugin, not per batch.

import { WebManifestList } from "@smart-tools/plugin-sdk/contracts";
import type { WebPluginDefinition, WebPluginHost } from "@smart-tools/plugin-sdk/host";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { L } from "@ru-code/localization";

import { installPluginComposerPort } from "./composerRegistry";
import { makeWebPluginHost } from "./hostApi";
import { reportPluginProblem } from "./problems";
import { installPluginRpcPort } from "./rpcPort";
import { recordPluginStatus, type WebPluginStatus } from "./status";

/** `GET /plugins/manifests.json` — served by `apps/server` (A2), same origin. */
const MANIFESTS_URL = "/plugins/manifests.json";

/**
 * The default web entry, used when the status declares no `web` path at all — mvp-plan §1.1
 * fixes the folder layout at `web/index.mjs`, so it is the right default and A2's route
 * (`GET /plugins/:id/web/*`) serves it.
 */
const WEB_ENTRY_PATH = "web/index.mjs";

/**
 * Per-plugin budget for import + activate, together (A4 finding H2).
 *
 * A plugin that never settles is at least as likely as one that throws — an `await fetch(...)`
 * to a dead endpoint, an unresolved lock — and it used to take the whole app with it. Ten
 * seconds is generous for a local `import()` of a bundled module and short enough that the
 * status settles while the user is still looking at the boot.
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
 * Where this plugin's web entry lives (A4 finding M3).
 *
 * `PluginManifest.web` may name any relative path, but `PluginStatus` originally carried only
 * `hasWeb: boolean` — so a manifest pointing anywhere other than `web/index.mjs` was
 * advertised as loadable and then 404'd, and the toast blamed the plugin for a host-contract
 * gap. The SDK carries `web?: string` on the status since A5 and the server fills it, so the
 * DECODED status is the one and only source; the fixed layout is the fallback for a plugin
 * that declares no `web` at all. (A7 finding L5: the raw-payload fallback this function used
 * to carry only served a server built before the SDK field existed — impossible here, where
 * the app and the SDK ship from the same build.)
 *
 * The candidate is containment-checked here as well as on the server (the `assetUrl`
 * posture): the path becomes a URL under this plugin's own prefix, and a `..` in it would
 * aim that URL at another plugin's folder.
 */
export function resolveWebEntryPath(status: { readonly web?: unknown }): string {
  return containedRelativePath(status.web) ?? WEB_ENTRY_PATH;
}

/** What `activate` may be: the SDK's definition object, or a bare function. */
type PluginActivate = (host: WebPluginHost) => void | Promise<void>;

export interface LoadPluginsOptions {
  /**
   * How a plugin's web entry is imported. Injected so tests can drive the loader without a
   * server: production passes the real dynamic `import()` below.
   */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Injected for tests; production uses the page's `fetch`. */
  readonly fetchManifests?: (url: string) => Promise<Response>;
  /** Injected for tests; production appends to `document.head`. */
  readonly appendStylesheet?: (href: string) => void;
  /** Per-plugin import+activate budget; defaults to `PLUGIN_LOAD_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

const decodeManifests = Schema.decodeUnknownOption(WebManifestList);

/**
 * The marker that tells a plugin's `<link>` apart from the app's own stylesheets.
 *
 * Exported so the insertion rule below and its test agree on one string, and so anything else that
 * ever needs to find (or remove) the plugin sheets has a selector rather than a URL heuristic.
 */
export const PLUGIN_STYLESHEET_ATTRIBUTE = "data-ru-code-plugin-styles";

/** The shape {@link findAppStylesheet} needs — a `<head>` child, and nothing else. */
type HeadChild = {
  readonly tagName: string;
  getAttribute(name: string): string | null;
};

/**
 * The first node in `<head>` the APP itself paints with: a `<link rel="stylesheet">` in a
 * production build, a `<style>` under Vite's dev server. Sheets this loader inserted carry
 * {@link PLUGIN_STYLESHEET_ATTRIBUTE} and are skipped, so plugins keep their relative order and
 * every one of them still lands before the app's first sheet.
 *
 * Exported because this — not the `insertBefore` call — is the rule A18 finding H2 is about, and a
 * rule stated as a CSS selector string is a rule no test can hold.
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
 * Insert a plugin stylesheet BEFORE the app's own (A18 finding H2).
 *
 * This used to be `document.head.appendChild(link)`, and it removed the app's sidebar. A plugin
 * sheet is a global `<link>` in the app's document — it is not scoped to the plugin's markup — and
 * a plugin built by the SDK's Tailwind step used to emit its utilities into `@layer utilities`,
 * which is the name the APP's Tailwind uses too. Inside one shared layer the plugin's
 * `.hidden{display:none}` and the app's `@media(width>=48rem){.md\:block{display:block}}` have the
 * same specificity, so the only tie-breaker left is SOURCE ORDER — and appending handed every one
 * of those fights to the plugin. Measured: with the analytics plugin installed,
 * `[data-slot="sidebar"]` computed `display:none` and the whole footer nav — including the button
 * that opens the plugin's own panel — disappeared.
 *
 * So the plugin's sheet goes FIRST, before the first thing the app itself emitted (a `<link>` in a
 * production build, a `<style>` under Vite's dev server). Within a shared layer the app now wins,
 * and the SDK's half of the same fix moves a plugin's utilities into an `@layer plugin` declared
 * in that sheet — which, because the sheet is first, is ordered below every layer the app declares
 * afterwards.
 *
 * What this is NOT is a sandbox (README §11 says so). Ordering cannot beat higher specificity,
 * `!important`, or an UNLAYERED rule in a plugin sheet — unlayered declarations outrank every
 * layered one wherever the sheet sits, and the app's utilities are layered. A plugin that ships
 * hand-written CSS still has to prefix its selectors.
 *
 * Plugins keep their relative order: each new sheet is inserted before the app's first sheet, i.e.
 * after the plugin sheets already there.
 */
function defaultAppendStylesheet(href: string): void {
  // Once per href: two plugins can legitimately be reloaded in one session (tests), and a
  // duplicate <link> would re-apply the same rules and double any transition.
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

/** Pull `activate` out of whatever the plugin's module default turned out to be. */
export function resolveActivate(moduleDefault: unknown): PluginActivate | null {
  if (typeof moduleDefault === "function") {
    return moduleDefault as PluginActivate;
  }
  if (typeof moduleDefault === "object" && moduleDefault !== null) {
    const activate = (moduleDefault as Partial<WebPluginDefinition>).activate;
    if (typeof activate === "function") {
      return activate.bind(moduleDefault) as PluginActivate;
    }
  }
  return null;
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The one title a failed plugin gets, whichever half of it failed (A9 finding MEDIUM-1).
 *
 * Shared by the web-side `catch` below and the server-side branch above it so the two paths
 * cannot drift into two different sentences for the same user-visible event.
 */
const failedToLoadTitle = (name: string): string =>
  L(`Plugin "${name}" failed to load`, `Плагин «${name}» не загрузился`);

/** A promise that rejects with `TimeoutError` once `ms` have passed. Never resolves. */
function rejectAfter(ms: number, signal: { cancel: () => void }): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new PluginLoadTimeoutError(ms));
    }, ms);
    signal.cancel = () => clearTimeout(handle);
  });
}

/** The failure a hanging plugin produces (A4 finding H2) — its own type so it reads clearly
 *  in `PluginStatus.error` and in the toast. */
export class PluginLoadTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "PluginLoadTimeout";
  }
}

/**
 * Race one plugin's whole import+activate against the budget.
 *
 * The timer is cleared on settle so a fast plugin does not hold a 10 s handle open (and so a
 * test does not have to wait for one). A timed-out plugin's promise is abandoned, not
 * cancelled — there is no way to cancel a running `activate()` — but its `recordPluginStatus`
 * already happened as `failed`, and everything it can still touch is per-plugin state.
 */
async function withTimeout<A>(work: () => Promise<A>, ms: number): Promise<A> {
  const signal = { cancel: () => {} };
  try {
    return await Promise.race([work(), rejectAfter(ms, signal)]);
  } finally {
    signal.cancel();
  }
}

export async function loadPlugins(options: LoadPluginsOptions = {}): Promise<void> {
  // The composer + RPC seams are installed here rather than at module scope: this is the one
  // function the app's entry actually calls, so the binding cannot be tree-shaken away and
  // its ordering (before any `activate(host)`) is obvious. Both are idempotent.
  installPluginComposerPort();
  installPluginRpcPort();

  const fetchManifests = options.fetchManifests ?? ((url: string) => fetch(url));
  const appendStylesheet = options.appendStylesheet ?? defaultAppendStylesheet;
  const importModule =
    options.importModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<unknown>);
  const timeoutMs = options.timeoutMs ?? PLUGIN_LOAD_TIMEOUT_MS;

  let payload: unknown;
  try {
    const response = await fetchManifests(MANIFESTS_URL);
    if (!response.ok) {
      // 404 is the normal answer on a build whose server predates the plugin routes, and on
      // any deployment with no plugins dir — not worth a toast, and never a throw.
      console.info(`[plugins] ${MANIFESTS_URL} → ${response.status}; no plugins loaded`);
      return;
    }
    payload = await response.json();
  } catch (error) {
    console.info(`[plugins] ${MANIFESTS_URL} unreachable (${describe(error)}); no plugins loaded`);
    return;
  }

  const decoded = decodeManifests(payload);
  if (Option.isNone(decoded)) {
    console.warn(`[plugins] ${MANIFESTS_URL} did not match WebManifestList; no plugins loaded`);
    return;
  }
  // CONCURRENT (A4 finding H2): one plugin's 10 s hang must not push the next plugin's panel
  // 10 s further out. `Promise.all` over a per-plugin task that never rejects, so the whole
  // call settles when the slowest plugin settles or times out. Each task records ITS OWN
  // status the moment it settles (A7 finding L2) — a hanging plugin no longer hides the
  // healthy ones' diagnostics for the rest of its budget — and passes its manifest index, so
  // `getPluginStatuses()` still reads back in manifest order rather than completion order.
  await Promise.all(
    decoded.value.map(async (manifest, order): Promise<void> => {
      const record = (status: WebPluginStatus) => recordPluginStatus(status, order);
      if (manifest.state !== "loaded" || !manifest.hasWeb) {
        // ru-code (A9 finding MEDIUM-1): a plugin the SERVER refused — a throwing server
        // `activate`, a failed migration, a manifest that did not decode — used to be
        // completely silent in the UI: no toast, no console line, the reason readable only by
        // hand-fetching `/plugins/manifests.json`. A web-side failure has always toasted (the
        // `catch` below), and to a user the two are the same event: "I dropped in a plugin and
        // it is not there". So both halves report, with the same title and the server's own
        // `error`/reason as the detail. `state === "loaded" && !hasWeb` is NOT a failure — it
        // is a server-only plugin working exactly as intended — and stays silent.
        if (manifest.state !== "loaded") {
          reportPluginProblem({
            kind: "error",
            pluginId: manifest.id,
            code: "load-failed",
            title: failedToLoadTitle(manifest.name),
            ...(manifest.error === undefined ? {} : { detail: manifest.error }),
          });
        }
        record({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          state: manifest.state === "loaded" ? "skipped" : manifest.state,
          ...(manifest.error === undefined ? {} : { error: manifest.error }),
        });
        return;
      }

      // OUTSIDE the race (A7 finding L3): building the host is what records the plugin's
      // display name, and a plugin that times out mid-`import()` used to never record one —
      // so anything it did manage to register was labelled with its raw id. The host is a
      // plain object of closures; nothing it builds runs until `activate(host)` does.
      const { host } = makeWebPluginHost({ id: manifest.id, name: manifest.name });
      try {
        if (manifest.styles !== undefined) {
          appendStylesheet(`/plugins/${manifest.id}/${manifest.styles}`);
        }
        const entry = resolveWebEntryPath(manifest);
        await withTimeout(async () => {
          // The URL is only known at runtime, so Vite must not try to resolve or bundle it —
          // the whole point is that this module did not exist when the app was built (D9/D13).
          const module = await importModule(`/plugins/${manifest.id}/${entry}`);
          const activate = resolveActivate((module as { default?: unknown }).default);
          if (activate === null) {
            throw new TypeError("web entry has no default export with an activate(host) function");
          }
          await activate(host);
        }, timeoutMs);
        record({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          state: "loaded",
        });
      } catch (error) {
        // Per-plugin: every other plugin still loads, so one bad plugin never costs the
        // others (the `demo-broken` fixture beside `demo` is exactly this case).
        const detail = describe(error);
        reportPluginProblem({
          kind: "error",
          pluginId: manifest.id,
          code: "load-failed",
          title: failedToLoadTitle(manifest.name),
          detail,
        });
        record({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          state: "failed",
          error: detail,
        });
      }
    }),
  );
}
