// ru-code: plugins — `ctx.composer`, the composer's CONTEXT-CARD seam (decision V2-48).
//
// WHY IT EXISTS. `composer.items` puts rows in the `/` `$` `#` menus and a row pastes text. A
// surface that hands the composer a CARD the user keeps, detaches and sends has no seam at all —
// a gallery whose "+" buttons attach an item's payload to the draft the user is looking at is
// exactly that. The first such surface was compiled into the app and reached `composerDraftStore`
// directly; nothing in the seam list covers it from a plugin, so the port that moved it out
// proposed this one (rule 9, decision V2-48).
//
// WHAT IT IS, EXACTLY. The app's composer already carries REVIEW COMMENTS — the chips a
// file-navigator selection puts on a draft, which serialize into the sent message as a
// `<review_comment>` block with the payload fenced inside. This seam is that mechanism and
// nothing new: a plugin's attachment becomes one review comment, and every rule the app already
// has about them applies unchanged.
//
// WHAT DOES NOT CROSS (rule 10):
//   · `ComposerThreadTarget` — the app's own thread reference. A plugin gets an OPAQUE TOKEN and
//     hands it back; `parseTarget` is the only place that knows what it spells.
//   · `ReviewCommentContext` — the app's persisted shape. A plugin writes seven display fields
//     and `toReviewComment` maps them.
//
// IDS ARE NAMESPACED. A plugin's `id` becomes `plugin:<pluginId>:<id>` on the draft, so two
// plugins cannot collide with each other or with the file navigator's own comments, and
// `attached()` can answer "yours" without the plugin filtering.
import type { ComposerAttachment, ComposerContext, Signal } from "@smart-tools/plugin-sdk/host";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import { MAX_LABEL_LENGTH, isDisplayString } from "./caps";

/** The token's two spellings. A draft id has no colon in it; a thread ref is a pair. */
const DRAFT_PREFIX = "draft:";
const THREAD_PREFIX = "thread:";

/**
 * The app's target → the plugin's token.
 *
 * Exported for the signal bridge, which is the only other place that mints one.
 */
export const composerTargetToken = (target: ComposerThreadTarget | null): string | null => {
  if (target === null) return null;
  return typeof target === "string"
    ? `${DRAFT_PREFIX}${target}`
    : `${THREAD_PREFIX}${target.environmentId}:${target.threadId}`;
};

/**
 * The plugin's token → the app's target, or `null` when it is not one we minted.
 *
 * A token is a STRING a plugin held across a navigation, so it is untrusted input by the time it
 * comes back: anything that is not one of the two spellings answers `null` and every caller
 * treats that as "no such composer", never as a throw.
 */
const parseTarget = (token: unknown): ComposerThreadTarget | null => {
  if (typeof token !== "string") return null;
  if (token.startsWith(DRAFT_PREFIX)) {
    const draftId = token.slice(DRAFT_PREFIX.length);
    return draftId === "" ? null : DraftId.make(draftId);
  }
  if (!token.startsWith(THREAD_PREFIX)) return null;
  const rest = token.slice(THREAD_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split === rest.length - 1) return null;
  return {
    environmentId: EnvironmentId.make(rest.slice(0, split)),
    threadId: ThreadId.make(rest.slice(split + 1)),
  };
};

/** `plugin:<pluginId>:<id>` — what the draft stores, so two plugins cannot collide. */
const commentId = (pluginId: string, id: string): string => `plugin:${pluginId}:${id}`;

/** The prefix `attached()` strips to answer in the plugin's own ids. */
const commentPrefix = (pluginId: string): string => `plugin:${pluginId}:`;

/**
 * Is this an attachment the host will draw?
 *
 * Every display field goes through the SAME `isDisplayString` the other seams use, so a control
 * character or an over-length label is refused here rather than drawn. `body` is the payload the
 * model reads, not a display string: it is only required to be a string, and it is clamped by
 * nothing — a scanned node's DSL is legitimately long.
 */
const validAttachment = (item: unknown): item is ComposerAttachment => {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  for (const field of ["id", "group", "title", "name", "label", "text"] as const) {
    if (!isDisplayString(candidate[field], MAX_LABEL_LENGTH)) return false;
  }
  if (typeof candidate["body"] !== "string") return false;
  const language = candidate["language"];
  if (language !== undefined && !isDisplayString(language, MAX_LABEL_LENGTH)) return false;
  return true;
};

/** The plugin's seven fields → the app's persisted review comment. */
const toReviewComment = (pluginId: string, item: ComposerAttachment): ReviewCommentContext => ({
  id: commentId(pluginId, item.id),
  sectionId: `plugin:${pluginId}:${item.group}`,
  sectionTitle: item.title,
  filePath: item.name,
  // The app's own file-navigator comments carry a real character range; a plugin's card is not a
  // slice of a file, so the range is empty and `rangeLabel` is what the chip shows instead.
  startIndex: 0,
  endIndex: 0,
  rangeLabel: item.label,
  text: item.text,
  diff: item.body.slice(0, MAX_ATTACHMENT_BODY_LENGTH),
  ...(item.language === undefined ? {} : { fenceLanguage: item.language }),
});

/**
 * The cap on a payload, and it is generous on purpose.
 *
 * It is not a display string — it is what the model reads — but it DOES reach the wire and the
 * user's persisted draft, so an accidental unbounded value must not be able to wedge either. A
 * design-tool node's serialized form measures single-digit KB; 256 KB is two orders above.
 */
export const MAX_ATTACHMENT_BODY_LENGTH = 256 * 1024;

/**
 * Build the seam for one plugin.
 *
 * `report` is the ctx's own per-`(pluginId, code)` channel: a bad call is DROPPED and reported
 * once, exactly like `toast` and `invalidate`, never thrown — a throw inside a click handler
 * would cost the plugin a surface it got right.
 */
export const makePluginComposer = (input: {
  readonly pluginId: string;
  readonly report: (code: string, message: string) => void;
  readonly target: Signal<string | null>;
}): ComposerContext => ({
  target: input.target,

  attach: (token, item) => {
    if (!validAttachment(item)) {
      input.report(
        "composer:attach",
        "the attachment was dropped: a field is not a display string",
      );
      return;
    }
    const target = parseTarget(token);
    if (target === null) return;
    // `addReviewComment` UPSERTS by id, so attaching the same id twice replaces the card in
    // place — which is what lets a surface refresh an attachment whose payload changed.
    useComposerDraftStore
      .getState()
      .addReviewComment(target, toReviewComment(input.pluginId, item));
  },

  detach: (token, id) => {
    const target = parseTarget(token);
    if (target === null || typeof id !== "string" || id === "") return;
    useComposerDraftStore.getState().removeReviewComment(target, commentId(input.pluginId, id));
  },

  attached: (token) => {
    const target = parseTarget(token);
    if (target === null) return null;
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    // `null` means "there is no draft here at all" and is NOT `[]`. A tray reconciling against
    // the composer drops a row for `[]` and must keep it for `null`.
    if (draft === null) return null;
    const prefix = commentPrefix(input.pluginId);
    return draft.reviewComments
      .filter((comment) => comment.id.startsWith(prefix))
      .map((comment) => comment.id.slice(prefix.length));
  },

  // ZERO ARGUMENTS, and the wrapper is the whole point. zustand v5 calls a subscriber as
  // `listener(state, previousState)`, so handing the plugin's listener straight to
  // `useComposerDraftStore.subscribe` would pass it the app's entire `ComposerDraftStoreState` —
  // every draft of every thread, every review comment of every OTHER plugin and of the file
  // navigator, and the store's own `addReviewComment` / `removeReviewComment` mutators. That is
  // both shapes the header of this file says never cross (rule 10) and it hands a plugin the
  // means to break V2-48's second law, which `attach`/`detach`/`attached` enforce by id prefix.
  // The SDK promises the opposite twice — `ComposerContext.subscribe(listener: () => void)` and
  // `Signal`'s "the listener takes no arguments — read `get()`" — so the seam owes a callback
  // with nothing in it: a change signal, and the plugin re-reads through `attached`.
  subscribe: (listener) => useComposerDraftStore.subscribe(() => listener()),
});
