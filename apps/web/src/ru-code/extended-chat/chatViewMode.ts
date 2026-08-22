// ru-code: the ONE chat-view-mode resolution — plan-mode parity (see
// ChatView's runtimeMode): composer override (what the user just clicked,
// staging) → thread's pinned choice (durable authority, survives promotion/F5/
// devices) → server-settings default. ChatView (which timeline renders) and
// ChatComposer (the switcher) both read THIS hook, so the two surfaces can
// never disagree about the active mode.
import type { ChatViewMode } from "@t3tools/contracts/settings";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";

export function resolveChatViewMode(
  override: ChatViewMode | null,
  threadChatViewMode: ChatViewMode | null,
  settingsDefault: ChatViewMode,
): ChatViewMode {
  return override ?? threadChatViewMode ?? settingsDefault;
}

export function useChatViewMode(
  target: ComposerThreadTarget,
  threadChatViewMode: ChatViewMode | null,
  settingsDefault: ChatViewMode,
): ChatViewMode {
  const override = useComposerDraftStore(
    (store) => store.getComposerDraft(target)?.chatViewMode ?? null,
  );
  return resolveChatViewMode(override, threadChatViewMode, settingsDefault);
}
