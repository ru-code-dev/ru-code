// ru-code v2 (V2-33): the request store behind `ctx.pickFolder` — a promise a plugin awaits, a
// state the app's command palette renders, and the answer that joins them.
//
// MODELLED ON `apps/web/src/confirmDialog.ts`, the app's own promise-returning dialog: a request
// becomes the ACTIVE one or waits in a queue; the host component (the palette's `folder` mode,
// `FolderPickerPalette.tsx`) subscribes, shows the active request, and answers it; a request made
// while no host is mounted resolves at once. Where it differs, and why:
//
//   · the answer is `string | null`, not a boolean — the absolute path the user chose, or `null`
//     for every way of not choosing (Esc, the backdrop, the palette leaving folder mode, the host
//     unmounting). A plugin gets exactly ONE of those and nothing else (rule 10);
//   · a request with no host resolves `null` rather than `undefined`: "cancelled" is the honest
//     answer, and the SDK contract promises no third value;
//   · there is no `closing` state: the palette is a dialog the app already animates, so the store
//     only knows "showing this request" and "idle".
//
// Everything a plugin can observe is the promise. The `pluginId` on a request is for the host's
// own diagnostics and for the CAP below — the picker itself is the same for every plugin.
//
// CAPPED (S26 A2), like every other plugin-facing surface (`caps.ts`): ONE pending request per
// plugin, active or queued. A button with no in-flight guard clicked five times, or a loop, would
// otherwise queue five pickers that take five Escs to drain and re-open over ⌘K each time; the
// excess is answered `null` at once and the plugin is told once through the problem channel.

import { L } from "@ru-code/localization";

import { reportPluginProblem } from "./problems";

/** What the palette's folder mode renders. `null` = nothing pending. */
export interface FolderPickRequest {
  readonly pluginId: string;
  /** The folder to open on — a HINT the plugin passed, already validated; `undefined` = home. */
  readonly start: string | undefined;
}

interface PendingFolderPick extends FolderPickRequest {
  readonly resolve: (path: string | null) => void;
}

let active: PendingFolderPick | null = null;
let queued: PendingFolderPick[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();
/** The snapshot `useSyncExternalStore` compares: replaced, never mutated. */
let snapshot: FolderPickRequest | null = null;

function publish(): void {
  snapshot = active === null ? null : { pluginId: active.pluginId, start: active.start };
  for (const listener of listeners) listener();
}

/** Non-reactive read. */
export function readFolderPickRequest(): FolderPickRequest | null {
  return snapshot;
}

export function subscribeFolderPick(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The host component announces itself. The returned cleanup also cancels every request left
 * without a host — a plugin awaiting a picker nobody can show must not wait forever.
 */
export function registerFolderPickerHost(): () => void {
  registeredHostCount += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);
    if (registeredHostCount === 0) cancelEveryFolderPick();
  };
}

/**
 * `ctx.pickFolder` (V2-33). Resolves with the absolute path the user chose, or `null`.
 *
 * ONE AT A TIME: a request made while another plugin's is showing waits its turn, in order — the
 * same rule `requestConfirmDialog` has, and the one the SDK documents. ONE PER PLUGIN: a second
 * request from the plugin that already has one pending is answered `null` at once (S26 A2).
 */
export function requestFolderPick(
  pluginId: string,
  start: string | undefined,
): Promise<string | null> {
  if (registeredHostCount === 0) return Promise.resolve(null);
  if (active?.pluginId === pluginId || queued.some((pending) => pending.pluginId === pluginId)) {
    reportPluginProblem({
      kind: "error",
      pluginId,
      code: "cap:pickFolder",
      title: L(
        `Plugin "${pluginId}" asked for a folder picker while one is already pending`,
        `Плагин «${pluginId}» запросил выбор папки, пока предыдущий запрос ещё открыт`,
      ),
      detail: L(
        "one pending `pickFolder` per plugin; the extra call is answered `null`",
        "один незавершённый `pickFolder` на плагин; лишний вызов получает `null`",
      ),
    });
    return Promise.resolve(null);
  }
  return new Promise<string | null>((resolve) => {
    const pending: PendingFolderPick = { pluginId, start, resolve };
    if (active !== null) {
      queued.push(pending);
      return;
    }
    active = pending;
    publish();
  });
}

/**
 * The host's answer to the ACTIVE request: a path, or `null` for a cancel. The next queued request
 * (if any) becomes active at once. A no-op with nothing active — the palette may report a cancel
 * for a request the host cleanup already answered.
 */
export function respondToFolderPick(path: string | null): void {
  if (active === null) return;
  const answered = active;
  active = queued.shift() ?? null;
  answered.resolve(path);
  publish();
}

/** Cancel everything — the host went away. */
function cancelEveryFolderPick(): void {
  const all = active === null ? queued : [active, ...queued];
  active = null;
  queued = [];
  for (const pending of all) pending.resolve(null);
  publish();
}

/** Test seam — module singletons, like the registry and the signals. */
export function resetFolderPickerForTests(): void {
  cancelEveryFolderPick();
  registeredHostCount = 0;
  listeners.clear();
}
