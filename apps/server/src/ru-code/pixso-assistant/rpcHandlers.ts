// ru-code: the Pixso MCP assistant WS RPC handlers, extracted out of ws.ts so the upstream
// file keeps only a tiny seam. Each handler authorizes via the host's
// `observePixsoAssistantRpc` wrapper (auth failures fold into `PixsoAssistantError`, the
// RPCs' one declared error) and forwards the decoded payload to the matching
// `PixsoAssistantShape` method. `PIXSO_ASSISTANT_RPC_SCOPES` is the per-method auth-scope
// table auth/RpcAuthorization.ts spreads into its `RPC_REQUIRED_SCOPES` record.

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { PIXSO_ASSISTANT_METHODS } from "@smart-tools/t3-code-pixso-mcp-assistant/contracts";
import type {
  GroupsMutateOp,
  PixsoAssistantError,
  RemoteTarget,
  ScanOrigin,
} from "@smart-tools/t3-code-pixso-mcp-assistant/contracts";
import type { PixsoAssistantShape } from "@smart-tools/t3-code-pixso-mcp-assistant/server";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/** The host's per-call wrapper: authorize (mapping an auth failure into
 *  `PixsoAssistantError`) + trace. Kept in ws.ts because it closes over the upstream
 *  authorize/instrument helpers. */
export type ObservePixsoAssistantRpc = <A, R>(
  method: string,
  effect: Effect.Effect<A, PixsoAssistantError, R>,
) => Effect.Effect<A, PixsoAssistantError, R>;

/** Stream variant — same auth folding, for the scan-job subscription. */
export type ObservePixsoAssistantRpcStream = <A, R>(
  method: string,
  stream: Stream.Stream<A, PixsoAssistantError, R>,
) => Stream.Stream<A, PixsoAssistantError, R>;

/** The method NAMES the assistant actually declares. Keying the scope table by this
 *  union — instead of `string` — makes a typo a compile error; as plain strings a wrong
 *  name silently produced an unscoped method that only failed at call time. */
type PixsoAssistantMethodName =
  (typeof PIXSO_ASSISTANT_METHODS)[keyof typeof PIXSO_ASSISTANT_METHODS];

/** Per-method required auth scope, spread into auth/RpcAuthorization.ts's
 *  `RPC_REQUIRED_SCOPES`. Reads use
 *  the orchestration read scope; mutations use operate — the catalog split. */
export const PIXSO_ASSISTANT_RPC_SCOPES = {
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantSnapshot]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantCard]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantCardRaw]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantCardImage]: AuthOrchestrationReadScope,
  // html-preview wave: reading the scan's stored `preview.html` is a read, same class as
  // `cardRaw`/`cardImage`. Without this row `ws.ts` fails fast on an unscoped method and the
  // RPC throws before ever reaching the handler map below.
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantCardHtml]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoveCard]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantGroupsMutate]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantReportLatest]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantCatalog]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantScanStart]: AuthOrchestrationOperateScope,
  // Resolve wave B (task 3): cancelling a running scan mutates the server's job state —
  // operate scope, the same class as scanStart.
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantScanCancel]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantScanSubscribe]: AuthOrchestrationReadScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantCheck]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantProbe]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRescanDebug]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantReparse]: AuthOrchestrationOperateScope,
  // R2-3 (task 18): the remote settings surface. Check/save/delete are mutations of the
  // server's remote-connection state — operate scope, same class as scanStart/reparse.
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteTokenCheck]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteTokenSave]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteTokenDelete]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteModeSet]: AuthOrchestrationOperateScope,
  // B2 (round-2 blocker): the reorg wave's Phase 2 added `remoteToolsList` to the
  // contract surface (`contracts/rpc.ts`) but never gave it a scope row here — `ws.ts`
  // fails fast on an unscoped method, so the RPC threw before ever reaching the
  // handler map below. Round-2 also adds the two REAL remote-probe RPCs (B3) — same
  // operate-scope class as `check`/`probe`/`rescanDebug` (they read the live remote
  // MCP AND write a report/dump, a mutation of server-owned diagnostics state).
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteToolsList]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteScanProbe]: AuthOrchestrationOperateScope,
  [PIXSO_ASSISTANT_METHODS.pixsoAssistantRemoteFullProbe]: AuthOrchestrationOperateScope,
} as const satisfies Record<PixsoAssistantMethodName, AuthEnvironmentScope>;

/** Build the assistant RPC handlers; ws.ts spreads the result into its
 *  `WsRpcGroup.toLayer` handler object. Input types come straight from the shape
 *  method parameters, so the map stays type-safe with no casts. */
export function buildPixsoAssistantRpcHandlers(deps: {
  readonly pixsoAssistant: PixsoAssistantShape;
  readonly observePixsoAssistantRpc: ObservePixsoAssistantRpc;
  readonly observePixsoAssistantRpcStream: ObservePixsoAssistantRpcStream;
}) {
  const { pixsoAssistant, observePixsoAssistantRpc, observePixsoAssistantRpcStream } = deps;
  const M = PIXSO_ASSISTANT_METHODS;
  return {
    [M.pixsoAssistantSnapshot]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantSnapshot, pixsoAssistant.getSnapshot()),
    [M.pixsoAssistantCard]: (input: { readonly id: string }) =>
      observePixsoAssistantRpc(M.pixsoAssistantCard, pixsoAssistant.getCard(input.id)),
    [M.pixsoAssistantCardRaw]: (input: { readonly id: string }) =>
      observePixsoAssistantRpc(M.pixsoAssistantCardRaw, pixsoAssistant.getCardRaw(input.id)),
    [M.pixsoAssistantCardImage]: (input: { readonly id: string }) =>
      observePixsoAssistantRpc(M.pixsoAssistantCardImage, pixsoAssistant.getCardImage(input.id)),
    // html-preview wave: the stored `preview.html` face — same shape as `cardRaw`.
    [M.pixsoAssistantCardHtml]: (input: { readonly id: string }) =>
      observePixsoAssistantRpc(M.pixsoAssistantCardHtml, pixsoAssistant.getCardHtml(input.id)),
    [M.pixsoAssistantRemoveCard]: (input: { readonly id: string }) =>
      observePixsoAssistantRpc(M.pixsoAssistantRemoveCard, pixsoAssistant.removeCard(input.id)),
    [M.pixsoAssistantGroupsMutate]: (input: { readonly mutation: GroupsMutateOp }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantGroupsMutate,
        pixsoAssistant.mutateGallery(input.mutation),
      ),
    [M.pixsoAssistantReportLatest]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantReportLatest, pixsoAssistant.getLatestReport()),
    [M.pixsoAssistantCatalog]: (input: { readonly catalogHash: string }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantCatalog,
        pixsoAssistant.getCatalog(input.catalogHash),
      ),
    [M.pixsoAssistantScanStart]: (input: { readonly target?: RemoteTarget | undefined }) =>
      observePixsoAssistantRpc(M.pixsoAssistantScanStart, pixsoAssistant.scanStart(input.target)),
    [M.pixsoAssistantScanCancel]: (input: { readonly origin?: ScanOrigin | undefined }) =>
      observePixsoAssistantRpc(M.pixsoAssistantScanCancel, pixsoAssistant.scanCancel(input.origin)),
    [M.pixsoAssistantScanSubscribe]: (_input: unknown) =>
      observePixsoAssistantRpcStream(M.pixsoAssistantScanSubscribe, pixsoAssistant.scanStates()),
    [M.pixsoAssistantCheck]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantCheck, pixsoAssistant.check()),
    [M.pixsoAssistantProbe]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantProbe, pixsoAssistant.probe()),
    [M.pixsoAssistantRescanDebug]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantRescanDebug, pixsoAssistant.rescanDebug()),
    [M.pixsoAssistantReparse]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantReparse, pixsoAssistant.reparseStored()),
    [M.pixsoAssistantRemoteTokenCheck]: (input: { readonly token?: string | undefined }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantRemoteTokenCheck,
        pixsoAssistant.remoteTokenCheck(input.token),
      ),
    [M.pixsoAssistantRemoteTokenSave]: (input: { readonly token: string }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantRemoteTokenSave,
        pixsoAssistant.remoteTokenSave(input.token),
      ),
    [M.pixsoAssistantRemoteTokenDelete]: (_input: unknown) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantRemoteTokenDelete,
        pixsoAssistant.remoteTokenDelete(),
      ),
    [M.pixsoAssistantRemoteModeSet]: (input: { readonly remoteByDefault: boolean }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantRemoteModeSet,
        pixsoAssistant.remoteModeSet(input.remoteByDefault),
      ),
    // B1/B2 (round-2 blockers): the three RPCs the reorg wave's Phase 2 designed but
    // never closed the loop on end-to-end.
    [M.pixsoAssistantRemoteToolsList]: (_input: unknown) =>
      observePixsoAssistantRpc(M.pixsoAssistantRemoteToolsList, pixsoAssistant.remoteToolsList()),
    [M.pixsoAssistantRemoteScanProbe]: (input: { readonly target: RemoteTarget }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantRemoteScanProbe,
        pixsoAssistant.remoteScanProbe(input.target),
      ),
    [M.pixsoAssistantRemoteFullProbe]: (input: { readonly target: RemoteTarget }) =>
      observePixsoAssistantRpc(
        M.pixsoAssistantRemoteFullProbe,
        pixsoAssistant.remoteFullProbe(input.target),
      ),
  };
}
