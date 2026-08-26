// ru-code: host seam for @smart-tools/t3-code-pixso-mcp-assistant (web). Adapts the
// app's runtime to the package's ports: the RPC client (unary commands + the scan-job
// subscription over the primary environment), the theme/toast surfaces (the skills
// hostPorts idiom + the chat-bubble anchored toast), the composer review-comment
// bridge (the SAME mechanism file-navigator comments use), the route-following
// composer target, and the app locale. The panel registry imports ONLY this file.

import { useParams } from "@tanstack/react-router";
import { getLocale, L } from "@ru-code/localization";
import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import { PIXSO_ASSISTANT_METHODS } from "@smart-tools/t3-code-pixso-mcp-assistant/contracts";
import {
  configurePixsoAssistantLocale,
  configurePixsoAssistantPorts,
  PixsoAssistantPanel,
  resetPixsoAuthority,
  type ComposerThreadTarget,
  type PixsoAssistantClient,
  type ReviewCommentContext,
} from "@smart-tools/t3-code-pixso-mcp-assistant/web";
import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { anchoredToastManager } from "~/components/ui/toast";
import { connectionAtomRuntime } from "~/connection/runtime";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerThreadTarget as HostComposerTarget,
} from "~/composerDraftStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { toastError, useResolvedTheme } from "../skills-agents/catalog/hostPorts";

// The package resolves its own bilingual strings — point it at the app locale.
configurePixsoAssistantLocale(getLocale);

const M = PIXSO_ASSISTANT_METHODS;

/** Run one unary assistant RPC against the primary environment (the catalog idiom). */
async function runRpc<TTag extends EnvironmentUnaryRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    throw new Error(L("No active server connection.", "Нет активного подключения к серверу."));
  }
  const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: `pixso:${tag}`,
    tag,
  });
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  throw Cause.squash(result.cause);
}

/** The scan-job subscription (snapshot ++ changes), latest event per environment. */
const scanSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "ru-code:pixso:scan",
  tag: M.pixsoAssistantScanSubscribe,
});

/** The latest scan-job state for the primary environment, or null before one connects.
 *  REACTIVE (mirrors ru-code/mcp/mcpState.ts and auto-update): it re-runs when the primary
 *  environment appears or switches, so the subscription re-binds instead of being resolved
 *  once at mount — a null environment at mount used to make subscribeScan a permanent no-op. */
const scanEventAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.getOrNull(AsyncResult.value(get(scanSubscription({ environmentId, input: {} }))));
}).pipe(Atom.withLabel("ru-code:pixso:scan-event"));

const client: PixsoAssistantClient = {
  snapshot: () => runRpc(M.pixsoAssistantSnapshot, {}),
  card: (id) => runRpc(M.pixsoAssistantCard, { id }),
  cardRaw: (id) => runRpc(M.pixsoAssistantCardRaw, { id }),
  cardImage: (id) => runRpc(M.pixsoAssistantCardImage, { id }),
  // html-preview wave: THE load-bug fix. The port gained `cardHtml` but this host client
  // never followed, so `client.cardHtml` was `undefined` — the store's `loadHtml` threw a
  // synchronous TypeError before its promise chain existed, so neither the success nor the
  // failure branch ever ran and the block sat on «Загрузка HTML…» forever.
  cardHtml: (id) => runRpc(M.pixsoAssistantCardHtml, { id }),
  catalog: (catalogHash) => runRpc(M.pixsoAssistantCatalog, { catalogHash }),
  removeCard: (id) => runRpc(M.pixsoAssistantRemoveCard, { id }),
  groupsMutate: (mutation) => runRpc(M.pixsoAssistantGroupsMutate, { mutation }),
  reportLatest: () => runRpc(M.pixsoAssistantReportLatest, {}),
  scanStart: (target) => runRpc(M.pixsoAssistantScanStart, { target }),
  // Resolve wave B (task 3): the cancel wire — same mechanical shape as every RPC here.
  scanCancel: (origin) => runRpc(M.pixsoAssistantScanCancel, { origin }),
  check: () => runRpc(M.pixsoAssistantCheck, {}),
  probe: () => runRpc(M.pixsoAssistantProbe, {}),
  rescanDebug: () => runRpc(M.pixsoAssistantRescanDebug, {}),
  reparse: () => runRpc(M.pixsoAssistantReparse, {}),
  subscribeScan: (listener) =>
    appAtomRegistry.subscribe(
      scanEventAtom,
      (value) => {
        if (value !== null) listener(value);
      },
      { immediate: true },
    ),
  remoteTokenCheck: (token) => runRpc(M.pixsoAssistantRemoteTokenCheck, { token }),
  remoteTokenSave: (token) => runRpc(M.pixsoAssistantRemoteTokenSave, { token }),
  remoteTokenDelete: () => runRpc(M.pixsoAssistantRemoteTokenDelete, {}),
  remoteModeSet: (remoteByDefault) => runRpc(M.pixsoAssistantRemoteModeSet, { remoteByDefault }),
  // B1 (round-2 blocker): the contract surface moved in the reorg wave's Phase 2
  // (`ports.ts` gained these three members) but this host client never followed — the
  // accountability gap the round-2 dispatch names. Mechanical, same shape as every RPC
  // above.
  remoteToolsList: () => runRpc(M.pixsoAssistantRemoteToolsList, {}),
  remoteScanProbe: (target) => runRpc(M.pixsoAssistantRemoteScanProbe, { target }),
  remoteFullProbe: (target) => runRpc(M.pixsoAssistantRemoteFullProbe, { target }),
};

/** The active composer target following the route — the ComposerTargetSync source. */
function useActiveComposerTarget(): ComposerThreadTarget | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  // Structural narrowing (no tag-string comparison — the L() compare-guard stays quiet).
  if (routeTarget === null || routeTarget === undefined) return null;
  if ("threadRef" in routeTarget) return routeTarget.threadRef;
  if ("draftId" in routeTarget) return routeTarget.draftId;
  return null;
}

/** Package targets originate from `useActiveComposerTarget` (host values, widened) —
 *  re-brand them through the validating constructors on the way back. */
const toHostTarget = (target: ComposerThreadTarget): HostComposerTarget =>
  typeof target === "string"
    ? DraftId.make(target)
    : {
        environmentId: EnvironmentId.make(target.environmentId),
        threadId: ThreadId.make(target.threadId),
      };

configurePixsoAssistantPorts({
  client,
  useResolvedTheme,
  useActiveComposerTarget,
  toastError,
  anchoredToast: ({ anchor, title, description, timeoutMs }) => {
    anchoredToastManager.add({
      data: { tooltipStyle: true },
      positionerProps: { anchor },
      timeout: timeoutMs,
      title,
      ...(description !== undefined ? { description } : {}),
    });
  },
  composer: {
    addReviewComment: (target, comment: ReviewCommentContext) =>
      useComposerDraftStore.getState().addReviewComment(toHostTarget(target), comment),
    removeReviewComment: (target, commentId) =>
      useComposerDraftStore.getState().removeReviewComment(toHostTarget(target), commentId),
    getReviewCommentIds: (target) => {
      const draft = useComposerDraftStore.getState().getComposerDraft(toHostTarget(target));
      return draft === null ? null : draft.reviewComments.map((comment) => comment.id);
    },
    subscribe: (listener) => useComposerDraftStore.subscribe(listener),
  },
});

let previousEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
appAtomRegistry.subscribe(primaryEnvironmentIdAtom, (environmentId) => {
  if (environmentId !== previousEnvironmentId) {
    previousEnvironmentId = environmentId;
    resetPixsoAuthority();
  }
});

export function PixsoAssistantPanelHost({
  onClose,
  mode,
}: {
  readonly onClose: () => void;
  readonly mode: DiffPanelMode;
}) {
  return <PixsoAssistantPanel onClose={onClose} mode={mode} />;
}
