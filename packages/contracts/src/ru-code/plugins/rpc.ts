// ru-code: the ENTIRE ws surface of the plugin system — five RPCs, edited into the
// three sealed tables exactly once (mvp-plan D3). Four are request/reply; the fifth,
// `plugin.state` (S69, V2-58), is the ONE stream the server sends unasked.
//
// WHY a generic `plugin.invoke` instead of a method per plugin. A plugin is a folder
// the user drops into `~/.ru-code/plugins/`; the host learns its methods at runtime,
// from `host.registerRpc` calls made inside `activate`. A typed RPC per plugin
// operation would have to exist at BUILD time, which is exactly the knowledge the
// host is not allowed to have — that is the whole premise of the feature ("the app
// had zero knowledge of the plugin before"). So the wire carries `{ pluginId, method,
// payload }` and the plugin's own contract lives between its two halves.
//
// The price is `Schema.Unknown` on the payload and on the answer's `value` (the answer's
// `boot`/`seq` are typed, S104), i.e. the wire is unvalidated JSON for this one call. Contained
// deliberately:
//   - `pluginId` IS validated (`PluginId`, the same branded pattern the folder name,
//     the storage path and the asset route use), so an id can never become a path;
//   - `method` must be a non-empty string, and only a method the plugin actually
//     registered is dispatched — an unknown one is `unknown-method`, never a lookup
//     on a prototype;
//   - every failure the host can produce is a `PluginRpcError` with a closed
//     `reason` set, so a plugin cannot invent a new error shape on the wire;
//   - `plugin.invoke` costs the OPERATE scope (a plugin handler may write to its own
//     database), while `plugin.list` is a read.
//
// The two names are stable wire tags. `PLUGIN_METHODS` is literal-keyed so the host's
// `WS_METHODS`/scope table keep literal typing through a spread — the same shape
// `AUTO_UPDATE_METHODS` uses.

import {
  LocalizedText,
  PluginId,
  PluginRpcError,
  PluginState,
  WebManifestList,
} from "@smart-tools/plugin-sdk/contracts";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "../../baseSchemas.ts";

/** Literal-keyed method map (the host retains literal typing through a spread). */
export const PLUGIN_METHODS = {
  pluginList: "plugin.list",
  pluginInvoke: "plugin.invoke",
  pluginSettings: "plugin.settings",
  pluginSetEnabled: "plugin.setEnabled",
  pluginState: "plugin.state",
} as const;
export type PluginMethods = typeof PLUGIN_METHODS;

/**
 * Every plugin's lifecycle outcome, including the ones that did NOT load.
 *
 * Same body as `GET /plugins/manifests.json` (the web bootstrap reads that one
 * before the app renders); this is the ws read for anything that needs the list
 * afterwards — a settings page, a failed-plugin notice, a diagnostic.
 */
export const WsPluginListRpc = Rpc.make(PLUGIN_METHODS.pluginList, {
  payload: Schema.Struct({}),
  success: WebManifestList,
  error: PluginRpcError,
});

/**
 * ru-code S104 (V2-73): WHERE the server's state hub stood — `boot` names the server PROCESS (a
 * restart is a new one, and its count starts again), `seq` counts every change the hub accepted.
 * An invoke answer carries the position when its handler returned; a `plugin.state` snapshot the
 * position it was taken at. The web host resolves a command's `ctx.invoke` only once this tab's
 * stream has reached the answer's position — so `ctx.state` holds everything the server published
 * before it answered (`apps/web/src/ru-code/plugins/state.ts`).
 */
export const PluginStatePosition = Schema.Struct({
  boot: Schema.String,
  seq: NonNegativeInt,
});
export type PluginStatePosition = typeof PluginStatePosition.Type;

/**
 * Call a method a server plugin registered with `host.registerRpc`.
 *
 * `payload` and `value` are whatever the plugin's two halves agreed on — see the module header for
 * why that is `Unknown` and what still constrains it. The answer also carries the state hub's
 * position when the handler returned (S104, V2-73): an ENVELOPE the web host unwraps, so a plugin
 * still receives its handler's value and nothing else.
 */
export const WsPluginInvokeRpc = Rpc.make(PLUGIN_METHODS.pluginInvoke, {
  payload: Schema.Struct({
    pluginId: PluginId,
    method: Schema.NonEmptyString,
    // OPTIONAL, and it has to be. The host API is `invoke(method, payload?)`, and a
    // `payload` left out reaches the wire as an ABSENT key — JSON drops `undefined`
    // values, so "pass nothing" and "pass undefined" are the same request. A required
    // key here would reject every no-argument call with a decode error the plugin
    // author could not act on.
    payload: Schema.optional(Schema.Unknown),
  }),
  success: Schema.Struct({
    value: Schema.Unknown,
    boot: PluginStatePosition.fields.boot,
    seq: PluginStatePosition.fields.seq,
  }),
  error: PluginRpcError,
});

/**
 * ru-code S38 (V2-43): one row of the Settings ▸ Plugins section.
 *
 * `plugin.list`'s `PluginStatus` is the BOOTSTRAP shape — it is also served unauthenticated over
 * `GET /plugins/manifests.json`, so it carries only what the web loader needs to decide whether to
 * import a folder. A settings row needs three more facts and none of them belong on that route:
 * which ROOT the folder came from (a shipped plugin cannot be uninstalled by deleting it, which is
 * why the switch exists at all), what the SAVED file says now, and what THIS process decided at
 * boot. The page compares the last two to decide whether to say "restart to apply".
 */
export const PluginSettingsRow = Schema.Struct({
  id: Schema.String,
  /** The manifest's `name`, verbatim — one string or `{ en, ru }`. The PAGE resolves it. */
  name: LocalizedText,
  /** The manifest's `description`, verbatim and optional. Absent ⇒ the row draws no second line. */
  description: Schema.optional(LocalizedText),
  version: Schema.String,
  /** `shipped` = inside the release payload (read-only); `user` = dropped into `<baseDir>/plugins`. */
  root: Schema.Literals(["shipped", "user"]),
  /** The plugin folder, absolute. What a user would look in — or delete, for a `user` plugin. */
  dir: Schema.optional(Schema.String),
  state: PluginState,
  /** Present for `failed` / `skipped` — the same sanitized sentence the status row carries. */
  error: Schema.optional(Schema.String),
  /** What the switch should READ as: the saved answer, which the next boot will act on. */
  enabledSaved: Schema.Boolean,
  /** What THIS server process actually did with it at boot. */
  enabledRunning: Schema.Boolean,
});
export type PluginSettingsRow = typeof PluginSettingsRow.Type;

export const PluginSettingsList = Schema.Array(PluginSettingsRow);
export type PluginSettingsList = typeof PluginSettingsList.Type;

/** Every scanned plugin, with what the user has said about it and what is running. */
export const WsPluginSettingsRpc = Rpc.make(PLUGIN_METHODS.pluginSettings, {
  payload: Schema.Struct({}),
  success: PluginSettingsList,
  error: PluginRpcError,
});

/**
 * Record the user's switch for ONE plugin and answer with the fresh rows.
 *
 * It writes `<stateDir>/plugins/disabled.json` (atomically, whole file, one entry per id, and
 * SERIALISED against every other switch this process is recording, so two calls in flight cannot
 * erase each other) and nothing else: a plugin already running keeps running until the app restarts, which is the
 * sentence the page shows. An id this host did not scan is `unknown-plugin` rather than a silent
 * write — a settings page that accepted any string would let a typo put an inert entry into a file
 * a human reads.
 */
export const WsPluginSetEnabledRpc = Rpc.make(PLUGIN_METHODS.pluginSetEnabled, {
  payload: Schema.Struct({ pluginId: PluginId, enabled: Schema.Boolean }),
  success: PluginSettingsList,
  error: PluginRpcError,
});

/**
 * ru-code S69 (V2-58): ONE current value — a plugin's name, and what its server half last published
 * under it. `value` is `Unknown` on the wire for the reason `plugin.invoke`'s answer is: the SERVER
 * validated it as plain JSON before it was stored (`apps/server/src/ru-code/plugins/state.ts`), and
 * the plugin's two halves own its shape.
 */
export const PluginStateValue = Schema.Struct({
  pluginId: PluginId,
  name: Schema.NonEmptyString,
  value: Schema.Unknown,
});
export type PluginStateValue = typeof PluginStateValue.Type;

/**
 * One frame of `plugin.state` (V2-58).
 *
 * `snapshot` is the FIRST frame of every subscription: the current value of every name of every
 * plugin, and — by what it leaves out — the names the server holds NO value for (after a server
 * restart, a value a tab still shows is gone, and the tab has to learn that too). Every later frame
 * is a `value`: one name whose value CHANGED. A tab applies either by the one rule, structural
 * compare then set, so a snapshot that repeats what it holds renders nothing.
 *
 * S104 (V2-73): a snapshot also carries the hub's position it was taken at (`boot`, `seq`), and a
 * `value` frame its `floor` — every change up to `floor` has reached this tab, delivered or replaced
 * by a frame the tab already took (latest-wins).
 */
export const PluginStateFrame = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    values: Schema.Array(PluginStateValue),
    boot: PluginStatePosition.fields.boot,
    seq: PluginStatePosition.fields.seq,
  }),
  Schema.TaggedStruct("value", {
    pluginId: PluginId,
    name: Schema.NonEmptyString,
    value: Schema.Unknown,
    floor: NonNegativeInt,
  }),
]);
export type PluginStateFrame = typeof PluginStateFrame.Type;

/**
 * THE state seam's one transport (V2-58; the notify transport was removed, V2-75).
 *
 * THE APP'S EXISTING PUSH PATH, not a new one: a `stream: true` RPC over the socket the tab already
 * holds, exactly like `subscribeServerConfig` and `subscribeAutoUpdate`, re-opened by the client
 * runtime on every new session — so a reconnect IS a resubscribe, and the snapshot it starts with is
 * the current value. ONE stream for every plugin and every name, not one per plugin: a tab hosts all
 * of them, per-plugin streams would be a frame budget that grows with the install, and the isolation
 * a plugin needs is at its ctx, which routes by id. LATEST WINS: the server holds at most one
 * pending value per `(plugin, name)` per tab, so a value published a thousand times while one frame
 * is on its way costs one more frame, carrying the last.
 *
 * READ scope: subscribing runs no plugin code.
 */
export const WsPluginStateRpc = Rpc.make(PLUGIN_METHODS.pluginState, {
  payload: Schema.Struct({}),
  success: PluginStateFrame,
  error: PluginRpcError,
  stream: true,
});

/** All five, ready to spread into the host's `WsRpcGroup.make(...)`. */
export const pluginRpcs = [
  WsPluginListRpc,
  WsPluginInvokeRpc,
  WsPluginSettingsRpc,
  WsPluginSetEnabledRpc,
  WsPluginStateRpc,
] as const;
