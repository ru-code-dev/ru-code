// ru-code: per-thread chat view override in the composer draft store — same
// machinery as runtime/interaction mode, plus the FULL reload round-trip
// (partialize → merge), the layer the live bug lived in: the merge normalizer
// rebuilt each draft carrying interactionMode but dropped chatViewMode (and
// dropped view-only drafts entirely), so «Компактный/Подробный» reverted to the
// settings default on every F5 while plan/develop survived. Covers the marked
// seams in apps/web/src/composerDraftStore.ts.
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function threadKeyFor(threadId: ThreadId, environmentId: EnvironmentId) {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId) {
  const store = useComposerDraftStore.getState().draftsByThreadKey;
  return store[threadKeyFor(threadId, environmentId)] ?? store[threadId] ?? undefined;
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("composerDraftStore chat view override", () => {
  const threadId = ThreadId.make("thread-chat-view");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores the chat view override in the composer draft and clears back to no-draft", () => {
    const store = useComposerDraftStore.getState();

    store.setChatViewMode(threadRef, "detailed");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.chatViewMode).toBe("detailed");

    store.setChatViewMode(threadRef, "compact");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.chatViewMode).toBe("compact");

    store.setChatViewMode(threadRef, null);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("rejects an invalid chat view value instead of persisting garbage", () => {
    const store = useComposerDraftStore.getState();

    store.setChatViewMode(threadRef, "expanded" as never);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("keeps the chat view override across the persist → rehydrate round-trip", () => {
    const store = useComposerDraftStore.getState();
    store.setChatViewMode(threadRef, "detailed");

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState());
    // Simulate F5: merge the freshly persisted payload into a pristine store.
    const merged = persistApi
      .getOptions()
      .merge(JSON.parse(JSON.stringify(persisted)), useComposerDraftStore.getInitialState());

    const rehydratedDraft = merged.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)];
    expect(
      rehydratedDraft?.chatViewMode,
      "chat view override must survive rehydration exactly like interactionMode",
    ).toBe("detailed");
  });
});
