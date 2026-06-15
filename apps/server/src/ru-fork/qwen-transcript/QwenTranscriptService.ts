// ru-fork: advanced chat mode — service that streams a thread's normalized qwen
// transcript (snapshot + live appends). Read-only; the control plane (approvals,
// turns) stays on the ACP path. See ru-fork-instrumental/advanced-chat/PLAN.md.
import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

import type { ThreadId, TranscriptStreamItem, TranscriptSubscribeError } from "@t3tools/contracts";

export interface QwenTranscriptServiceShape {
  /**
   * Stream the transcript for `threadId`: first item is a `snapshot` of all
   * records currently on disk; subsequent items are `append` batches as the CLI
   * writes. Fails only when the thread itself cannot be resolved.
   */
  readonly subscribe: (
    threadId: ThreadId,
  ) => Stream.Stream<TranscriptStreamItem, TranscriptSubscribeError>;
}

export class QwenTranscriptService extends Context.Service<
  QwenTranscriptService,
  QwenTranscriptServiceShape
>()("t3/ru-fork/QwenTranscriptService") {}
