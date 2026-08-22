// ru-code: the HTTP transport the auto-update engine — and ONLY the auto-update engine — runs on.
//
// Release hosts in this deployment present certificates signed by an internal CA that user machines
// do not carry, so a verifying client cannot reach them at all (see DISABLE_SSL in
// ru-code/branding/src/auto-update.ts). The permissive setting is carried by an https.Agent owned by
// this layer, which is provided ONLY into the update engine's layer graph. It is deliberately NOT
// `NODE_TLS_REJECT_UNAUTHORIZED`, which is a process-wide switch: that would silently disable
// verification for provider calls, auth and every other outbound request the app makes.
//
// The transport is the node client in BOTH modes — the flag toggles exactly one agent option and
// nothing else. Choosing a different client per mode would leave the strict path running code the
// permissive path never exercises (and vice versa), including the transport-error text the failure
// classifier reads.
// @effect-diagnostics nodeBuiltinImport:off - the permissive agent IS a node https.Agent option
// bag; this module is the seam that hands it to the Effect HttpClient, and only the TYPE is imported.

import type * as NodeHttps from "node:https";

import * as Layer from "effect/Layer";
import type { HttpClient } from "effect/unstable/http";
import { NodeHttpClient } from "@effect/platform-node";

import { DISABLE_SSL } from "@ru-code/branding";

/**
 * The agent options for the update transport. `rejectUnauthorized:false` is the ONLY difference
 * between the two modes; everything else is node's default agent behaviour. Pure, so both branches
 * are unit-testable without building a layer.
 */
export const updateHttpAgentOptions = (disableSsl: boolean): NodeHttps.AgentOptions =>
  disableSsl ? { rejectUnauthorized: false } : {};

/**
 * Build the engine's `HttpClient` layer. Exported as a function of the flag so a test can build the
 * strict client and the permissive one from the same code path; production uses
 * {@link UpdateHttpClientLayer}.
 */
export const buildUpdateHttpClientLayer = (
  disableSsl: boolean,
): Layer.Layer<HttpClient.HttpClient> =>
  NodeHttpClient.layerNodeHttpNoAgent.pipe(
    Layer.provide(NodeHttpClient.layerAgentOptions(updateHttpAgentOptions(disableSsl))),
  );

/** The transport the shipped engine uses, wired from the baked branding flag. */
export const UpdateHttpClientLayer: Layer.Layer<HttpClient.HttpClient> =
  buildUpdateHttpClientLayer(DISABLE_SSL);
