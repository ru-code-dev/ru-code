// ru-code: CLI reload — the action behind the sidebar-header restart button.
//
// Why: the CLI's auth token expires after ~13h. Agents left running overnight start failing
// once it lapses. A reload kills every CLI process the server owns, closes the work they left
// parked, deletes the configured profile-dir entries and re-arms the auth gate, which resets
// that window. This module is the single transport seam the UI calls — the component knows
// only "await this".
//
// The RPC is UNARY and awaited to completion (owner ruling R2): it resolves when the server
// is really done, which is what lets the confirm button hold a loader until then. A second
// press while a reload runs is a server-side no-op that resolves with the running one's
// result — the client needs no run state of its own.

import { CLI_RELOAD_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

/** Raised when no environment is connected — the modal turns this into the same generic line. */
export class CliReloadNotConnectedError extends Error {
  readonly code = "not-connected";
  constructor() {
    super("cli-reload: no primary environment connected");
    this.name = "CliReloadNotConnectedError";
  }
}

/**
 * Restart every active CLI session and refresh authorization. Rejects on any failure; the
 * caller shows ONE generic line (owner ruling R7 — details live in the server's debug log).
 */
export async function requestCliReload(): Promise<void> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    throw new CliReloadNotConnectedError();
  }
  const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cli-reload:reload",
    tag: CLI_RELOAD_METHODS.cliReload,
  });
  const result = await command.run(appAtomRegistry, { environmentId, input: {} });
  if (AsyncResult.isSuccess(result)) {
    return;
  }
  throw Cause.squash(result.cause);
}
