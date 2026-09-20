// ru-code v2: the `WebCtx` every web seam receives (architecture.md §2.1).
//
// Plain values, signals and functions — no app component, no app hook, no app store, no wire
// format. v1's `WebPluginHost` carried five registration methods and five host HOOKS; all ten are
// gone. What is left is what only the app can supply: a call into this plugin's own server half, a
// toast in the app's stack, closing this plugin's own panel, a URL for a file the plugin shipped,
// and six watchable values.
//
// Everything here is bound to ONE plugin. There is no argument a plugin can pass to reach another.

import type {
  InvalidateSeam,
  PickFolderOptions,
  ToastKind,
  WebCtx,
} from "@smart-tools/plugin-sdk/host";
import { L } from "@ru-code/localization";

import {
  CONTROL_OR_FORMAT,
  INVALIDATE_SEAMS,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  isDisplayString,
  isInvalidateSeam,
} from "./caps";
import { pluginConnectionSignal } from "./connectionAtom";
import { requestFolderPick } from "./folderPicker";
import { invalidatePluginSeam } from "./invalidations";
import { reportPluginProblem } from "./problems";
import { makePluginInvoke } from "./rpcPort";
import { makePluginQuery } from "./query";
import { makePluginState } from "./state";
import {
  activeProjectSignal,
  composerTargetSignal,
  localeSignal,
  projectsSignal,
  providerSignal,
  readonlySignal,
  themeSignal,
} from "./signals";
import { closePluginPanel } from "./slots";
import { makePluginComposer } from "./composerAttach";

/**
 * `/plugins/<id>/<rel>` — the route the server serves plugin files from.
 *
 * Containment is enforced here as well as on the server (defence in depth): a `..` segment, a
 * leading `/` and a NUL are all refused, so a plugin cannot mint a URL that walks out of its own
 * folder even if the route ever regresses. A leading slash THROWS rather than being stripped —
 * `assetUrl("/etc/passwd")` quietly becoming `/plugins/<id>/etc/passwd` gave an author the
 * opposite of the documented behaviour, which is how a real traversal attempt goes unnoticed.
 */
export function pluginAssetUrl(pluginId: string, rel: string): string {
  const rejected =
    typeof rel !== "string" ||
    rel === "" ||
    rel.startsWith("/") ||
    rel.includes("\0") ||
    rel.split("/").some((segment) => segment === ".." || segment === ".");
  if (rejected) {
    throw new Error(
      `[plugins] ${pluginId}: assetUrl(${JSON.stringify(rel)}) is not a contained relative path`,
    );
  }
  return `/plugins/${pluginId}/${rel}`;
}

const TOAST_KINDS: ReadonlySet<string> = new Set(["success", "error", "info"]);

/** The server's own ceiling on a browse path (`packages/contracts/src/filesystem.ts`). */
const MAX_START_PATH_LENGTH = 512;

/**
 * The `start` hint `ctx.pickFolder` opens on, or `undefined` for home.
 *
 * A HINT, so nothing is reported: the contract says an unreadable start opens home, and a start
 * that is not even a usable string — not a string, empty, over the wire's own cap, carrying a
 * control character — is the same thing by another route. The argument arrives from plain
 * JavaScript, so `pickFolder({ start: 42 })` is a call a real author makes.
 */
export function folderPickStart(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const start = (options as PickFolderOptions).start;
  if (typeof start !== "string") return undefined;
  const trimmed = start.trim();
  if (trimmed === "" || trimmed.length > MAX_START_PATH_LENGTH || CONTROL_OR_FORMAT.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Why a `ctx.toast(...)` call is unusable, or `null` when it is fine.
 *
 * NOTHING IS COERCED. `title` and `description` are rendered as React CHILDREN in the app's own
 * toast, outside every plugin boundary — v1 measured `host.toast.error({ toString() {…} })` from
 * `activate()` replacing the entire app with React's crash card, on every boot, with a reload not
 * helping. Substituting the plugin's name would show a toast that lies about what the plugin
 * asked for, so the call is dropped and the author is told once.
 */
export function invalidToastCall(kind: unknown, message: unknown, detail: unknown): string | null {
  if (typeof kind !== "string" || !TOAST_KINDS.has(kind)) return "kind";
  if (!isDisplayString(message, 200)) return "message";
  if (
    detail !== undefined &&
    (typeof detail !== "string" ||
      detail.length > MAX_DESCRIPTION_LENGTH ||
      CONTROL_OR_FORMAT.test(detail))
  ) {
    return "detail";
  }
  return null;
}

/** The console channel a plugin's `ctx.log` writes to, prefixed so a noisy plugin is nameable. */
const makePluginLog = (pluginId: string): WebCtx["log"] => {
  const emit =
    (level: "info" | "warn" | "error") =>
    (message: string, data?: Readonly<Record<string, unknown>>): void => {
      const line = `[plugin:${pluginId}] ${String(message)}`;
      if (level === "error") console.error(line, data ?? "");
      else if (level === "warn") console.warn(line, data ?? "");
      else console.info(line, data ?? "");
    };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
};

/** Build the ctx for one plugin. Pure: nothing here reads or writes app state at call time. */
export function makeWebCtx(plugin: { readonly id: string; readonly name: string }): WebCtx {
  const pluginId = plugin.id;
  return {
    pluginId,
    invoke: makePluginInvoke(pluginId),
    locale: readonlySignal(localeSignal),
    theme: readonlySignal(themeSignal),
    connection: pluginConnectionSignal(),
    activeProject: readonlySignal(activeProjectSignal),
    projects: readonlySignal(projectsSignal),
    provider: readonlySignal(providerSignal),
    log: makePluginLog(pluginId),
    assetUrl: (rel: string) => pluginAssetUrl(pluginId, rel),
    // V2-33 — the HOST's folder picker: the app's command palette in its `folder` mode, browsing
    // the primary environment. One optional string in, one string or `null` out; the plugin never
    // sees the palette, an entry list, an environment id or a wire type.
    pickFolder: (options?: PickFolderOptions) =>
      requestFolderPick(pluginId, folderPickStart(options)),
    // V2-48 — the composer's CONTEXT-CARD seam. Bound to THIS plugin: the ids it writes are
    // namespaced `plugin:<id>:…` on the draft, so it can neither collide with another plugin nor
    // read one. A malformed attachment is DROPPED and reported once, like `toast` and
    // `invalidate` — a throw inside a click handler would cost a surface the plugin got right.
    composer: makePluginComposer({
      pluginId,
      target: readonlySignal(composerTargetSignal),
      report: (code, message) => {
        reportPluginProblem({
          kind: "error",
          pluginId,
          code,
          title: L(
            `Plugin "${plugin.name}" composer attachment was dropped`,
            `Вложение плагина «${plugin.name}» в композер отброшено`,
          ),
          detail: message,
        });
      },
    }),
    // Bound to THIS plugin's id, like everything else here: the argument names one of the plugin's
    // own panels and can address nothing else (V2-15).
    closePanel: (panelId: string) => {
      closePluginPanel(pluginId, panelId);
    },
    // V2-25 — the contribution-changed signal, and the one thing on this ctx that is not about a
    // value: it says "ask me again". Bound to THIS plugin, like everything else here, so a plugin
    // can never force another's surfaces to recompute.
    //
    // NOTHING IS COERCED, exactly as `toast` above: a name outside the four is DROPPED and the
    // author is told once. The argument arrives from plain JavaScript (`web/index.mjs` ships
    // without its types), so `invalidate("panel")` is a typo a real author makes, and a silent
    // no-op would leave them debugging the host.
    invalidate: (seam: InvalidateSeam) => {
      if (!isInvalidateSeam(seam)) {
        reportPluginProblem({
          kind: "error",
          pluginId,
          code: "invalidate-invalid",
          title: L(
            `Plugin "${plugin.name}" invalidated a seam that does not exist`,
            `Плагин «${plugin.name}» сбросил несуществующий шов`,
          ),
          detail: L(
            `invalidate(${JSON.stringify(seam)}) — one of: ${INVALIDATE_SEAMS.join(", ")}`,
            `invalidate(${JSON.stringify(seam)}) — допустимы: ${INVALIDATE_SEAMS.join(", ")}`,
          ),
        });
        return;
      }
      invalidatePluginSeam(pluginId, seam);
    },
    // V2-58 — the plugin's LIVE values, one `Signal` per name, set by the host only when the
    // server's value differs from the one held. Bound to THIS plugin's id, like everything else
    // here; the transport (`caps.ts` `PLUGIN_STATE_TRANSPORT`) is the host's business, not the
    // plugin's. A refused name is an inert signal and one report, never a throw (`state.ts`).
    state: makePluginState(pluginId),
    // V2-59 — a READ the host keeps current: re-run on every reconnect, one in flight, an equal
    // answer a no-op. The rule is the SDK's `makeQueryHost`, written once; `query.ts` only wires
    // this plugin's `invoke`, `ctx.connection` and the problem channel into it.
    query: makePluginQuery(pluginId).query,
    toast: (kind: ToastKind, message: string, detail?: string) => {
      const invalid = invalidToastCall(kind, message, detail);
      if (invalid !== null) {
        reportPluginProblem({
          kind: "error",
          pluginId,
          code: "toast-invalid",
          title: L(
            `Plugin "${plugin.name}" message was dropped`,
            `Сообщение плагина «${plugin.name}» отброшено`,
          ),
          detail: L(
            `invalid toast field: ${invalid} (title ≤ 200 chars, detail ≤ ${String(MAX_DESCRIPTION_LENGTH)}, no control characters; labels elsewhere ≤ ${String(MAX_LABEL_LENGTH)})`,
            `некорректное поле уведомления: ${invalid}`,
          ),
        });
        return;
      }
      reportPluginProblem({
        kind,
        pluginId,
        title: message,
        ...(detail === undefined ? {} : { detail }),
      });
    },
  };
}
