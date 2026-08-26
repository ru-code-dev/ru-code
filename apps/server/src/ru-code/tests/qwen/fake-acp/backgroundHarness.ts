// ru-code (agentic-flow wave, P2): co-located test infra for the background
// matrix (R10 — infra lives beside the tests that use it).
//
// Every background spec needs the same three things: a qwen adapter over the
// fake child, a live view of the runtime events it emits, and a mutable task
// registry the fake serves polls from. Repeating that in each file is how two
// specs end up asserting against subtly different wiring, so it is built once
// here.
//
// Deliberately ADAPTER-level, not pipeline-level: the wave's contract is what
// the adapter emits (`task.*`, `item.*`, `content.delta`, the ext-method calls
// it makes). Only the two specs that assert on PERSISTED chat rows need the
// orchestration harness, and they build it themselves.
import {
  ApprovalRequestId,
  QwenSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import type { EventNdjsonLogger } from "../../../../provider/Layers/EventNdjsonLogger.ts";
import type { ProviderAdapterError } from "../../../../provider/Errors.ts";
import type { ProviderAdapterShape } from "../../../../provider/Services/ProviderAdapter.ts";
import type { QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";
import { pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

export type TaskStarted = Extract<ProviderRuntimeEvent, { type: "task.started" }>;
export type TaskProgress = Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
export type TaskUpdated = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
export type TaskCompleted = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
export type ContentDelta = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
export type ItemEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

export interface BackgroundEventView {
  readonly events: ProviderRuntimeEvent[];
  readonly taskStarted: () => ReadonlyArray<TaskStarted>;
  readonly taskProgress: () => ReadonlyArray<TaskProgress>;
  readonly taskUpdated: () => ReadonlyArray<TaskUpdated>;
  readonly taskCompleted: () => ReadonlyArray<TaskCompleted>;
  readonly contentDeltas: () => ReadonlyArray<ContentDelta>;
  readonly itemEvents: () => ReadonlyArray<ItemEvent>;
  /** Concatenated `content.delta` text — what the parent chat would render. */
  readonly chatText: () => string;
  readonly waitFor: (label: string, check: () => boolean) => Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

/**
 * Fork a typed view over an adapter's runtime-event stream.
 *
 * ru-code (agentic-flow wave, FIX ROUND 3): `autoRespond` plays the user at the
 * permission dialog. A permission-gated spawn PARKS qwen's script until the
 * client answers — that is what the gate is — so a script carrying one reaches
 * no further frame until the test answers it. `decision` defaults to `accept`;
 * `decline` is the user pressing Reject, which is a first-class outcome of this
 * wire and not an error case (FIX ROUND 3 ADDENDUM).
 */
export const collectBackgroundEvents = (
  adapter: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
    readonly respondToRequest?: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) => Effect.Effect<unknown, ProviderAdapterError>;
  },
  options: {
    readonly autoRespond?: {
      readonly threadId: ThreadId;
      readonly decision?: ProviderApprovalDecision;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const respond = options.autoRespond;
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          respond !== undefined &&
            event.type === "request.opened" &&
            adapter.respondToRequest !== undefined
            ? adapter
                .respondToRequest(
                  respond.threadId,
                  ApprovalRequestId.make(String((event as { requestId?: unknown }).requestId)),
                  respond.decision ?? "accept",
                )
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);
    const of = <T extends ProviderRuntimeEvent["type"]>(type: T) =>
      events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type,
      );
    const view: BackgroundEventView = {
      events,
      taskStarted: () => of("task.started"),
      taskProgress: () => of("task.progress"),
      taskUpdated: () => of("task.updated"),
      taskCompleted: () => of("task.completed"),
      contentDeltas: () => of("content.delta"),
      itemEvents: () =>
        events.filter(
          (event): event is ItemEvent =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        ),
      chatText: () =>
        of("content.delta")
          .map((event) => event.payload.delta)
          .join(""),
      waitFor: (label, check) => pollUntil(check, label),
      stop: Effect.asVoid(Fiber.interrupt(fiber)),
    };
    return view;
  });

/**
 * The adapter under test, typed as the PORT SHAPE rather than as its own
 * structural type. That is deliberate: the shape is where optional
 * capabilities live (`compactContext`, and this wave's `stopBackgroundTask`),
 * so a spec can ask "does this adapter implement the capability" instead of
 * failing to compile before the capability exists — which is exactly the state
 * a born-red spec has to be able to express.
 */
/**
 * ru-code (agentic-flow wave): a SHORT poll interval by default.
 *
 * Not cosmetic speed: several claims here are "the poll stopped" / "it was
 * attempted exactly once", and with the production 1s cadence a spec that waits
 * a few hundred milliseconds cannot tell a stopped poll from a slow one — which
 * is precisely how the first version of those two specs passed under their own
 * mutation. A 60ms tick makes a wait of half a second worth ~8 ticks.
 */
export const TEST_BACKGROUND_POLL_INTERVAL_MS = 60;

/**
 * ru-code (agentic-flow wave, FIX ROUND 1): an in-memory stand-in for the NATIVE ACP log, so a
 * spec can assert that a signal still reaches it. The real logger writes NDJSON
 * to disk (`EventNdjsonLogger`); the adapter only ever calls `write`.
 */
export const collectNativeLog = () => {
  const written: Array<{ readonly method: string; readonly payload: unknown }> = [];
  const logger = {
    filePath: "<memory>",
    write: (event: unknown) =>
      Effect.sync(() => {
        const record = (event as { event?: { method?: string; payload?: unknown } }).event;
        if (record?.method !== undefined) {
          written.push({ method: record.method, payload: record.payload });
        }
      }),
    close: () => Effect.void,
  } satisfies EventNdjsonLogger;
  return { logger, written };
};

export const makeBackgroundAdapter = (options?: {
  readonly pollIntervalMs?: number;
  readonly nativeEventLogger?: EventNdjsonLogger;
}) =>
  Effect.map(
    makeQwenAdapter(decodeQwenSettings({}), {
      backgroundPollIntervalMs: options?.pollIntervalMs ?? TEST_BACKGROUND_POLL_INTERVAL_MS,
      ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    }),
    (adapter) =>
      adapter as typeof adapter &
        Pick<ProviderAdapterShape<ProviderAdapterError>, "stopBackgroundTask">,
  );

/**
 * One RUNNING background entry as qwen's registry would hold it right after a
 * launch. `id` is the REAL agent id (`<subagentName>-<random8>`,
 * agent.ts:2839/:2842 with `this.callId` undefined on the ACP path — see
 * `qwenBackgroundAgentId`), because that is what qwen keys its own registry,
 * poll snapshot, notification `_meta` and cancel method by.
 */
export const runningTaskEntry = (input: {
  readonly id: string;
  readonly description: string;
  readonly subagentType: string;
  readonly toolUseId?: string;
  readonly startTime?: number;
}): QwenAgentTaskEntry => ({
  id: input.id,
  description: input.description,
  subagentType: input.subagentType,
  status: "running",
  startTime: input.startTime ?? 1_699_999_000_000,
  isBackgrounded: true,
  ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
});
