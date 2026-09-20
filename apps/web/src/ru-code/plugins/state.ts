// ru-code S69 (V2-58): the WEB half of the state seam — `ctx.state(name)`.
//
// WHAT A PLUGIN SEES. A `Signal<Json | undefined>` per name: `undefined` until the server half has
// published, then the server's current value, set only when it differs structurally from the value
// held. That is the whole contract, and it is the same on both transports.
//
// WHAT THIS FILE OWNS. One CELL per `(plugin, name)` (the SDK's `makeStateCell` — the compare and
// the per-listener throw isolation live there, written once), the per-plugin checks (name, names
// cap), and the transport `PLUGIN_STATE_TRANSPORT` selects (`caps.ts`):
//
//   · STREAM — one `plugin.state` subscription for the whole page, opened by the first
//     `ctx.state` call. Its first frame is a snapshot of every plugin's current values; every name
//     this tab holds takes its value from it, or `undefined` when the server holds none (a restarted
//     server). Then one frame per change. The client runtime re-opens the stream on every new
//     session (`SubscriptionRef.changes(supervisor.session)` + `switchMap`), so a reconnect IS a
//     resubscribe, and the snapshot it starts with is the current value. No timer, no re-read.
//   · NOTIFY — the page's one `plugin.notifications` stream (`notifications.ts`) carries a NAME; the
//     name's READER (the SDK's `makeStateReader`: one read in flight, one more round for any number
//     of names that arrive meanwhile) reads the value through `plugin.state.read`. A reader reads
//     once when its cell is created with the connection up, and every reader reads once on each
//     edge back into `ready` — a name the server sent while this tab's socket was down was never
//     delivered, and the value is the only thing that could say what it was.
//
// NOTHING HERE IS PER PLUGIN. A plugin's cells are keyed by the id its ctx was built with, so it
// can read only its own names, and a frame for a plugin this tab did not load changes nothing.

import type { Json, Signal } from "@smart-tools/plugin-sdk/host";
import {
  MAX_STATE_NAMES_PER_PLUGIN,
  isStateName,
  makeStateCell,
  makeStateReader,
  type StateCell,
  type StateReader,
} from "@smart-tools/plugin-sdk/state";
import { L } from "@ru-code/localization";
import type { EnvironmentId, PluginStateFrame } from "@t3tools/contracts";
import { PLUGIN_METHODS } from "@t3tools/contracts";
import { request } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { PLUGIN_STATE_TRANSPORT } from "./caps";
import { pluginConnectionSignal } from "./connectionAtom";
import { startPluginNotifications } from "./notifications";
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
// The registry: `pluginId` → `name` → cell (+ the notify transport's reader)
// --------------------------------------------------------------------------

type Entry = { readonly cell: StateCell; readonly reader: StateReader | null };

const entries = new Map<string, Map<string, Entry>>();

/** What the stream transport has delivered on the CURRENT subscription, per `pluginId\0name`. */
let streamed = new Map<string, Json>();

const keyOf = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/** The one signal a refused name gets: `undefined` for ever, and it never notifies. */
const INERT: Signal<Json | undefined> = makeStateCell({ onListenerThrew: () => {} }).signal;

/** Which transport THIS page uses — `PLUGIN_STATE_TRANSPORT`, or what a unit test chose. */
let transport: "stream" | "notify" = PLUGIN_STATE_TRANSPORT;

/** Test seam: the unit suites run every case against BOTH transports. `null` restores the constant. */
export function setPluginStateTransportForTests(next: "stream" | "notify" | null): void {
  transport = next ?? PLUGIN_STATE_TRANSPORT;
}

/** The `state` member of one plugin's ctx — bound to its id, like everything else there. */
export function makePluginState(pluginId: string): (name: string) => Signal<Json | undefined> {
  return (name: string) => {
    const byName = entries.get(pluginId) ?? new Map<string, Entry>();
    const held = byName.get(name);
    if (held !== undefined) return held.cell.signal;
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
      initial: transport === "stream" ? streamed.get(keyOf(pluginId, name)) : undefined,
      onListenerThrew: (error) => {
        reportListenerThrew(pluginId, name, error);
      },
    });
    const reader =
      transport === "notify"
        ? makeStateReader({
            read: () => readState(pluginId, name),
            apply: (value) => {
              cell.apply(value);
            },
            // A failed read is the transport's, not the plugin's: nothing is reported, the cell
            // keeps its value, and the next name or the next edge back into `ready` reads again.
            onReadFailed: () => {},
          })
        : null;
    byName.set(name, { cell, reader });
    entries.set(pluginId, byName);
    if (reader === null) {
      startPluginStateStream();
    } else {
      startPluginNotifications();
      watchReadyEdges();
      if (readConnection() === "ready") void reader.request();
    }
    return cell.signal;
  };
}

// --------------------------------------------------------------------------
// STREAM transport
// --------------------------------------------------------------------------

/**
 * Apply one `plugin.state` frame. Exported because it IS the delivery — the subscription's
 * `transform` calls it, and a unit test drives it directly.
 */
export function deliverPluginStateFrame(frame: PluginStateFrame): void {
  if (frame._tag === "snapshot") {
    // THE CURRENT VALUE, whole: a name this tab holds that the snapshot leaves out has NO value on
    // the server any more (it restarted), and the cell says so.
    streamed = new Map(
      frame.values.map((entry) => [keyOf(entry.pluginId, entry.name), entry.value as Json]),
    );
    for (const [pluginId, byName] of entries) {
      for (const [name, entry] of byName) entry.cell.apply(streamed.get(keyOf(pluginId, name)));
    }
    return;
  }
  const value = frame.value as Json;
  streamed.set(keyOf(frame.pluginId, frame.name), value);
  entries.get(frame.pluginId)?.get(frame.name)?.cell.apply(value);
}

const stateSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "ru-code:plugins:state",
  tag: PLUGIN_METHODS.pluginState,
  // Delivered in the TRANSFORM, once per frame, for the reason `notifications.ts` gives: the atom
  // holds only the last frame, and two frames in a row are both owed to the cells.
  transform: (stream) =>
    stream.pipe(
      Stream.tap((frame) =>
        Effect.sync(() => {
          deliverPluginStateFrame(frame);
        }),
      ),
    ),
});

/** The primary environment's stream, following a switch — `notifications.ts`'s driver, same shape. */
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

/** `mount`, not `subscribe` — the S53 measurement in `notifications.ts` `startPluginNotifications`. */
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
// NOTIFY transport
// --------------------------------------------------------------------------

/** Route one name from `plugin.notifications` to its reader — `notifications.ts` calls this. */
export function deliverPluginStateName(pluginId: string, name: string): void {
  void entries.get(pluginId)?.get(name)?.reader?.request();
}

const stateReadCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugin:state-read",
  execute: (input: { readonly pluginId: PluginId; readonly name: string }) =>
    request(PLUGIN_METHODS.pluginStateRead, input),
});

/** One `plugin.state.read` over the app's transport. */
const readStateDefault = async (pluginId: string, name: string): Promise<Json | undefined> => {
  const environmentId: EnvironmentId | null = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) throw new Error("no primary environment");
  const result = await stateReadCommand.run(appAtomRegistry, {
    environmentId,
    input: { pluginId: PluginId.make(pluginId), name },
  });
  if (!AsyncResult.isSuccess(result))
    throw new Error(`plugin.state.read failed for ${pluginId}.${name}`);
  return result.value.value as Json | undefined;
};
let readState: (pluginId: string, name: string) => Promise<Json | undefined> = readStateDefault;

/** Test seam: stand in for the read. `null` restores the real one. */
export function setPluginStateReadForTests(
  next: ((pluginId: string, name: string) => Promise<Json | undefined>) | null,
): void {
  readState = next ?? readStateDefault;
}

/** The connection as `ctx.connection` reads it — a seam, so a test can drive the edges. */
let connectionSource: () => Signal<"connecting" | "ready" | "lost"> = pluginConnectionSignal;

/** Test seam. `null` restores `ctx.connection`'s own source. */
export function setPluginStateConnectionForTests(
  next: Signal<"connecting" | "ready" | "lost"> | null,
): void {
  connectionSource = next === null ? pluginConnectionSignal : () => next;
}

const readConnection = (): "connecting" | "ready" | "lost" => connectionSource().get();

let unwatchReady: (() => void) | null = null;

/**
 * Every edge INTO `ready` reads every name once. Not only "after a `lost`": the app's supervisor
 * starts in `available`, which reads as `lost` (S66 F3), so the latch would be the same thing with
 * one more variable — and a cell created before the first `ready` needs this first edge anyway,
 * because it did not read at creation (the connection was down).
 */
function watchReadyEdges(): void {
  if (unwatchReady !== null) return;
  const connection = connectionSource();
  let previous = connection.get();
  unwatchReady = connection.subscribe(() => {
    const now = connection.get();
    if (now === "ready" && previous !== "ready") {
      for (const byName of entries.values()) {
        for (const entry of byName.values()) void entry.reader?.request();
      }
    }
    previous = now;
  });
}

// --------------------------------------------------------------------------
// Test seams
// --------------------------------------------------------------------------

/** How many listeners one name holds in this tab. Diagnostics, and what the leak specs assert on. */
export function pluginStateListenerCount(pluginId: string, name: string): number {
  return entries.get(pluginId)?.get(name)?.cell.listenerCount ?? 0;
}

/** The module is a page-level singleton, like every other registry in the host. */
export function resetPluginState(): void {
  unmountStream?.();
  unmountStream = null;
  unwatchReady?.();
  unwatchReady = null;
  entries.clear();
  streamed = new Map();
}
