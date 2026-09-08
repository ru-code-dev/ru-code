// ru-code: plugin-originated toasts queued BEFORE the toaster exists, shown once it does.
//
// A toast manager with no subscriber DROPS the message: base-ui's `createToastManager()` emits to a
// `Set` of listeners and `<Toast.Provider>` joins that set from a `useEffect` — nothing is buffered.
// So "has React mounted the toast viewport yet" is the only safe gate, and a plugin failure is
// exactly the message that must not be lost.
//
// A13 (A10 finding P1). The previous version let `flushPluginProblems()` set `viewportReady = true`
// itself, immediately after `ReactDOM.createRoot(...).render(...)` in `main.tsx`. `render()` is
// asynchronous: React had not committed, `<Toast.Provider>` had not subscribed, and every problem
// reported in the next few milliseconds — i.e. every SERVER-side plugin failure, which
// `loadPlugins()` reports as soon as `manifests.json` arrives, and every web failure raised in the
// first pass — took the "show now" path into a manager with no listener and vanished. Measured
// three times by A10: the hanging plugin's toast (reported ~10.9 s in) rendered; the throwing
// plugin's (reported within milliseconds of boot) never did.
//
// The flag is therefore owned by the TOASTER, not by the entry point:
// `markPluginToastViewportReady()` is called from `ToastProvider`'s own mount effect
// (`components/ui/toast.tsx`), which is a PARENT of `<Toast.Provider>` — and React runs child
// effects before parent effects, so by the time it fires the manager's subscription is in place.
// `flushPluginProblems()` now AWAITS that signal instead of forging it; until it arrives everything
// queues, and `console.error` (below) is the channel that never depended on React at all.
//
// The toast module is imported LAZILY: `toast.tsx` pulls in base-ui's toast, the router and the
// composer draft store, and the loader must not drag those into the boot path just in case.
//
// ru-code (A13 round 3, A12 finding R3-H4): THE REPORT STORM.
//
// Round 2 gave every malformed registration its own report, and the report ran BEFORE the R1-M5
// cap. 300 invalid `registerPanel` calls therefore produced 600 toasts and the tab STOPPED
// ANSWERING — `page.evaluate("1+1")` timed out at 20 s and no screenshot could be taken — where a
// THOUSAND well-formed registrations were capped and booted in 1865 ms. The one failure mode a
// user cannot even report was reachable from a `for` loop with a typo in it.
//
// So the de-duplication moved DOWN here, where every plugin message passes, and is keyed by
// `(pluginId, code)`: `code` is the problem's CATEGORY — `panel-invalid`, `composer-overflow`,
// `render:icon` — supplied by the host at the call site. The first occurrence gets its toast and
// its console line; every further one only increments a counter that {@link getPluginProblemRepeats}
// hands to diagnostics. Nothing is lost that a human would read: the second identical toast for the
// same plugin and the same category says exactly what the first one said.
//
// WHY `code` IS NOT `kind`. `kind` is the toast's SEVERITY (success/error/info) and a plugin's own
// `host.toast.success(...)` uses it: de-duplicating on severity would show the demo plugin's first
// «Заметка добавлена» and silently swallow every note it added afterwards. Host-generated problems
// therefore all carry a `code`; a plugin's own toasts carry none and are instead bounded by
// {@link MAX_PLUGIN_TOASTS} per plugin per page load, so a `for` loop of `host.toast.error(...)`
// cannot wedge the queue either.

import { L } from "@ru-code/localization";

export type PluginToastKind = "success" | "error" | "info";

export interface PluginProblem {
  readonly kind: PluginToastKind;
  readonly pluginId: string;
  readonly title: string;
  readonly detail?: string;
  /**
   * The problem's CATEGORY, supplied by the host (R3-H4). One toast and one console line per
   * `(pluginId, code)`; everything after that is counted only. Omitted by a plugin's own
   * `host.toast.*`, which is bounded by {@link MAX_PLUGIN_TOASTS} instead.
   */
  readonly code?: string;
}

/** A plugin's own toasts, per page load. High enough that no honest plugin can reach it. */
export const MAX_PLUGIN_TOASTS = 50;

const pending: PluginProblem[] = [];
let viewportReady = false;

/** `<pluginId>:<code>` → how many times it has been reported (R3-H4). */
const reportCounts = new Map<string, number>();
/** How many un-coded (plugin-authored) toasts each plugin has raised. */
const toastCounts = new Map<string, number>();

let signalViewportReady: () => void = () => {};
let viewportReadyPromise = new Promise<void>((resolve) => {
  signalViewportReady = resolve;
});

/** Serialises drains so a message reported mid-drain still lands after the ones before it. */
let draining: Promise<void> = Promise.resolve();

async function showNow(problem: PluginProblem): Promise<void> {
  const { stackedThreadToast, toastManager } = await import("~/components/ui/toast");
  toastManager.add(
    stackedThreadToast({
      type: problem.kind,
      title: problem.title,
      ...(problem.detail === undefined ? {} : { description: problem.detail }),
    }),
  );
}

function scheduleDrain(): void {
  draining = draining.then(async () => {
    const problems = pending.splice(0, pending.length);
    for (const problem of problems) {
      // A toast module that will not load (an embedder without it, a chunk that 404s) must not
      // become an unhandled rejection on the boot path — the console line above already ran.
      await showNow(problem).catch((error: unknown) => {
        console.warn(`[plugins] could not show a plugin message: ${String(error)}`);
      });
    }
  });
}

/**
 * The R3-H4 gate: is this message the FIRST of its kind for this plugin?
 *
 * A coded (host-generated) problem is admitted once per `(pluginId, code)`; the rest are counted.
 * An un-coded (plugin-authored) toast is admitted until the plugin has spent its budget, and the
 * ceiling itself is announced once — through the coded path, so it cannot storm either.
 */
function admit(problem: PluginProblem): boolean {
  const { code, pluginId } = problem;
  if (code !== undefined) {
    const key = `${pluginId}:${code}`;
    const seen = reportCounts.get(key) ?? 0;
    reportCounts.set(key, seen + 1);
    return seen === 0;
  }
  const raised = toastCounts.get(pluginId) ?? 0;
  toastCounts.set(pluginId, raised + 1);
  if (raised < MAX_PLUGIN_TOASTS) return true;
  if (raised === MAX_PLUGIN_TOASTS) {
    reportPluginProblem({
      kind: "error",
      pluginId,
      code: "toast-ceiling",
      title: L(
        `Plugin "${pluginId}" raised too many toasts`,
        `Плагин «${pluginId}» показал слишком много уведомлений`,
      ),
      detail: L(
        `at most ${String(MAX_PLUGIN_TOASTS)} toasts per plugin per page load; the rest are ignored`,
        `не более ${String(MAX_PLUGIN_TOASTS)} уведомлений на плагин за загрузку страницы; остальные игнорируются`,
      ),
    });
  }
  return false;
}

/** How often each `(pluginId, code)` was reported — the counter behind the one toast (R3-H4). */
export function getPluginProblemRepeats(): ReadonlyMap<string, number> {
  return reportCounts;
}

/**
 * Queue (or, once the toaster has mounted, show) one plugin message.
 * Never throws and never touches the DOM itself — a plugin problem must not become a second
 * failure inside the host (mvp-plan guardrail 8).
 */
export function reportPluginProblem(problem: PluginProblem): void {
  if (!admit(problem)) return;
  if (problem.kind === "error") {
    // The app has no logger abstraction; the console is the seam every other boot path uses.
    console.error(
      `[plugins] ${problem.pluginId}: ${problem.title}${problem.detail === undefined ? "" : ` — ${problem.detail}`}`,
    );
  }
  pending.push(problem);
  if (viewportReady) {
    scheduleDrain();
  }
}

/** Non-destructive read, for tests and diagnostics. */
export function getPendingPluginProblems(): readonly PluginProblem[] {
  return pending;
}

/** Test seam. */
export function resetPluginProblems(): void {
  pending.length = 0;
  reportCounts.clear();
  toastCounts.clear();
  viewportReady = false;
  draining = Promise.resolve();
  viewportReadyPromise = new Promise<void>((resolve) => {
    signalViewportReady = resolve;
  });
}

/**
 * Called by the toast viewport itself, from a mount effect, once base-ui's provider is subscribed.
 * Idempotent — remounts (a router transition, StrictMode's double effect) are ordinary.
 */
export function markPluginToastViewportReady(): void {
  if (viewportReady) return;
  viewportReady = true;
  signalViewportReady();
  scheduleDrain();
}

/**
 * Drain the queue into toasts, WAITING for the toaster to mount first.
 *
 * `main.tsx` calls this once beside `loadPlugins()`. It resolves when everything queued up to the
 * mount has been handed to the manager; if an embedder never mounts a toast viewport it simply
 * never resolves and the messages stay queued (and logged), which is strictly better than handing
 * them to a manager nobody is listening to.
 */
export async function flushPluginProblems(): Promise<void> {
  await viewportReadyPromise;
  scheduleDrain();
  await draining;
}
