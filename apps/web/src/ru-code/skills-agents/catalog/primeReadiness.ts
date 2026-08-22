// ru-code: readiness gate for catalog RPC priming.
//
// The composer's catalog prime (useCatalogComposerItems) used to fire the
// snapshot RPC the moment the composer mounted. On a direct /draft/<id> reload
// the composer mounts BEFORE the environment catalog has loaded and before the
// primary environment's WS connection is up, so the prime either threw «Нет
// активного подключения к серверу» (primary id still null) or failed with the
// t3 EnvironmentRpcUnavailableError (id resolved, supervisor not connected) —
// both as UNHANDLED rejections, and the composer's $/# pickers then stayed
// empty (nothing retried: no effect dependency changed on connect).
//
// This hook is the gate: true only once the primary environment is resolved
// AND its supervisor reports phase "connected". Used as an effect dependency,
// it makes the prime fire (and re-fire) exactly when the RPC can succeed.

import { usePrimaryEnvironmentId } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { environmentCatalog } from "../../../connection/catalog";

import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";

/** Pure decision — exported for the law tests. */
export const isCatalogPrimeReady = (input: {
  readonly environmentIdResolved: boolean;
  readonly connectionPhase: SupervisorConnectionState["phase"] | null;
}): boolean => input.environmentIdResolved && input.connectionPhase === "connected";

/** Pure decision for the priming effect itself — exported for the law tests. */
export const shouldPrimeCatalog = (input: {
  readonly enabled: boolean;
  readonly rpcReady: boolean;
  readonly itemCount: number;
}): boolean => input.enabled && input.rpcReady && input.itemCount === 0;

export function usePrimaryEnvironmentRpcReady(): boolean {
  const environmentId = usePrimaryEnvironmentId();
  const connection = useEnvironmentQuery(
    environmentId === null ? null : environmentCatalog.stateAtom(environmentId),
  );
  return isCatalogPrimeReady({
    environmentIdResolved: environmentId !== null,
    connectionPhase: connection.data?.phase ?? null,
  });
}
