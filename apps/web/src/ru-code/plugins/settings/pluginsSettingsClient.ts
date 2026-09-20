// ru-code S38 (V2-43): the two RPCs the Plugins settings section is made of.
//
// It is NOT `rpcPort.ts`. That module is the door a PLUGIN calls through — parked while the socket
// is down, capped per plugin, every failure turned into the SDK's own `PluginRpcError` so a plugin
// author can act on it. These two calls are the HOST asking about itself: which folders it scanned
// and what the user has said about them. They take the app's own path (one environment command,
// one request, the failure as a plain `Error` the page renders), because the page is app UI and has
// an app's recourse — say so and offer the switch again.
//
// One environment: the PRIMARY one, exactly as `ctx.invoke` is pinned to it (V2-33's reasoning —
// the plugin host is the server this app is paired with, and there is no second host to ask).

import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { PLUGIN_METHODS, type PluginSettingsRow } from "@t3tools/contracts";
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { pluginConnectionAtom } from "../connectionAtom";
import { awaitPrimaryEnvironment } from "../rpcPort";

export type { PluginSettingsRow };

const listCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugin:settings",
  execute: (_input: Record<string, never>) => request(PLUGIN_METHODS.pluginSettings, {}),
});

const setEnabledCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugin:setEnabled",
  execute: (input: { readonly pluginId: PluginId; readonly enabled: boolean }) =>
    request(PLUGIN_METHODS.pluginSetEnabled, input),
});

/**
 * Settle one command into a value or an `Error` the page can render.
 *
 * Every failure — the transport, the scope, a typed `PluginRpcError` from the host — arrives as one
 * `Error`, because the page's recourse is the same for all of them: say it did not work and leave
 * the switch where the server last said it was.
 */
const settled = async <A>(run: Promise<AsyncResult.AsyncResult<A, unknown>>): Promise<A> => {
  const result = await run;
  if (AsyncResult.isSuccess(result)) return result.value;
  const squashed = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : undefined;
  throw squashed instanceof Error ? squashed : new Error(String(squashed ?? "the call failed"));
};

/**
 * Wait until the app has a server AND a live socket to it.
 *
 * TWO waits, because they are two facts and the page needs both: the primary environment has not
 * even been CHOSEN on a fresh load (S24 §3.2), and once it has, its socket is still coming up —
 * `client.ts` answers "<id> is not connected." for a request made in between, which is exactly what
 * this page showed the first time it was measured (`WORKFLOW/logs/S38/24-e2e-settings.log`).
 *
 * A page that answered that sentence and stopped would stay on it forever: nothing about it moves
 * again (rules §26 — the S24 class of defect, in the host's own UI this time). So the wait is a
 * subscription to the event that ends it and never a timer (rule 38): `pluginConnectionAtom` is the
 * app's own connection phase, the same one `ctx.connection` is derived from (V2-35).
 */
const awaitConnection = async (): Promise<EnvironmentId> => {
  const environmentId = await awaitPrimaryEnvironment();
  if (appAtomRegistry.get(pluginConnectionAtom) === "ready") return environmentId;
  await new Promise<void>((resolve) => {
    const unsubscribe = appAtomRegistry.subscribe(pluginConnectionAtom, (phase) => {
      if (phase !== "ready") return;
      unsubscribe();
      resolve();
    });
  });
  return environmentId;
};

/**
 * Every plugin the server scanned, with its root, its state and both switches.
 *
 * Waits for the connection rather than failing without one — see {@link awaitConnection}.
 */
export const fetchPluginSettings = async (): Promise<ReadonlyArray<PluginSettingsRow>> => {
  const environmentId = await awaitConnection();
  return await settled(listCommand.run(appAtomRegistry, { environmentId, input: {} }));
};

/** Record the user's switch for one plugin. Answers with the fresh rows. */
export const setPluginEnabled = async (
  pluginId: string,
  enabled: boolean,
): Promise<ReadonlyArray<PluginSettingsRow>> => {
  const environmentId = await awaitConnection();
  // The brand is minted HERE, at the one boundary a page id enters the wire through: the id comes
  // from a row the server itself listed, so it is a plugin id by construction — but an asserted
  // brand is a lie the schema layer trusts, and this is the pattern `rpcPort.ts` already follows.
  return await settled(
    setEnabledCommand.run(appAtomRegistry, {
      environmentId,
      input: { pluginId: PluginId.make(pluginId), enabled },
    }),
  );
};
