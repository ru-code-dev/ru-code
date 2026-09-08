// ru-code: the ENTIRE ws surface of the plugin system — two RPCs, edited into the
// three sealed tables exactly once (mvp-plan D3).
//
// WHY a generic `plugin.invoke` instead of a method per plugin. A plugin is a folder
// the user drops into `~/.ru-code/plugins/`; the host learns its methods at runtime,
// from `host.registerRpc` calls made inside `activate`. A typed RPC per plugin
// operation would have to exist at BUILD time, which is exactly the knowledge the
// host is not allowed to have — that is the whole premise of the feature ("the app
// had zero knowledge of the plugin before"). So the wire carries `{ pluginId, method,
// payload }` and the plugin's own contract lives between its two halves.
//
// The price is `Schema.Unknown` on both payload and success, i.e. the wire is
// unvalidated JSON for this one call. Contained deliberately:
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

import { PluginId, PluginRpcError, WebManifestList } from "@smart-tools/plugin-sdk/contracts";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";

/** Literal-keyed method map (the host retains literal typing through a spread). */
export const PLUGIN_METHODS = {
  pluginList: "plugin.list",
  pluginInvoke: "plugin.invoke",
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
 * Call a method a server plugin registered with `host.registerRpc`.
 *
 * `payload` and the success value are whatever the plugin's two halves agreed on
 * — see the module header for why that is `Unknown` and what still constrains it.
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
  success: Schema.Unknown,
  error: PluginRpcError,
});

/** Both, ready to spread into the host's `WsRpcGroup.make(...)`. */
export const pluginRpcs = [WsPluginListRpc, WsPluginInvokeRpc] as const;
