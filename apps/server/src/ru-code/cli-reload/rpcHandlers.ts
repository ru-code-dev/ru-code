// ru-code: the CLI-reload WS RPC handler, extracted out of ws.ts so the upstream file keeps
// only a tiny seam (two spreads: the scope table and the handler map). The handler is a thin
// forward into the CliReloadEngine service — no logic lives here.

import {
  AuthOrchestrationOperateScope,
  CLI_RELOAD_METHODS,
  type EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CliReloadEngine } from "./CliReloadService.ts";

const M = CLI_RELOAD_METHODS;

/** Per-method required auth scope, merged into auth/RpcAuthorization.ts's `RPC_REQUIRED_SCOPES`. */
export const CLI_RELOAD_RPC_SCOPES = {
  [M.cliReload]: AuthOrchestrationOperateScope,
} as const;

/** ws.ts's per-call wrapper: authorize (scope from the table above) + trace. */
export type ObserveCliReloadRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

const TRACE = { "rpc.aggregate": "server" } as const;

/** Build the CLI-reload RPC handler; ws.ts spreads the result into `WsRpcGroup.of({...})`. */
export function buildCliReloadRpcHandlers(deps: {
  readonly cliReload: CliReloadEngine["Service"];
  readonly observeRpcEffect: ObserveCliReloadRpcEffect;
}) {
  const { cliReload, observeRpcEffect } = deps;
  return {
    [M.cliReload]: (_input: unknown) =>
      observeRpcEffect(
        M.cliReload,
        // The success payload is a struct so the wire can grow without a break; the reload
        // itself has nothing to report — it either finished or it failed (owner ruling R7).
        Effect.as(cliReload.reload, { ok: true } as const),
        TRACE,
      ),
  };
}
