// ru-code: the ws handlers for the 2 plugin RPCs (D3). Extracted so `ws.ts` keeps
// only a thin registration seam — it yields `PluginHost`, builds the observe
// wrapper (auth + tracing, auth failures encoded into `PluginRpcError` the way the
// analytics/pixso handlers encode theirs) and spreads `buildPluginRpcHandlers(...)`.
//
// This file is the WHOLE server-side ws surface of the plugin system. There is no
// per-plugin handler and there never will be one: the host learns a plugin's
// methods at runtime from `host.registerRpc`, so the dispatch has to be generic
// (see the contract's module doc for what still constrains the wire).

import { PLUGIN_METHODS } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { PluginRpcError } from "@smart-tools/plugin-sdk/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { PluginHost } from "./PluginHost.ts";

/**
 * Per-method auth scopes, spread into `auth/RpcAuthorization.ts`'s
 * `RPC_REQUIRED_SCOPES` (which `satisfies Record<WsRpcMethod, …>` — an RPC without
 * a row here is a compile error, not a runtime hole).
 *
 * `plugin.list` is a pure read of the host's status table — the same body the web
 * bootstrap already fetches unauthenticated over `GET /plugins/manifests.json`, so
 * demanding more than read scope would be theatre.
 *
 * `plugin.invoke` is OPERATE. A plugin handler is arbitrary code that may write to
 * the plugin's own SQLite file, call out to the network, or mutate anything the
 * host handed it; there is no way to tell a reading method from a writing one by
 * its name, so the whole door takes the higher scope. Splitting per method would
 * mean trusting a plugin's self-declaration, which is exactly the thing a scope
 * table exists not to do.
 */
// ru-code: object shape (not a tuple array) — matches the shared scope table's shape.
export const PLUGIN_RPC_SCOPES = {
  [PLUGIN_METHODS.pluginList]: AuthOrchestrationReadScope,
  [PLUGIN_METHODS.pluginInvoke]: AuthOrchestrationOperateScope,
} as const;

/**
 * Auth+tracing wrapper for one unary plugin RPC.
 *
 * Auth failures are folded into `PluginRpcError({ reason: "unauthorized" })`
 * because that is the ONLY error these RPCs declare — the wire cannot carry an
 * `EnvironmentAuthorizationError` here. Built in `ws.ts`, which is where the
 * upstream authorize/instrument helpers live.
 */
export type ObservePluginRpc = <A, R>(
  method: string,
  effect: Effect.Effect<A, PluginRpcError, R>,
) => Effect.Effect<A, PluginRpcError, R>;

/**
 * ru-code: entry/exit trace for one plugin RPC.
 *
 * `RpcInstrumentation.ts` emits a span and a counter but no log line at all, so
 * this is not duplicate instrumentation — and for a plugin it is the only place a
 * "the call arrived, here is how it ended" line can come from: everything past the
 * dispatch is code the host did not write and cannot instrument.
 *
 * `Effect.onExit` so all three outcomes are recorded — success, failure and
 * interruption. An interrupted invoke (socket closed, panel navigated away) is
 * normal and must not read as a failure.
 *
 * Placement matters as much as existence: this wraps the AUTHORIZED effect, i.e.
 * it sits OUTSIDE `authorizeEffect`, which short-circuits with `Effect.fail`
 * WITHOUT running what it wraps — a trace nested inside would go silent for
 * exactly the scope-rejected calls where "did it even arrive?" is the question.
 */
export const tracePluginRpc = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.logDebug("[plugins] rpc start", { method }).pipe(
    Effect.andThen(effect),
    Effect.onExit((exit) =>
      Effect.logDebug("[plugins] rpc end", {
        method,
        outcome: Exit.isSuccess(exit)
          ? "success"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failure",
      }),
    ),
  );

export function buildPluginRpcHandlers(deps: {
  readonly pluginHost: PluginHost["Service"];
  readonly observePluginRpc: ObservePluginRpc;
}) {
  const { pluginHost, observePluginRpc } = deps;
  return {
    // The status table, verbatim — including the plugins that did NOT load, which
    // is the half a caller needs in order to explain an empty panel.
    [PLUGIN_METHODS.pluginList]: (_input: object) =>
      observePluginRpc(PLUGIN_METHODS.pluginList, pluginHost.list),
    // Every failure mode already comes back typed from the host: unknown-plugin,
    // unknown-method, plugin-disabled, plugin-failed. Nothing is added here — a
    // second layer of interpretation would only be able to guess.
    [PLUGIN_METHODS.pluginInvoke]: (input: {
      readonly pluginId: string;
      readonly method: string;
      // Optional on the wire: a no-argument `host.invoke("m")` sends no key at all
      // (JSON drops `undefined`), and the plugin's handler receives `undefined`.
      readonly payload?: unknown;
    }) =>
      observePluginRpc(
        PLUGIN_METHODS.pluginInvoke,
        pluginHost.invoke(input.pluginId, input.method, input.payload),
      ),
  };
}
