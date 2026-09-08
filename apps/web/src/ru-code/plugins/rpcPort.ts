// ru-code: `host.invoke(method, payload)` — `plugin.invoke` for this plugin id.
//
// The port indirection (A3) keeps the plugin-facing shape final while the wiring lands: until
// `installPluginRpcPort()` runs, every call REJECTS — unlike the composer, a silently-ignored
// `invoke` would hand the plugin `undefined` and look like an empty result. Every rejection is
// the SDK's own `PluginRpcError`, so a plugin's `catch` is written once against one error type
// whether the failure came from the server, from no connection, or from an unwired host.
//
// The client half (A6) is the `analyticsActions.ts:runAnalyticsRpc` idiom: one unary RPC
// against the PRIMARY environment, read from `appAtomRegistry` at call time (not captured —
// the primary environment appears and switches while the app runs), with the settled
// `AsyncResult` unwrapped into resolve/reject.

import { PLUGIN_ID_PATTERN, PluginId, PluginRpcError } from "@smart-tools/plugin-sdk/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { PLUGIN_METHODS } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

export type RpcPort = (pluginId: string, method: string, payload?: unknown) => Promise<unknown>;

const defaultPort: RpcPort = (pluginId, method) =>
  Promise.reject(
    new PluginRpcError({
      reason: "plugin-failed",
      detail: `plugin.invoke arrives in A5/A6 — ${pluginId}.${method} is not reachable in this build`,
    }),
  );

let port: RpcPort = defaultPort;

/** A6 calls this once, at module scope, from the RPC client it owns. */
export function setRpcPort(next: RpcPort): void {
  port = next;
}

/** Test seam. */
export function resetRpcPort(): void {
  port = defaultPort;
}

/** The `invoke` member of the host object handed to one plugin. */
export function makePluginInvoke(pluginId: string) {
  // ru-code (A13, A12 finding R1-L8): the SDK's `invoke` is `invoke<Result = unknown>(...)`, so a
  // plugin author writes `await host.invoke<Note[]>("notes.list")` instead of casting at every call
  // site. The host cannot know the shape, so `Result` is an ASSERTION and this is the one place in
  // the app that spells the cast — the same posture as `composerPort.ts`'s branded target handle.
  return <Result = unknown>(method: string, payload?: unknown): Promise<Result> =>
    port(pluginId, method, payload) as Promise<Result>;
}

// --------------------------------------------------------------------------
// The real client (A6)
// --------------------------------------------------------------------------

/**
 * The wire shape of `plugin.invoke` (mvp-plan D3).
 *
 * `pluginId` is the contract's BRANDED `PluginId`, not a bare string: the same brand the
 * folder name, the plugin's storage path and the asset route are built on. It is minted at
 * the one boundary below, where a plugin's `host.invoke(...)` call enters — so an id that
 * could never name a plugin is refused here rather than at the far end of a socket.
 */
export interface PluginInvokeInput {
  readonly pluginId: PluginId;
  readonly method: string;
  readonly payload?: unknown;
}

/** How one `plugin.invoke` reaches the server. Injected in tests (no atom runtime needed). */
export type PluginInvokeTransport = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: PluginInvokeInput;
}) => Promise<unknown>;

/**
 * Is this already the SDK's own error?
 *
 * By TAG, not by `instanceof`: `PluginRpcError` is an Effect Schema class (the language
 * service refuses `instanceof` on one, `effect(instanceOfSchema)`), and the value crossed a
 * schema decode — a second copy of `@smart-tools/plugin-sdk/contracts` in the graph would
 * make a constructor check false anyway. Wrapping a `PluginRpcError` in another one would
 * bury the server's own `reason` behind `plugin-failed`, which is the exact failure this
 * normalisation exists to prevent, so the check is the one the tag was made for.
 */
const isPluginRpcError = (error: unknown): error is PluginRpcError =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "PluginRpcError" &&
  typeof (error as { readonly reason?: unknown }).reason === "string";

/**
 * Every rejection this module produces, as the one error type the header promises (A7 M1).
 *
 * A TRANSPORT failure — no socket yet on a fresh page load, a connection that dropped, a
 * decode error — arrives as an ordinary app error carrying a LOCALIZED host string
 * (`"ubuntu: нет подключения."`). A plugin author writing the documented
 * `catch (e) { if (e.reason === …) }` would read `undefined` on the single most common
 * transient failure, and a host string would land in the plugin's own UI.
 *
 * `PluginRpcErrorReason` has no transport member (`unknown-plugin`, `unknown-method`,
 * `plugin-failed`, `plugin-disabled`, `unauthorized`, `invalid-payload`), so a transport
 * failure is reported as `plugin-failed` — same reason the "no active connection" branch
 * below already uses — with the underlying message as `detail`. The SDK's error declares
 * `reason` + optional `detail` and nothing else, so the original is kept only on the
 * standard `Error.cause`, for the devtools, never on the wire.
 */
function asPluginRpcError(error: unknown): PluginRpcError {
  if (isPluginRpcError(error)) return error;
  const wrapped = new PluginRpcError({
    reason: "plugin-failed",
    detail: error instanceof Error ? error.message : String(error),
  });
  wrapped.cause = error;
  return wrapped;
}

const defaultTransport: PluginInvokeTransport = async ({ environmentId, input }) => {
  // ru-code (A5): the tag is `PLUGIN_METHODS.pluginInvoke` from the contract itself — the
  // RPC is in `WsRpcGroup` now, so the tag and the input type are both derived and the two
  // casts this file used to carry are gone. A rename on the wire is a compile error here.
  const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "plugin:invoke",
    tag: PLUGIN_METHODS.pluginInvoke,
  });
  const result = await command.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (AsyncResult.isSuccess(result)) {
    return result.value as unknown;
  }
  // The squashed cause is the server's own `PluginRpcError` when the far end refused, and an
  // app-level transport error otherwise — `asPluginRpcError` keeps the first and normalises
  // the second (A7 M1).
  throw asPluginRpcError(Cause.squash(result.cause));
};

/**
 * Build the `plugin.invoke` client. `readEnvironmentId` and `transport` are seams: the tests
 * drive the whole unwrap without an atom runtime, exactly as the analytics suites do.
 */
export function makePluginRpcClient(options?: {
  readonly readEnvironmentId?: () => EnvironmentId | null;
  readonly transport?: PluginInvokeTransport;
}): RpcPort {
  const readEnvironmentId =
    options?.readEnvironmentId ?? (() => appAtomRegistry.get(primaryEnvironmentIdAtom));
  const transport = options?.transport ?? defaultTransport;

  return async (pluginId, method, payload) => {
    const environmentId = readEnvironmentId();
    if (environmentId === null) {
      // No primary environment: the socket is not up (or has not been chosen yet). A plugin
      // must be able to tell that apart from "the server said no" — hence the reason code.
      throw new PluginRpcError({ reason: "plugin-failed", detail: "no active connection" });
    }
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      // Cannot happen through `makePluginInvoke` (the id comes from the host's own manifest
      // list), which is exactly why it must not be an unchecked cast: a `PluginId` that was
      // asserted rather than validated would be a lie the schema layer trusts. Reported as
      // the SDK's own error, like every other rejection this module can produce.
      throw new PluginRpcError({
        reason: "invalid-payload",
        detail: `"${pluginId}" is not a valid plugin id`,
      });
    }
    const input: PluginInvokeInput =
      payload === undefined
        ? { pluginId: PluginId.make(pluginId), method }
        : { pluginId: PluginId.make(pluginId), method, payload };
    try {
      return await transport({ environmentId, input });
    } catch (error) {
      // The last gate of the header's promise: whatever the transport rejected with — the
      // real one, or one injected here — leaves this function as a `PluginRpcError` (A7 M1).
      throw asPluginRpcError(error);
    }
  };
}

let installed = false;

/** Idempotent; called by `loadPlugins()` before any `activate(host)` runs. */
export function installPluginRpcPort(): void {
  if (installed) return;
  installed = true;
  setRpcPort(makePluginRpcClient());
}

/** Test seam. */
export function resetPluginRpcPortInstall(): void {
  installed = false;
}
