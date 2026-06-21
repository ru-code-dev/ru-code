/**
 * Ru-fork-specific: dispatch a checkpoint placeholder on `turn.completed`.
 *
 * Upstream t3code's reliable post-turn checkpoint path is triggered by the
 * `turn.diff.updated` runtime event, which only the Codex adapter emits.
 * Ru-fork only ships the Cli/ACP adapter, which emits `turn.completed`
 * but not `turn.diff.updated`, leaving the upstream design on the racy
 * direct-capture fallback in `CheckpointReactor.captureCheckpointFromTurnCompletion`.
 *
 * This helper mirrors Codex's flow by dispatching the same placeholder
 * `thread.turn.diff.complete` domain event from the `turn.completed`
 * ingestion path. `CheckpointReactor.captureCheckpointFromPlaceholder`
 * then becomes the single reliable post-turn capture trigger for Cli.
 *
 * Call from `ProviderRuntimeIngestion`'s `turn.completed` handler AFTER
 * `finalizeAssistantMessage` has projected the assistant messages, so the
 * passed `assistantMessageIds` set matches what's in the projection and
 * the dispatched `assistantMessageId` joins to a real chat message on the
 * web side (otherwise the changed-files block / revert button silently
 * miss in `ChatView.turnDiffSummaryByAssistantMessageId`).
 *
 * @module ru-fork/turnCompletedCheckpointDispatch
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CheckpointRef,
  CommandId,
  MessageId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import { isGitRepository } from "../git/Utils.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const dispatchTurnCompletedCheckpointPlaceholder = (params: {
  readonly event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly assistantMessageIds: ReadonlySet<MessageId>;
  readonly now: string;
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const checkpointContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(params.threadId)
      .pipe(Effect.map(Option.getOrUndefined));

    const workspaceCwd =
      checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
    if (!checkpointContext || !workspaceCwd || !isGitRepository(workspaceCwd)) {
      return;
    }

    // Skip if a checkpoint (placeholder or real) already exists for this turn.
    // Mirrors the guard in ProviderRuntimeIngestion's `turn.diff.updated` block:
    // a duplicate placeholder dispatch for the same turnId would produce an
    // unstable checkpointTurnCount.
    if (checkpointContext.checkpoints.some((c) => c.turnId === params.turnId)) {
      return;
    }

    // Pick the latest segment id for the turn — `assistantSegmentMessageId`
    // produces `assistant:${baseKey}` for segment 0 and
    // `assistant:${baseKey}:segment:${N}` for later ones, so the last entry
    // in insertion order is the most recent segment the user sees.
    const lastAssistantMessageId = Array.from(params.assistantMessageIds).at(-1);
    const assistantMessageId =
      lastAssistantMessageId ?? MessageId.make(`assistant:${params.turnId}`);

    const checkpointTurnCount =
      checkpointContext.checkpoints.reduce((max, c) => Math.max(max, c.checkpointTurnCount), 0) + 1;

    const commandUuid = yield* crypto.randomUUIDv4;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make(
        `provider:${params.event.eventId}:thread-turn-diff-complete-from-completion:${commandUuid}`,
      ),
      threadId: params.threadId,
      turnId: params.turnId,
      completedAt: params.now,
      checkpointRef: CheckpointRef.make(`provider-diff:${params.event.eventId}`),
      status: "missing",
      files: [],
      assistantMessageId,
      checkpointTurnCount,
      createdAt: params.now,
    });
  });
