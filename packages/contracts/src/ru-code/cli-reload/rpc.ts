// ru-code: CLI reload RPC definition. The host spreads `cliReloadRpcs` into its
// `WsRpcGroup.make(...)` (marked seam in packages/contracts/src/rpc.ts).
//
// ONE unary command, awaited to completion (owner ruling R2): the modal's confirm button
// shows a loader until it resolves, and a second press while a reload runs is a server-side
// no-op that resolves when the running one finishes — so the client needs no run state, no
// progress stream and no second method.

import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../../auth.ts";
import { CliReloadError, CliReloadResult } from "./model.ts";

/** Literal-keyed method map (host WS_METHODS retains literal typing through a spread). */
export const CLI_RELOAD_METHODS = {
  cliReload: "cliReload",
} as const;
export type CliReloadMethods = typeof CLI_RELOAD_METHODS;

const reloadError = Schema.Union([CliReloadError, EnvironmentAuthorizationError]);

/**
 * THE user press. Stops every qwen CLI process (sessions, warm spares, text-generation
 * children), closes the work they left parked, deletes the configured profile-dir entries
 * and clears the auth flag. Resolves only when all of that is done.
 */
export const WsCliReloadRpc = Rpc.make(CLI_RELOAD_METHODS.cliReload, {
  payload: Schema.Struct({}),
  success: CliReloadResult,
  error: reloadError,
});

/** All CLI-reload RPCs, ready to spread into the host's `RpcGroup.make(...)`. */
export const cliReloadRpcs = [WsCliReloadRpc] as const;
