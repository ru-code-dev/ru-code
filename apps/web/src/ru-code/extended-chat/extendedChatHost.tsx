// ru-code: host seam for @smart-tools/qwen-cli-extended-chat (web). Adapts the app's
// runtime to the package's ports: the live ws subscription (with expected-failure
// RETRY — threads.ts parity, so a transient failure can never freeze the view until
// F5), the on-demand full-record fetch, the app's ChatMarkdown (user bubbles/prose
// render IDENTICALLY to the main chat) and the app locale. ChatView/ChatComposer
// import ONLY from this file — the app holds the icon and this adapter, nothing else.
import { useAtomValue } from "@effect/atom-react";
import { getLocale } from "@ru-code/localization";
import {
  applyTranscriptStreamItemLatched,
  configureExtendedChatLocale,
  EMPTY_TRANSCRIPT_VIEW,
  ExtendedChatProvider,
  ExtendedMessagesTimeline,
  type ExtendedChatWebPorts,
  type OptimisticSend,
  type PendingApprovalPayload,
  type TranscriptSubscriptionState,
} from "@smart-tools/qwen-cli-extended-chat/web";
import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { TRANSCRIPT_WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { EXTENDED_CHAT_TASKS_PIN_MODE } from "./extendedChatConfig";

// The package resolves its own bilingual strings — point it at the app locale.
configureExtendedChatLocale(getLocale);

// The view-mode control comes straight from the package; this re-export is the
// single import site for ChatView/ChatComposer. The mode itself is app state:
// server-settings default + per-thread composer-draft override (chatViewMode.ts).
export { ComposerViewSwitcher } from "@smart-tools/qwen-cli-extended-chat/web";

const transcriptSubscription = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "ru-code:extended-chat:transcript",
  subscribe: (input: { readonly threadId: ThreadId }) =>
    subscribe(TRANSCRIPT_WS_METHODS.subscribeTranscript, input, {
      // Main-chat parity (threads.ts): an EXPECTED failure retries instead of
      // freezing the atom in a dead state until reload.
      onExpectedFailure: () => Effect.void,
      retryExpectedFailureAfter: "3 seconds",
      // The LATCHED fold: a tail-target rebind (session bind / cwd provisioning)
      // can emit an honest empty first snapshot before qwen's first write — the
      // latch holds the populated view through it, so the first user message
      // never flickers away for a frame.
    }).pipe(Stream.scan(EMPTY_TRANSCRIPT_VIEW, applyTranscriptStreamItemLatched)),
});

/** Latest accumulated transcript for (environment, thread) as the package's view state. */
const transcriptStateAtom = Atom.family(
  (key: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) =>
    Atom.make((get): TranscriptSubscriptionState => {
      const result = get(
        transcriptSubscription({
          environmentId: key.environmentId,
          input: { threadId: key.threadId },
        }),
      );
      if (AsyncResult.isFailure(result)) {
        const failure: unknown = Cause.squash(result.cause);
        const message =
          typeof failure === "object" && failure !== null && "message" in failure
            ? String((failure as { message: unknown }).message)
            : String(failure);
        return { kind: "error", message };
      }
      return Option.match(AsyncResult.value(result), {
        onNone: () => ({ kind: "connecting" }) as const,
        onSome: (state) => ({ kind: "ready", transcript: state.transcript }) as const,
      });
    }).pipe(Atom.withLabel("ru-code:extended-chat:transcript-state")),
);

const recordBodyCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ru-code:extended-chat:record-body",
  tag: TRANSCRIPT_WS_METHODS.getTranscriptRecordBody,
});

export function ExtendedChatTimelineHost({
  environmentId,
  threadId,
  markdownCwd,
  resolvedTheme,
  bottomInset = 0,
  isWorking = false,
  workStartedAt = null,
  timestampFormat = "locale",
  pendingApproval = null,
  sendAnchorId = null,
  pendingSend = null,
  hideEmptyPlaceholder = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  bottomInset?: number;
  /** Live work state from ChatView — working timer shows BEFORE the first record. */
  isWorking?: boolean;
  workStartedAt?: string | null;
  /** The app's timestamp setting — user bubble time parity with the main chat. */
  timestampFormat?: "12-hour" | "24-hour" | "locale";
  /** The held ACP approval (derivePendingApprovals) — powers the honest
   *  «ожидает подтверждения» chip AND the held request's payload (command /
   *  proposed diff) on the awaiting row. */
  pendingApproval?: PendingApprovalPayload | null;
  /** The app's per-send optimistic MessageId (ChatView timelineAnchor) — a fresh
   *  value arms the send anchor: the new user row scrolls to the viewport top and
   *  the response streams into reserved end space (main-chat parity). */
  sendAnchorId?: string | null;
  /** The active send's optimistic message (ChatView `optimisticUserMessages`
   *  entry for `sendAnchorId`) — renders as a synthetic user bubble until the
   *  CLI writes the real record (draft-first send must never blink out). */
  pendingSend?: OptimisticSend | null;
  /** ChatView's draft-hero state (centered composer) — main-chat parity with
   *  MessagesTimeline `hideEmptyPlaceholder`: nothing renders behind the hero. */
  hideEmptyPlaceholder?: boolean;
}) {
  const subscription = useAtomValue(transcriptStateAtom({ environmentId, threadId }));
  const ports = useMemo<ExtendedChatWebPorts>(
    () => ({
      fetchRecordBody: async (uuid) => {
        const result = await recordBodyCommand.run(appAtomRegistry, {
          environmentId,
          input: { threadId, uuid },
        });
        if (!AsyncResult.isSuccess(result)) {
          throw Cause.squash(result.cause);
        }
        return result.value.record;
      },
      renderMarkdown: (text, cwd) => <ChatMarkdown text={text} cwd={cwd} />,
    }),
    [environmentId, threadId],
  );

  return (
    <ExtendedChatProvider ports={ports}>
      <ExtendedMessagesTimeline
        threadId={threadId}
        subscription={subscription}
        markdownCwd={markdownCwd}
        resolvedTheme={resolvedTheme}
        bottomInset={bottomInset}
        isWorking={isWorking}
        workStartedAt={workStartedAt}
        timestampFormat={timestampFormat}
        pendingApproval={pendingApproval}
        sendAnchorId={sendAnchorId}
        pendingSend={pendingSend}
        hideEmptyPlaceholder={hideEmptyPlaceholder}
        tasksPinMode={EXTENDED_CHAT_TASKS_PIN_MODE}
      />
    </ExtendedChatProvider>
  );
}
