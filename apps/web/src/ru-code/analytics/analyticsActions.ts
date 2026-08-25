// ru-code: the analytics action half — promise wrappers over the environment-scoped
// RPC commands, exactly like the MCP/catalog clients: each call runs against the PRIMARY
// environment and unwraps the settled AsyncResult into resolve/reject.

import type { AnalyticsSnapshot } from "@smart-tools/qwen-cli-analytics/contracts";
import type { AnalyticsConnectionPhase } from "@smart-tools/qwen-cli-analytics/web";
import { connectionProjectionPhase } from "@t3tools/client-runtime/connection";
import { ANALYTICS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "~/state/query";

// Run one unary RPC against an environment and unwrap the settled result: resolve with
// the success value, reject with the squashed failure cause.
async function runAnalyticsRpc<TTag extends EnvironmentUnaryRpcTag>(
  tag: TTag,
  label: string,
  environmentId: EnvironmentId,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const command = createEnvironmentRpcCommand(connectionAtomRuntime, { label, tag });
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  throw Cause.squash(result.cause);
}

/** Instant load: the stored analytics rows (pure DB read, never scans disk). */
export function analyticsGetSnapshot(environmentId: EnvironmentId): Promise<AnalyticsSnapshot> {
  return runAnalyticsRpc(
    ANALYTICS_METHODS.analyticsGetSnapshot,
    "analytics:getSnapshot",
    environmentId,
    {},
  );
}

/** Rescan qwen's transcript tree, re-parse changed files, return the fresh snapshot. */
export function analyticsRefresh(environmentId: EnvironmentId): Promise<AnalyticsSnapshot> {
  return runAnalyticsRpc(
    ANALYTICS_METHODS.analyticsRefresh,
    "analytics:refresh",
    environmentId,
    {},
  );
}

/**
 * ru-code: can an analytics RPC succeed right now — and if not, WHY not?
 *
 * Passes the supervisor's own three-state projection straight through. It used to collapse
 * to a boolean, which made `synchronizing` (a transient worth waiting through) and
 * `disconnected` (a condition worth reporting) indistinguishable downstream: the panel
 * showed the same endless spinner for both, with the ⟳ disabled and no explanation. The
 * package now renders an offline message for one and a connecting note for the other.
 *
 * The panel mounts before the socket is up — the environment id comes from the persisted
 * catalog and is already known — so without this gate the first RPC fires into a dead
 * transport and nothing retries.
 *
 * A HOOK, not a value: the package's port is a hook so a phase change re-renders the panel
 * and re-runs its fetch effect. `useEnvironmentQuery` accepts a null atom and substitutes a
 * stable empty one, so hook order stays constant when no primary environment exists yet.
 * No primary environment ⇒ `disconnected`, which is exactly what it is.
 */
export function useAnalyticsConnectionPhase(
  environmentId: EnvironmentId | null,
): AnalyticsConnectionPhase {
  const { data } = useEnvironmentQuery(
    environmentId === null ? null : environmentCatalog.stateAtom(environmentId),
  );
  return data === null ? "disconnected" : connectionProjectionPhase(data);
}
