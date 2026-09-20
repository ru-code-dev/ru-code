// ru-code: the ws handlers for the 2 plugin RPCs (D3). Extracted so `ws.ts` keeps
// only a thin registration seam — it yields `PluginHost`, builds the observe
// wrapper (auth + tracing, auth failures encoded into `PluginRpcError` the way the
// the analytics handlers encode theirs) and spreads `buildPluginRpcHandlers(...)`.
//
// This file is the WHOLE server-side ws surface of the plugin system. There is no
// per-plugin handler and there never will be one: the host learns a plugin's
// methods at runtime from `host.registerRpc`, so the dispatch has to be generic
// (see the contract's module doc for what still constrains the wire).
//
// S53 (V2-54) added the one STREAM: `plugin.notifications`, the server→web push, which is generic
// for the same reason and for one more — a tab hosts every plugin, so it subscribes once and the
// frame says which plugin a name belongs to.

import { PLUGIN_METHODS } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { PluginRpcError } from "@smart-tools/plugin-sdk/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

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
  // ru-code S38 (V2-43): reading which plugins are installed and what the user said about them is
  // a read; flipping a switch writes `<stateDir>/plugins/disabled.json` and decides what the next
  // boot runs, which is the most operate-shaped thing this surface has.
  [PLUGIN_METHODS.pluginSettings]: AuthOrchestrationReadScope,
  [PLUGIN_METHODS.pluginSetEnabled]: AuthOrchestrationOperateScope,
  // ru-code S53 (V2-54): a READ. The stream carries a name a plugin chose and the id it belongs to
  // — no plugin state, no plugin payload — and subscribing runs no plugin code at all: the handler
  // registers a queue in the host and nothing else. The OPERATE door stays `plugin.invoke`, which
  // is where a notification sends the tab next.
  [PLUGIN_METHODS.pluginNotifications]: AuthOrchestrationReadScope,
  // ru-code S69 (V2-58): the state seam's two transports, both READS, for the reason above: the
  // stream carries values a plugin already published, the read answers one of them, and neither
  // runs plugin code. The OPERATE door is still only `plugin.invoke`.
  [PLUGIN_METHODS.pluginState]: AuthOrchestrationReadScope,
  [PLUGIN_METHODS.pluginStateRead]: AuthOrchestrationReadScope,
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
  trace: PluginRpcTrace,
  effect: Effect.Effect<A, PluginRpcError, R>,
) => Effect.Effect<A, PluginRpcError, R>;

/**
 * The same wrapper for the ONE streaming plugin RPC (S53, V2-54).
 *
 * Separate rather than generic for the reason `ws.ts` states about the MCP pair: the auth fold is
 * `catchTag` on a CONCRETE error type, and a helper that took both shapes would widen the handler's
 * argument until the narrowing stops type-checking. `tracePluginRpc` is deliberately NOT applied —
 * it measures a call from entry to exit, and a subscription's exit is the tab closing, which would
 * log a `ms` of "how long the user kept the page open".
 */
export type ObservePluginRpcStream = <A, R>(
  method: string,
  stream: Stream.Stream<A, PluginRpcError, R>,
) => Stream.Stream<A, PluginRpcError, R>;

/**
 * What one plugin RPC's two trace lines NAME.
 *
 * `method` is the wire tag — what the scope table and the instrumentation key on, and the only
 * thing a host-level RPC like `plugin.list` has to say about itself. `plugin` and `call` are the
 * generic door's own: `plugin.invoke` is the same string for every call a plugin ever makes, so
 * without them the log answers "a plugin called something" and nothing else.
 */
export interface PluginRpcTrace {
  readonly method: string;
  /** The plugin the call is for. Absent for an RPC that is not about one plugin. */
  readonly plugin?: string;
  /** The plugin's OWN method — the name it registered under `rpc`. Goes with `plugin`. */
  readonly call?: string;
}

/**
 * The fields both lines carry.
 *
 * With a plugin the `method` is dropped: it would be the literal `plugin.invoke` on every one of
 * those lines, and `plugin` + `call` already say which door and which call this is.
 */
const traceFields = (trace: PluginRpcTrace): Record<string, string> =>
  trace.plugin === undefined
    ? { method: trace.method }
    : { plugin: trace.plugin, ...(trace.call === undefined ? {} : { call: trace.call }) };

/** How the call ENDED, in the three words the exit can mean. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit)
    ? "success"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "interrupted"
      : "failure";

/**
 * The failure's REASON, and nothing else about it.
 *
 * Structural, not `instanceof`: `PluginRpcError` crosses to plugin authors through a bundle the
 * host does not build, so the `_tag` is the contract and the class identity is not. Only `reason`
 * is read — a closed set of host-minted words. `detail` and `data` are the plugin's own values and
 * a debug log is not where a plugin's payload belongs.
 */
const reasonOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const squashed = Cause.squash(exit.cause) as { _tag?: unknown; reason?: unknown } | null;
  if (typeof squashed !== "object" || squashed === null) return undefined;
  if (squashed._tag !== "PluginRpcError") return undefined;
  return typeof squashed.reason === "string" ? squashed.reason : undefined;
};

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
 * normal and must not read as a failure. The end line also carries `ms` (measured
 * here, start to exit) and, when the failure is a typed `PluginRpcError`, its
 * `reason` — the word, never the `detail` and never the `data`.
 *
 * Placement matters as much as existence: this wraps the AUTHORIZED effect, i.e.
 * it sits OUTSIDE `authorizeEffect`, which short-circuits with `Effect.fail`
 * WITHOUT running what it wraps — a trace nested inside would go silent for
 * exactly the scope-rejected calls where "did it even arrive?" is the question.
 */
export const tracePluginRpc = <A, E, R>(
  trace: PluginRpcTrace,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fields = traceFields(trace);
    // INSIDE the wrapper, start to exit, so `ms` covers the handler's whole async work — the
    // plugin's own promise included. Effect's `Clock`, not `Date.now()`: it is the service a test
    // can drive, and it is not a timer (rule 38 — nothing here waits for anything).
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.logDebug("[plugins] rpc start", fields);
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((endedAt) => {
            const reason = reasonOf(exit);
            return Effect.logDebug("[plugins] rpc end", {
              ...fields,
              outcome: outcomeOf(exit),
              ms: endedAt - startedAt,
              ...(reason === undefined ? {} : { reason }),
            });
          }),
        ),
      ),
    );
  });

export function buildPluginRpcHandlers(deps: {
  readonly pluginHost: PluginHost["Service"];
  readonly observePluginRpc: ObservePluginRpc;
  readonly observePluginRpcStream: ObservePluginRpcStream;
}) {
  const { pluginHost, observePluginRpc, observePluginRpcStream } = deps;
  return {
    // The status table, verbatim — including the plugins that did NOT load, which
    // is the half a caller needs in order to explain an empty panel.
    [PLUGIN_METHODS.pluginList]: (_input: object) =>
      observePluginRpc({ method: PLUGIN_METHODS.pluginList }, pluginHost.list),
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
        // The generic door, named: WHICH plugin and WHICH of its calls. The payload is never
        // traced — it is the plugin's own value and the two halves' business.
        {
          method: PLUGIN_METHODS.pluginInvoke,
          plugin: input.pluginId,
          call: input.method,
        },
        pluginHost.invoke(input.pluginId, input.method, input.payload),
      ),
    // ru-code S38 (V2-43): the Settings ▸ Plugins section — the rows, and the one switch.
    [PLUGIN_METHODS.pluginSettings]: (_input: object) =>
      observePluginRpc({ method: PLUGIN_METHODS.pluginSettings }, pluginHost.settings),
    [PLUGIN_METHODS.pluginSetEnabled]: (input: {
      readonly pluginId: string;
      readonly enabled: boolean;
    }) =>
      observePluginRpc(
        { method: PLUGIN_METHODS.pluginSetEnabled, plugin: input.pluginId },
        pluginHost.setEnabled(input.pluginId, input.enabled),
      ),
    // ru-code S53 (V2-54): the server→web push. ONE stream per tab, every plugin's names on it;
    // the host registers this tab's sink when the stream is pulled and removes it when the request
    // ends. Nothing is traced per notification — the volume is a plugin's business and the two
    // interesting facts (a refused name, a cap) are logged once by the hub itself.
    [PLUGIN_METHODS.pluginNotifications]: (_input: object) =>
      observePluginRpcStream(PLUGIN_METHODS.pluginNotifications, pluginHost.notifications),
    // ru-code S69 (V2-58): the state seam. The STREAM transport — one stream per tab, the snapshot
    // of every current value first, then each change — and the NOTIFY transport's read of one
    // stored value. Neither is traced per frame, for the reason `plugin.notifications` is not.
    [PLUGIN_METHODS.pluginState]: (_input: object) =>
      observePluginRpcStream(PLUGIN_METHODS.pluginState, pluginHost.stateFrames),
    [PLUGIN_METHODS.pluginStateRead]: (input: {
      readonly pluginId: string;
      readonly name: string;
    }) =>
      observePluginRpc(
        { method: PLUGIN_METHODS.pluginStateRead, plugin: input.pluginId },
        pluginHost.readState(input.pluginId, input.name),
      ),
  };
}
