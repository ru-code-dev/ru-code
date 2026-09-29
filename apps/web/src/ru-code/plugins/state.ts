// ru-code S69 (V2-58): the WEB half of the state seam — `ctx.state(name)`.
//
// WHAT A PLUGIN SEES. A `Signal<Json | undefined>` per name: `undefined` until the server half has
// published, then the server's current value, set only when it differs structurally from the value
// held. That is the whole contract.
//
// WHAT THIS FILE OWNS. One CELL per `(plugin, name)` (the SDK's `makeStateCell` — the compare and
// the per-listener throw isolation live there, written once), the per-plugin checks (name, names
// cap), and the one transport (V2-75: the notify transport is gone): one `plugin.state`
// subscription for the whole page, opened by the first `ctx.state` call. Its first frame is a
// snapshot of every plugin's current values; every name this tab holds takes its value from it, or
// `undefined` when the server holds none (a restarted server). Then one frame per change. The client
// runtime re-opens the stream on every new session (`SubscriptionRef.changes(supervisor.session)` +
// `switchMap`), so a reconnect IS a resubscribe, and the snapshot it starts with is the current
// value. No timer, no re-read.
//
// NOTHING HERE IS PER PLUGIN. A plugin's cells are keyed by the id its ctx was built with, so it
// can read only its own names, and a frame for a plugin this tab did not load changes nothing.
//
// AN ANSWER NEVER OVERTAKES THE STATE IT FOLLOWS (S104, V2-73). The server numbers every change its
// hub accepts; an invoke answer carries the hub's position when the handler returned, a snapshot the
// position it was taken at, a `value` frame its floor (`packages/contracts/.../rpc.ts`
// `PluginStatePosition`). `awaitPluginState` — what `rpcPort.ts` awaits before it resolves a
// command — ends when this tab's stream has REACHED the answer's position, so `ctx.state` already
// holds every value published before the answer. What ends each wait, and nothing else does (rule
// 38 — no timer):
//   · a frame whose floor reaches it — the frames the hub owed this tab when it answered, or a
//     latest-wins replacement of one of them, on the same socket;
//   · the next session's snapshot (a reconnect) — at or past it, or from ANOTHER server process
//     (a restart: the process that answered is gone, and its count with it);
//   · the end of the stream it was waiting on (it failed, or its environment went away);
//   · no stream at all in this page — nothing to wait for, resolved at once.

import type { Json, Signal } from "@smart-tools/plugin-sdk/host";
import {
  MAX_STATE_NAMES_PER_PLUGIN,
  isStateName,
  makeStateCell,
  type StateCell,
} from "@smart-tools/plugin-sdk/state";
import { L } from "@ru-code/localization";
import type { PluginStateFrame, PluginStatePosition } from "@t3tools/contracts";
import { PLUGIN_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { reportPluginProblem } from "./problems";

// --------------------------------------------------------------------------
// Problems — once per (plugin, code), the V2-42 channel, never a throw
// --------------------------------------------------------------------------

const reportInvalidName = (pluginId: string, name: unknown): void => {
  reportPluginProblem({
    kind: "error",
    pluginId,
    code: "state-name-invalid",
    title: L(
      `Plugin "${pluginId}" asked for a state name the host will never deliver`,
      `Плагин «${pluginId}» запросил имя состояния, которое хост никогда не доставит`,
    ),
    detail: L(
      `state(${JSON.stringify(name)}) — a name is 1-64 of A-Z a-z 0-9 . _ - and starts with a letter or a digit`,
      `state(${JSON.stringify(name)}) — имя: 1–64 символа A-Z a-z 0-9 . _ - и начинается с буквы или цифры`,
    ),
  });
};

const reportNamesCap = (pluginId: string, name: string): void => {
  reportPluginProblem({
    kind: "error",
    pluginId,
    code: "cap:state-names",
    title: L(
      `Plugin "${pluginId}" asked for too many state names`,
      `Плагин «${pluginId}» запросил слишком много имён состояния`,
    ),
    detail: L(
      `at most ${String(MAX_STATE_NAMES_PER_PLUGIN)} state names per plugin; "${name}" stays undefined`,
      `не более ${String(MAX_STATE_NAMES_PER_PLUGIN)} имён состояния на плагин; «${name}» остаётся пустым`,
    ),
  });
};

const reportListenerThrew = (pluginId: string, name: string, error: unknown): void => {
  reportPluginProblem({
    kind: "error",
    pluginId,
    code: "state-listener-threw",
    title: L(
      `Plugin "${pluginId}" has a state listener that throws`,
      `У плагина «${pluginId}» слушатель состояния выбрасывает исключение`,
    ),
    detail: L(
      `state(${JSON.stringify(name)}): ${error instanceof Error ? error.message : String(error)} — the other listeners still ran`,
      `state(${JSON.stringify(name)}): ${error instanceof Error ? error.message : String(error)} — остальные слушатели всё равно отработали`,
    ),
  });
};

// --------------------------------------------------------------------------
// The registry: `pluginId` → `name` → cell
// --------------------------------------------------------------------------

const entries = new Map<string, Map<string, StateCell>>();

/** What the stream has delivered on the CURRENT subscription, per `pluginId\0name`. */
let streamed = new Map<string, Json>();

const keyOf = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/** The one signal a refused name gets: `undefined` for ever, and it never notifies. */
const INERT: Signal<Json | undefined> = makeStateCell({ onListenerThrew: () => {} }).signal;

/** The `state` member of one plugin's ctx — bound to its id, like everything else there. */
export function makePluginState(pluginId: string): (name: string) => Signal<Json | undefined> {
  return (name: string) => {
    const byName = entries.get(pluginId) ?? new Map<string, StateCell>();
    const held = byName.get(name);
    if (held !== undefined) return held.signal;
    // The argument arrives from plain JavaScript (`web/index.mjs` ships without its types).
    if (!isStateName(name)) {
      reportInvalidName(pluginId, name);
      return INERT;
    }
    if (byName.size >= MAX_STATE_NAMES_PER_PLUGIN) {
      reportNamesCap(pluginId, name);
      return INERT;
    }
    const cell = makeStateCell({
      initial: streamed.get(keyOf(pluginId, name)),
      onListenerThrew: (error) => {
        reportListenerThrew(pluginId, name, error);
      },
    });
    byName.set(name, cell);
    entries.set(pluginId, byName);
    startPluginStateStream();
    return cell.signal;
  };
}

// --------------------------------------------------------------------------
// The stream
// --------------------------------------------------------------------------

/**
 * One `plugin.state` stream as this page follows it: the server process (`boot`) its last snapshot
 * came from — `null` before its first snapshot and after its end. `value` frames carry no process of
 * their own — they are that snapshot's process's. Every run of the stream starts with its snapshot
 * (`apps/server/.../plugins/state.ts` `frames`: the snapshot, then the changes — per session), so a
 * `value` frame never meets a `null` boot in the app; the transform holds one source per stream.
 */
export type PluginStateSource = { boot: string | null };

/**
 * Per server process (`boot`): how far its frames have reached this tab — a snapshot's `seq`, then
 * each frame's `floor`. Keyed by the source's boot as it stands, so a frame is always recorded; no
 * wait carries a `null` boot, so nothing is released on one.
 */
const reached = new Map<string | null, number>();
/** Server processes whose stream in this page has ENDED: nothing will ever move them again. */
const ended = new Set<string>();

type StateWait = PluginStatePosition & { readonly release: () => void };
/** The commands answered and not yet caught up with — each resolved by the event that ends it. */
const waits = new Set<StateWait>();

const releaseWhere = (done: (wait: StateWait) => boolean): void => {
  for (const wait of Array.from(waits)) {
    if (!done(wait)) continue;
    waits.delete(wait);
    wait.release();
  }
};

/**
 * Apply one `plugin.state` frame. Exported because it IS the delivery — the subscription's
 * `transform` calls it with its own stream's source, and a unit test drives it directly.
 */
export function deliverPluginStateFrame(frame: PluginStateFrame, source: PluginStateSource): void {
  if (frame._tag === "snapshot") {
    // THE CURRENT VALUE, whole: a name this tab holds that the snapshot leaves out has NO value on
    // the server any more (it restarted), and the cell says so.
    streamed = new Map(
      frame.values.map((entry) => [keyOf(entry.pluginId, entry.name), entry.value as Json]),
    );
    for (const [pluginId, byName] of entries) {
      for (const [name, cell] of byName) cell.apply(streamed.get(keyOf(pluginId, name)));
    }
    source.boot = frame.boot;
    ended.delete(frame.boot);
    reached.set(frame.boot, frame.seq);
    // A new session's current value: at or past every answer of this process, and PAST every answer
    // of another one — that process restarted (or this tab follows another server now).
    releaseWhere((wait) => wait.boot !== frame.boot || wait.seq <= frame.seq);
    return;
  }
  const value = frame.value as Json;
  streamed.set(keyOf(frame.pluginId, frame.name), value);
  entries.get(frame.pluginId)?.get(frame.name)?.apply(value);
  const boot = source.boot;
  const floor = Math.max(reached.get(boot) ?? 0, frame.floor);
  reached.set(boot, floor);
  releaseWhere((wait) => wait.boot === boot && wait.seq <= floor);
}

/**
 * The stream `source` followed has ENDED — it failed, or its environment went away (the
 * subscription's `ensuring`). No wait outlives the stream that would have ended it: the ones it owed
 * are released now, and a later answer from that process is not held.
 */
export function endPluginStateStream(source: PluginStateSource): void {
  const boot = source.boot;
  source.boot = null;
  if (boot === null) {
    // It ended before its first snapshot: whatever waits on it has nothing else coming either.
    releaseWhere(() => true);
    return;
  }
  ended.add(boot);
  reached.delete(boot);
  releaseWhere((wait) => wait.boot === boot);
}

/**
 * Resolve once this tab's `ctx.state` holds every value the server had published at `position`
 * (S104, V2-73) — what `rpcPort.ts` awaits before it resolves a COMMAND's `ctx.invoke`. Never
 * rejects: the command already succeeded, and this only orders its answer after its state. What
 * ends it is in the file header.
 */
export function awaitPluginState(position: PluginStatePosition): Promise<void> {
  if (unmountStream === null || ended.has(position.boot)) return Promise.resolve();
  if ((reached.get(position.boot) ?? -1) >= position.seq) return Promise.resolve();
  return new Promise<void>((release) => {
    waits.add({ ...position, release });
  });
}

/** How many answered commands are still waiting for their state. Diagnostics, and the leak specs. */
export function pendingPluginStateWaits(): number {
  return waits.size;
}

const stateSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "ru-code:plugins:state",
  tag: PLUGIN_METHODS.pluginState,
  // Delivered in the TRANSFORM, once per frame: the atom holds only the LAST frame, and two frames
  // that arrive in a row are both owed to the cells. The transform runs once per environment's
  // stream, so each stream has a source of its own, and its end releases only what it owed.
  transform: (stream) => {
    const source: PluginStateSource = { boot: null };
    return stream.pipe(
      Stream.tap((frame) =>
        Effect.sync(() => {
          deliverPluginStateFrame(frame, source);
        }),
      ),
      Stream.ensuring(
        Effect.sync(() => {
          endPluginStateStream(source);
        }),
      ),
    );
  },
});

/** The primary environment's stream, following a switch. */
const pluginStateDriverAtom = Atom.make((get): null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  get(stateSubscription({ environmentId, input: {} }));
  return null;
}).pipe(Atom.withLabel("ru-code:plugins:state:driver"));

let unmountStream: (() => void) | null = null;
let streamRegistry: Pick<AtomRegistry.AtomRegistry, "mount"> | null = null;

/** Test seam: the registry the REAL driver mounts into. `null` restores the app's. */
export function setPluginStateRegistryForTests(
  next: Pick<AtomRegistry.AtomRegistry, "mount"> | null,
): void {
  streamRegistry = next;
}

/**
 * `registry.mount` and NOT `registry.subscribe(atom, noop)`, and the difference is the whole
 * mechanism: `subscribe` without `immediate` registers a listener and never calls `node.value()`
 * (`effect/unstable/reactivity/AtomRegistry.js` · `subscribe`), so a DERIVED atom is never
 * COMPUTED — its `get(subscription)` never runs, the stream is never opened, and nothing arrives
 * (measured S53 on the push stream then in use: not one frame left the tab in a real browser,
 * `WORKFLOW/logs/S53/9-probe-no-subscribe-frame.log`). `mount` IS
 * `subscribe(atom, constVoid, { immediate: true })` — the API made for holding an atom whose value
 * nobody reads, which is exactly this one: the delivery is the `transform`'s, not the value's.
 */
const mountStreamDefault = (): (() => void) =>
  (streamRegistry ?? appAtomRegistry).mount(pluginStateDriverAtom);
let mountStream: () => () => void = mountStreamDefault;

/** Test seam: stand in for the mount. `null` restores the real one. */
export function setPluginStateStreamMountForTests(next: (() => () => void) | null): void {
  mountStream = next ?? mountStreamDefault;
}

/** Open the page's `plugin.state` stream. IDEMPOTENT — every stream-transport cell calls it. */
export function startPluginStateStream(): void {
  if (unmountStream !== null) return;
  unmountStream = mountStream();
}

// --------------------------------------------------------------------------
// Test seams
// --------------------------------------------------------------------------

/** How many listeners one name holds in this tab. Diagnostics, and what the leak specs assert on. */
export function pluginStateListenerCount(pluginId: string, name: string): number {
  return entries.get(pluginId)?.get(name)?.listenerCount ?? 0;
}

/** The module is a page-level singleton, like every other registry in the host. */
export function resetPluginState(): void {
  unmountStream?.();
  unmountStream = null;
  entries.clear();
  releaseWhere(() => true);
  reached.clear();
  ended.clear();
  streamed = new Map();
}
