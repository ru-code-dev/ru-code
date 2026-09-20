// ru-code v2: `ctx.invoke(method, payload)` — `plugin.invoke` for this plugin id.
//
// One unary RPC against the PRIMARY environment, read from `appAtomRegistry` at call time (not
// captured — the primary environment appears and switches while the app runs), with the settled
// `AsyncResult` unwrapped into resolve/reject.
//
// EVERY rejection is the SDK's own `PluginRpcError`, so a plugin's `catch` is written once against
// one error type whether the failure came from the server or from the transport — and, since S28
// (V2-35), a call is never REFUSED for a reason the plugin cannot see: one made while the socket
// is down is parked and sent when the session is up, and `plugin-failed` means only "the handler
// threw".
// S104 (V2-73): a COMMAND's answer never overtakes the state it follows. The wire's answer carries
// the server's state position when the handler returned, and the call resolves only once this tab's
// `ctx.state` has reached it (`state.ts` `awaitPluginState`) — so a plugin whose server half
// published before it answered sees that value in `ctx.state` by the time `invoke` resolves, and a
// busy flag held for exactly the call's lifetime can never show an idle moment before the value.
// A READ (`ctx.query`, `makePluginRead`) is not held: its result is its answer.
//
// v1 also carried a PORT indirection here — a settable `RpcPort` whose default rejected with "this
// arrives in a later phase" — which was a build-order artefact of the original plan and, once the
// real client landed, dead code with its own tests. v2 builds the client lazily and keeps one
// injection point, for the tests that drive the unwrap without an atom runtime.

import { PLUGIN_ID_PATTERN, PluginId, PluginRpcError } from "@smart-tools/plugin-sdk/contracts";
import type { PluginConnection } from "@smart-tools/plugin-sdk/host";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { PLUGIN_METHODS } from "@t3tools/contracts";
import type { EnvironmentId, PluginStatePosition } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult } from "effect/unstable/reactivity";

import { L } from "@ru-code/localization";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { MAX_PARKED_INVOKES_PER_PLUGIN } from "./caps";
import { pluginConnectionAtom } from "./connectionAtom";
import { reportPluginProblem } from "./problems";
import { awaitPluginState } from "./state";

// --------------------------------------------------------------------------
// The client
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

/** What one dispatch came back with — the handler's value, and where the server's state stood then. */
export type PluginInvokeOutcome =
  | { readonly _tag: "Answered"; readonly value: unknown; readonly state: PluginStatePosition }
  | { readonly _tag: "Failed"; readonly failure: unknown };

/** How one `plugin.invoke` reaches the server. Injected in tests (no atom runtime needed). */
export type PluginInvokeTransport = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: PluginInvokeInput;
}) => Promise<PluginInvokeOutcome>;

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
 * S28 (V2-35): the SERVER's own `PluginRpcError` passes through untouched — `plugin-failed` means
 * "the handler threw" and nothing else. Everything else that can reach here is a TRANSPORT
 * failure (the socket dropped mid-call, the environment went away, a parked call the host could
 * not hold) and is reported as `transport`, with the underlying message as `detail` and the
 * original on `Error.cause` for the devtools.
 */
function asPluginRpcError(error: unknown): PluginRpcError {
  if (isPluginRpcError(error)) return error;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? (error as { readonly message?: unknown }).message
      : undefined;
  const wrapped = new PluginRpcError({
    reason: "transport",
    detail: typeof message === "string" ? message : String(error),
  });
  wrapped.cause = error;
  return wrapped;
}

/**
 * The value a settled `plugin.invoke` command failed WITH, read off its cause in the order the
 * caller needs it: a typed failure (the server's own `PluginRpcError`, the protocol's
 * `RpcClientError`, the registry's `EnvironmentNotRegisteredError`) as itself; a DEFECT as the
 * thrown value; and an INTERRUPT — the request fiber abandoned because the session's scope closed
 * under it, i.e. the socket dropped MID-CALL — as a tagged marker carrying a sentence of its own.
 * `Cause.squash` alone loses the last case: it hands back a bare `Error` with nothing worth
 * showing in it.
 */
export const failureOfCause = (cause: Cause.Cause<unknown>): unknown => {
  if (Cause.hasFails(cause)) {
    const error = Cause.findError(cause);
    if (error._tag === "Success") return error.success;
  }
  if (Cause.hasDies(cause)) {
    const defect = Cause.findDefect(cause);
    if (defect._tag === "Success") return defect.success;
  }
  if (Cause.hasInterrupts(cause)) {
    return {
      _tag: "RpcInterrupted",
      message: "the connection was lost while the call was in flight",
    };
  }
  return Cause.squash(cause);
};

/**
 * The `plugin.invoke` request, settled into a {@link PluginInvokeOutcome}.
 *
 * ru-code (A5): the tag is `PLUGIN_METHODS.pluginInvoke` from the contract itself — a rename on the
 * wire is a compile error here.
 */
const invokeCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugin:invoke",
  execute: (input: PluginInvokeInput) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(request(PLUGIN_METHODS.pluginInvoke, input));
      return Exit.isSuccess(exit)
        ? ({
            _tag: "Answered",
            value: exit.value.value,
            state: { boot: exit.value.boot, seq: exit.value.seq },
          } satisfies PluginInvokeOutcome)
        : ({ _tag: "Failed", failure: failureOfCause(exit.cause) } satisfies PluginInvokeOutcome);
    }),
});

const defaultTransport: PluginInvokeTransport = async ({ environmentId, input }) => {
  const result = await invokeCommand.run(appAtomRegistry, { environmentId, input });
  return AsyncResult.isSuccess(result)
    ? result.value
    : // The command failed AROUND the request — the environment is not registered, or the fiber
      // was interrupted before it could settle.
      { _tag: "Failed", failure: failureOfCause(result.cause) };
};

/**
 * Wait until the primary environment exists — the socket has not even been CHOSEN yet on a fresh
 * page load (S24 §3.2 `rpcPort.ts:126-130`). Resolves at once when it already does.
 *
 * EXPORTED (S38): the Settings ▸ Plugins section asks the host about itself the moment it mounts,
 * and a user who lands on `/settings/plugins` directly gets there before the app has chosen a
 * server. It is the same wait for the same reason — no timer, one subscription, resolved by the
 * event that ends it.
 */
export const awaitPrimaryEnvironment = (): Promise<EnvironmentId> =>
  new Promise<EnvironmentId>((resolve) => {
    const current = appAtomRegistry.get(primaryEnvironmentIdAtom);
    if (current !== null) {
      resolve(current);
      return;
    }
    const unsubscribe = appAtomRegistry.subscribe(primaryEnvironmentIdAtom, (environmentId) => {
      if (environmentId === null) return;
      unsubscribe();
      resolve(environmentId);
    });
  });

/**
 * Wait until the environment's supervisor holds a LIVE session — the same `SubscriptionRef` the
 * app's own connection projection is derived from (`connections.ts` `stateAtom` follows
 * `supervisor.state`; the session ref is set in the same step, `supervisor.ts:574-586`). No timer,
 * no polling: `SubscriptionRef.changes` emits the current value and then every change, so a live
 * session resolves at once and a dead one resolves the moment the next attempt connects.
 *
 * Rejects with `EnvironmentNotRegisteredError` when the environment is REMOVED while a call waits
 * — the one way a parked call is ever cancelled.
 */
const awaitSessionCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugin:await-session",
  execute: () =>
    EnvironmentSupervisor.pipe(
      Effect.flatMap((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filter(Option.isSome),
          Stream.runHead,
        ),
      ),
      Effect.asVoid,
    ),
});

const defaultAwaitLiveSession = async (environmentId: EnvironmentId): Promise<void> => {
  const result = await awaitSessionCommand.run(appAtomRegistry, {
    environmentId,
    input: undefined,
  });
  if (!AsyncResult.isSuccess(result)) throw failureOfCause(result.cause);
};

/** Is the primary environment's transport live RIGHT NOW — the same value `ctx.connection` reads. */
const defaultReadConnection = (): PluginConnection => appAtomRegistry.get(pluginConnectionAtom);

/** How many calls each plugin holds parked right now (S28 cap, `caps.ts`). */
const parkedCounts = new Map<string, number>();

/** Test seam. */
export function resetPluginRpcParkingForTests(): void {
  parkedCounts.clear();
}

const reportParkedCap = (pluginId: string): void => {
  reportPluginProblem({
    kind: "error",
    pluginId,
    code: "cap:invoke-parked",
    title: L(
      `Plugin "${pluginId}" has too many calls waiting for the connection`,
      `Плагин «${pluginId}» держит слишком много вызовов в ожидании соединения`,
    ),
    detail: L(
      `at most ${String(MAX_PARKED_INVOKES_PER_PLUGIN)} parked \`invoke\` calls per plugin; the rest are rejected with \`transport\``,
      `не более ${String(MAX_PARKED_INVOKES_PER_PLUGIN)} ожидающих вызовов \`invoke\` на плагин; остальные отклоняются с \`transport\``,
    ),
  });
};

/**
 * Build the `plugin.invoke` client. Every dependency is a seam: the tests drive parking, dispatch,
 * cancellation and the reason mapping without an atom runtime, exactly as the analytics suites do.
 *
 * THE RULE (S28, V2-35): a call is DISPATCHED only against a live session. When the primary
 * environment is chosen and its transport reads `ready` — decided SYNCHRONOUSLY, off the same atom
 * `ctx.connection` is — the call goes straight through (S33 A2): nothing is counted, nothing can
 * be capped, because nothing waits. Otherwise the call is PARKED in the plugin's promise, with no
 * timer, under the per-plugin cap: first for the primary environment, then for its session.
 *
 * A call that LEFT is never sent again (S37). S28 sent one more frame whenever it could "prove"
 * the first never left, and S33 taught that proof to recognise the WebSocket standard's
 * `InvalidStateError` — a throw `send` only makes on a socket that is not OPEN, which this
 * transport's write never is (it writes under `latch.whenOpen`). The only thing that ever
 * produced it was a spec hooking `WebSocket.prototype.send`, so the branch served an injected
 * fault and nothing else (rule 36). `plugin.invoke` costs the OPERATE scope and the contract
 * carries no idempotency key, so "we think it did not arrive" was never reason enough to run a
 * plugin's handler twice. A failure after the dispatch is the plugin's to see: the server's own
 * `PluginRpcError` untouched, everything else `transport`.
 */
export function makePluginRpcClient(options?: {
  readonly readEnvironmentId?: () => EnvironmentId | null;
  readonly readConnection?: () => PluginConnection;
  readonly awaitPrimaryEnvironment?: () => Promise<EnvironmentId>;
  readonly awaitLiveSession?: (environmentId: EnvironmentId) => Promise<void>;
  readonly transport?: PluginInvokeTransport;
  /** S104: what a COMMAND awaits after its answer (`state.ts` `awaitPluginState`). */
  readonly awaitState?: (position: PluginStatePosition) => Promise<void>;
}): RpcPort {
  const readEnvironmentId =
    options?.readEnvironmentId ?? (() => appAtomRegistry.get(primaryEnvironmentIdAtom));
  const readConnection = options?.readConnection ?? defaultReadConnection;
  const awaitEnvironment = options?.awaitPrimaryEnvironment ?? awaitPrimaryEnvironment;
  const awaitLiveSession = options?.awaitLiveSession ?? defaultAwaitLiveSession;
  const transport = options?.transport ?? defaultTransport;
  const awaitState = options?.awaitState ?? awaitPluginState;

  /** The environment a call may go to RIGHT NOW, or `null` when it has to wait. */
  const liveEnvironment = (): EnvironmentId | null => {
    const environmentId = readEnvironmentId();
    return environmentId !== null && readConnection() === "ready" ? environmentId : null;
  };

  /** Hold the call until the transport is live, under the per-plugin cap. Only WAITING calls count. */
  const park = async (pluginId: string): Promise<EnvironmentId> => {
    const parked = parkedCounts.get(pluginId) ?? 0;
    if (parked >= MAX_PARKED_INVOKES_PER_PLUGIN) {
      reportParkedCap(pluginId);
      throw new PluginRpcError({
        reason: "transport",
        detail: `the connection is not ready and ${String(MAX_PARKED_INVOKES_PER_PLUGIN)} calls are already waiting`,
      });
    }
    parkedCounts.set(pluginId, parked + 1);
    try {
      const environmentId = readEnvironmentId() ?? (await awaitEnvironment());
      await awaitLiveSession(environmentId);
      return environmentId;
    } finally {
      const now = parkedCounts.get(pluginId) ?? 1;
      if (now <= 1) parkedCounts.delete(pluginId);
      else parkedCounts.set(pluginId, now - 1);
    }
  };

  return async (pluginId, method, payload, kind = "command") => {
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
      const outcome = await transport({
        environmentId: liveEnvironment() ?? (await park(pluginId)),
        input,
      });
      if (outcome._tag !== "Answered") throw outcome.failure;
      // S104 (V2-73): a command resolves once `ctx.state` holds what was published before its
      // answer. The wait ends on a frame, a snapshot or the stream's end (`state.ts`), never rejects.
      if (kind === "command") await awaitState(outcome.state);
      return outcome.value;
    } catch (error) {
      throw asPluginRpcError(error);
    }
  };
}

/**
 * What one plugin's `ctx.invoke` calls. A `"command"` (the default) resolves once the tab's state
 * has caught up with its answer; a `"read"` — `ctx.query`'s rounds — resolves at the answer.
 */
export type RpcPort = (
  pluginId: string,
  method: string,
  payload?: unknown,
  kind?: "command" | "read",
) => Promise<unknown>;

/**
 * The one client, built on first use.
 *
 * Lazy because building it reads the atom runtime, and this module is imported by the loader long
 * before a plugin calls anything. `setPluginRpcPortForTests` is the single seam — the tests that
 * exercise a plugin's error handling need a transport, not an environment.
 */
let port: RpcPort | null = null;

const activePort = (): RpcPort => {
  port ??= makePluginRpcClient();
  return port;
};

/** Test seam. Pass `null` to restore the real client. */
export function setPluginRpcPortForTests(next: RpcPort | null): void {
  port = next;
}

/**
 * The `invoke` member of one plugin's ctx.
 *
 * `Result` is an ASSERTION, not a validation — the host cannot know a plugin's own shapes, and
 * every real call site was writing the cast by hand. This is the one place in the app that spells
 * it.
 */
export function makePluginInvoke(pluginId: string) {
  return <Result = unknown>(method: string, payload?: unknown): Promise<Result> =>
    activePort()(pluginId, method, payload) as Promise<Result>;
}

/**
 * The same call as a READ (S104): `ctx.query`'s rounds. Its result IS its answer, so it is not held
 * for the tab's state (V2-59/60 unchanged).
 */
export function makePluginRead(pluginId: string) {
  return (method: string, payload?: unknown): Promise<unknown> =>
    activePort()(pluginId, method, payload, "read");
}
