// ru-code: the auto-update WS RPC handlers, extracted out of ws.ts so the
// upstream file keeps only a tiny seam (two spreads: the scope table and the
// handler map). Every handler is a thin forward into the UpdateEngine service —
// no logic lives here. Reads use the orchestration read scope, mutations the
// operate scope (same split as the rest of the app).

import {
  AUTO_UPDATE_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentAuthorizationError,
  type UpdateNotifyKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { UpdateEngine } from "./UpdateEngine.ts";

const M = AUTO_UPDATE_METHODS;

/** Per-method required auth scope, merged into auth/RpcAuthorization.ts's `RPC_REQUIRED_SCOPES`. */
export const AUTO_UPDATE_RPC_SCOPES = {
  [M.autoUpdateGetState]: AuthOrchestrationReadScope,
  [M.subscribeAutoUpdate]: AuthOrchestrationReadScope,
  [M.autoUpdateSetAutoCheck]: AuthOrchestrationOperateScope,
  [M.autoUpdateToggleSource]: AuthOrchestrationOperateScope,
  [M.autoUpdateSetNotifyPrefs]: AuthOrchestrationOperateScope,
  [M.autoUpdateTestGitHttps]: AuthOrchestrationOperateScope,
  [M.autoUpdateSaveGitHttps]: AuthOrchestrationOperateScope,
  [M.autoUpdateGenerateSshKey]: AuthOrchestrationOperateScope,
  [M.autoUpdateTestSsh]: AuthOrchestrationOperateScope,
  [M.autoUpdateSaveSsh]: AuthOrchestrationOperateScope,
  [M.autoUpdateClearGitCreds]: AuthOrchestrationOperateScope,
  [M.autoUpdateTestWebCreds]: AuthOrchestrationOperateScope,
  [M.autoUpdateSaveWebCreds]: AuthOrchestrationOperateScope,
  [M.autoUpdateClearWebCreds]: AuthOrchestrationOperateScope,
  [M.autoUpdateProbeSource]: AuthOrchestrationOperateScope,
  [M.autoUpdateCheckNow]: AuthOrchestrationOperateScope,
  [M.autoUpdateInstall]: AuthOrchestrationOperateScope,
  [M.autoUpdateRetryRun]: AuthOrchestrationOperateScope,
  [M.autoUpdateSnoozeNotification]: AuthOrchestrationOperateScope,
} as const;

/** ws.ts's per-call wrapper: authorize (scope from the table above) + trace. */
export type ObserveAutoUpdateRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

export type ObserveAutoUpdateRpcStreamEffect = <
  A,
  StreamError,
  StreamContext,
  EffectError,
  EffectContext,
>(
  method: string,
  effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Stream.Stream<
  A,
  StreamError | EffectError | EnvironmentAuthorizationError,
  StreamContext | EffectContext
>;

const TRACE = { "rpc.aggregate": "server" } as const;

/** Build the 19 auto-update RPC handlers; ws.ts spreads the result into `WsRpcGroup.of({...})`. */
export function buildAutoUpdateRpcHandlers(deps: {
  readonly updateEngine: UpdateEngine["Service"];
  readonly observeRpcEffect: ObserveAutoUpdateRpcEffect;
  readonly observeRpcStreamEffect: ObserveAutoUpdateRpcStreamEffect;
}) {
  const { updateEngine, observeRpcEffect, observeRpcStreamEffect } = deps;
  return {
    [M.autoUpdateGetState]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateGetState, updateEngine.state, TRACE),
    [M.autoUpdateSetAutoCheck]: (input: { readonly enabled: boolean }) =>
      observeRpcEffect(M.autoUpdateSetAutoCheck, updateEngine.setAutoCheck(input.enabled), TRACE),
    [M.autoUpdateToggleSource]: (input: {
      readonly kind: Parameters<UpdateEngine["Service"]["toggleSource"]>[0];
      readonly enabled: boolean;
    }) =>
      observeRpcEffect(
        M.autoUpdateToggleSource,
        updateEngine.toggleSource(input.kind, input.enabled),
        TRACE,
      ),
    [M.autoUpdateSetNotifyPrefs]: (input: {
      readonly releasesMuted: boolean;
      readonly problemsMuted: boolean;
    }) =>
      observeRpcEffect(
        M.autoUpdateSetNotifyPrefs,
        updateEngine.setNotifyPrefs({
          releasesMuted: input.releasesMuted,
          problemsMuted: input.problemsMuted,
        }),
        TRACE,
      ),
    [M.autoUpdateTestGitHttps]: (input: {
      readonly credentials: Parameters<UpdateEngine["Service"]["testGitHttps"]>[0];
    }) =>
      observeRpcEffect(
        M.autoUpdateTestGitHttps,
        updateEngine.testGitHttps(input.credentials),
        TRACE,
      ),
    [M.autoUpdateSaveGitHttps]: (input: {
      readonly credentials: Parameters<UpdateEngine["Service"]["saveGitHttps"]>[0];
    }) =>
      observeRpcEffect(
        M.autoUpdateSaveGitHttps,
        updateEngine.saveGitHttps(input.credentials),
        TRACE,
      ),
    [M.autoUpdateGenerateSshKey]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateGenerateSshKey, updateEngine.generateSshKey, TRACE),
    [M.autoUpdateTestSsh]: (input: {
      readonly key: Parameters<UpdateEngine["Service"]["testSsh"]>[0];
    }) => observeRpcEffect(M.autoUpdateTestSsh, updateEngine.testSsh(input.key), TRACE),
    [M.autoUpdateSaveSsh]: (input: {
      readonly key: Parameters<UpdateEngine["Service"]["saveSsh"]>[0];
    }) => observeRpcEffect(M.autoUpdateSaveSsh, updateEngine.saveSsh(input.key), TRACE),
    [M.autoUpdateClearGitCreds]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateClearGitCreds, updateEngine.clearGitCreds, TRACE),
    [M.autoUpdateTestWebCreds]: (input: {
      readonly credentials: Parameters<UpdateEngine["Service"]["testWebCreds"]>[0];
    }) =>
      observeRpcEffect(
        M.autoUpdateTestWebCreds,
        updateEngine.testWebCreds(input.credentials),
        TRACE,
      ),
    [M.autoUpdateSaveWebCreds]: (input: {
      readonly credentials: Parameters<UpdateEngine["Service"]["saveWebCreds"]>[0];
    }) =>
      observeRpcEffect(
        M.autoUpdateSaveWebCreds,
        updateEngine.saveWebCreds(input.credentials),
        TRACE,
      ),
    [M.autoUpdateClearWebCreds]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateClearWebCreds, updateEngine.clearWebCreds, TRACE),
    [M.autoUpdateProbeSource]: (input: {
      readonly kind: Parameters<UpdateEngine["Service"]["probeSource"]>[0];
    }) => observeRpcEffect(M.autoUpdateProbeSource, updateEngine.probeSource(input.kind), TRACE),
    [M.autoUpdateCheckNow]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateCheckNow, updateEngine.checkNow, TRACE),
    [M.autoUpdateInstall]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateInstall, updateEngine.install, TRACE),
    [M.autoUpdateRetryRun]: (_input: unknown) =>
      observeRpcEffect(M.autoUpdateRetryRun, updateEngine.retryRun, TRACE),
    [M.autoUpdateSnoozeNotification]: (input: { readonly kind: UpdateNotifyKind }) =>
      observeRpcEffect(
        M.autoUpdateSnoozeNotification,
        updateEngine.snoozeNotification(input.kind),
        TRACE,
      ),
    [M.subscribeAutoUpdate]: (_input: unknown) =>
      observeRpcStreamEffect(
        M.subscribeAutoUpdate,
        Effect.map(updateEngine.state, (snapshot) =>
          Stream.concat(Stream.make(snapshot), updateEngine.changes),
        ),
        TRACE,
      ),
  };
}
