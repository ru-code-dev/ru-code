// ru-code: MEASURED scaling of every per-reconnect / per-boot hot path vs data growth.
//
// production-error.md §5 (round 2) names the reconnect-loop suspects; this file turns
// each into a measured curve on the reference machine, so "how heavy is it" is a number
// per unit of grown data, not an argument:
//
//   1. event-tail catch-up (subscribeShell/Thread with afterSequence — ws.ts:1215/1330):
//      the synchronous per-page burst of `readFromSequence` vs payload size, the full
//      drain vs event count, and the per-event `getThreadShellById` enrichment;
//   2. qwenBootSweep (startup/qwenBootSweep.ts): the per-binding boot read (now the S5
//      lean reader) — cost vs thread count × thread size;
//   3. getShellSnapshot vs thread count (every cold shell load);
//   4. the missing-thread hammer's server cost per attempt (threads deleted server-side
//      are re-requested at 4/s per client — threadsDeletedRetry.test.ts).
//
// The console table is this test's OUTPUT (hidden on pass by the runner;
// RU_RECONNECT_PERF_REPORT captures it to a file), and raw JSON.stringify builds the
// seeded wire payloads:
// @effect-diagnostics globalConsoleInEffect:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
// ru-code: t3 grew the projection pipeline's requirements (A15).
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import {
  makeSweepThreadStateReader,
  runQwenBootSweepWith,
  type QwenBootSweepDeps,
} from "../../startup/qwenBootSweep.ts";
import { parseAndNormalize, TRANSCRIPT_WIRE_POLICY } from "@smart-tools/qwen-cli-transcript-core";

const PONG_WINDOW_MS = 5_000;

const perfLayer = it.layer(
  Layer.mergeAll(OrchestrationEventStoreLive, OrchestrationProjectionSnapshotQueryLive).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
  { timeout: 600_000 },
);

const reportLines: string[] = [];
function report(line: string): void {
  reportLines.push(line);
  console.log(line);
}

async function flushReport(): Promise<void> {
  const reportPath = process.env["RU_RECONNECT_PERF_REPORT"];
  if (reportPath !== undefined && reportPath.length > 0) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(reportPath, `${reportLines.join("\n")}\n`);
  }
}

const seedProjectAndState = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      'perf-project', 'Perf', '/tmp/perf-project-does-not-exist',
      '{"provider":"codex","model":"gpt-5-codex"}', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  let sequence = 1;
  for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
    yield* sql`
      INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${projector}, ${sequence}, '2026-01-01T00:00:00.000Z')
    `;
    sequence += 1;
  }
});

const seedThreadRow = Effect.fnUntraced(function* (threadId: string, title: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, latest_user_message_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${threadId}, 'perf-project', ${title},
      '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
      0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

/** Insert `count` valid thread.message-sent events with `payloadBytes` text each. */
const seedEvents = Effect.fnUntraced(function* (
  threadId: string,
  startVersion: number,
  count: number,
  payloadBytes: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const chunk = "tool output captured into the chat transcript; ";
  const filler = chunk.repeat(Math.ceil(payloadBytes / chunk.length));
  for (let row = 0; row < count; row++) {
    const version = startVersion + row;
    const payload = JSON.stringify({
      threadId,
      messageId: `perf-msg-${threadId}-${version}`,
      role: row % 2 === 0 ? "user" : "assistant",
      text: filler,
      turnId: null,
      streaming: false,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (
        ${`perf-evt-${threadId}-${version}`}, 'thread', ${threadId}, ${version},
        'thread.message-sent', '2026-01-02T00:00:00.000Z',
        NULL, NULL, NULL, 'provider', ${payload}, '{}'
      )
    `;
  }
});

const currentMaxSequence = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT COALESCE(MAX(sequence), 0) AS maxSeq FROM orchestration_events`;
  return Number((rows[0] as { maxSeq: number | bigint }).maxSeq);
});

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

perfLayer("reconnect hot paths vs data growth", (it) => {
  it.effect(
    "1. event-tail catch-up: page burst vs payload size, full drain vs count, per-event shell enrichment",
    () =>
      Effect.gen(function* () {
        yield* seedProjectAndState();
        yield* seedThreadRow("perf-tail-thread", "Tail thread");
        const eventStore = yield* OrchestrationEventStore;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        report("\n[1] event-tail catch-up (ws.ts:1215/1330 shape):");

        // (a) The synchronous PAGE BURST (500 rows = one READ_PAGE_SIZE read+decode)
        // as payload grows — this is the block that starves pongs.
        let version = 1;
        for (const payloadBytes of [8 * 1024, 64 * 1024, 256 * 1024]) {
          const cursor = yield* currentMaxSequence();
          yield* seedEvents("perf-tail-thread", version, 500, payloadBytes);
          version += 500;
          const samples: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const drained = yield* eventStore.readFromSequence(cursor, 500).pipe(Stream.runCollect);
            samples.push(performance.now() - t0);
            assert.equal(drained.length, 500);
          }
          const burstMs = median(samples);
          report(
            `  one 500-row page @ ${String(payloadBytes / 1024).padStart(3)} KiB/event ` +
              `(${((500 * payloadBytes) / 1024 / 1024).toFixed(0).padStart(3)} MiB): ` +
              `${burstMs.toFixed(0).padStart(6)} ms  (${((burstMs / 500) * 1000).toFixed(0)} µs/event)`,
          );
          assert.isBelow(
            burstMs,
            PONG_WINDOW_MS,
            `a single catch-up page burst at ${payloadBytes / 1024} KiB/event must fit the pong window`,
          );
        }

        // (b) Full-tail drain: 2000 more events at 64 KiB → total catch-up serving time
        // for a client whose cursor is the whole tail behind.
        const drainCursor = yield* currentMaxSequence();
        yield* seedEvents("perf-tail-thread", version, 2_000, 64 * 1024);
        version += 2_000;
        const t1 = performance.now();
        const all = yield* eventStore
          .readFromSequence(drainCursor, Number.MAX_SAFE_INTEGER)
          .pipe(Stream.runCollect);
        const drainMs = performance.now() - t1;
        assert.equal(all.length, 2_000);
        report(
          `  full drain of 2000 events @ 64 KiB (125 MiB): ${drainMs.toFixed(0)} ms ` +
            `(${((drainMs / 2000) * 1000).toFixed(0)} µs/event)`,
        );

        // (c) The shell path adds getThreadShellById per thread event (ws.ts:779-793).
        const enrichSamples: number[] = [];
        for (let i = 0; i < 3; i++) {
          const t2 = performance.now();
          for (let call = 0; call < 500; call++) {
            const shell = yield* snapshotQuery.getThreadShellById(
              ThreadId.make("perf-tail-thread"),
            );
            assert.isTrue(shell._tag === "Some");
          }
          enrichSamples.push(performance.now() - t2);
        }
        const enrichMs = median(enrichSamples);
        report(
          `  shell enrichment (getThreadShellById): ${((enrichMs / 500) * 1000).toFixed(0)} µs/event ` +
            `→ a 10k-event shell catch-up adds ~${((enrichMs / 500) * 10_000).toFixed(0)} ms of queries`,
        );
      }),
    { timeout: 600_000 },
  );

  it.effect(
    "2. qwenBootSweep: per-binding boot read cost (S5 lean reader)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const dispatches = yield* Ref.make(0);
        const uuidCounter = yield* Ref.make(0);

        // 40 qwen threads × (40 messages + 40 activities) × 24 KiB ≈ 1.9 MiB/thread.
        // All rows are FINALIZED (no streaming messages, no open tool activities), so
        // the sweep's dispatch count must be 0 — the measured cost is the pure
        // unconditional READ the sweep performs per binding per boot.
        const chunk = "assistant output line for the boot sweep measurement; ";
        const text = chunk.repeat(Math.ceil((24 * 1024) / chunk.length));
        const threadCounts = [20, 40];
        const threadIds: string[] = [];
        let measured: Array<{ threads: number; ms: number }> = [];
        for (const target of threadCounts) {
          while (threadIds.length < target) {
            const threadId = `perf-sweep-thread-${threadIds.length}`;
            threadIds.push(threadId);
            yield* seedThreadRow(threadId, `Sweep ${threadId}`);
            for (let row = 0; row < 40; row++) {
              yield* sql`
                INSERT INTO projection_thread_messages (
                  message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
                ) VALUES (
                  ${`${threadId}-msg-${row}`}, ${threadId}, NULL,
                  ${row % 2 === 0 ? "user" : "assistant"}, ${text}, 0,
                  '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
                )
              `;
              yield* sql`
                INSERT INTO projection_thread_activities (
                  activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
                ) VALUES (
                  ${`${threadId}-act-${row}`}, ${threadId}, NULL, 'info', 'runtime.note',
                  ${`Ran step ${row}`}, ${JSON.stringify({ output: text })},
                  '2026-01-01T00:00:02.000Z'
                )
              `;
            }
          }

          const deps: QwenBootSweepDeps = {
            listBindings: () =>
              Effect.succeed(
                threadIds.map(
                  (threadId) =>
                    ({
                      threadId: ThreadId.make(threadId),
                      provider: "qwen",
                      lastSeenAt: "2026-01-01T00:00:00.000Z",
                    }) as never,
                ),
              ),
            // S5 landed: the sweep now runs the lean reader (shell + two
            // column-lean SQL reads) instead of the full detail read.
            readSweepThreadState: makeSweepThreadStateReader(sql, snapshotQuery.getThreadShellById),
            dispatch: (() =>
              Ref.update(dispatches, (count) => count + 1).pipe(
                Effect.as({} as never),
              )) as unknown as QwenBootSweepDeps["dispatch"],
            randomUuid: Ref.updateAndGet(uuidCounter, (count) => count + 1).pipe(
              Effect.map((count) => `perf-sweep-uuid-${count}`),
            ),
          };
          const samples: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            yield* runQwenBootSweepWith(deps);
            samples.push(performance.now() - t0);
          }
          measured.push({ threads: target, ms: median(samples) });
        }

        assert.equal(yield* Ref.get(dispatches), 0, "finalized threads must dispatch nothing");
        report("\n[2] qwenBootSweep (S5 lean reader per binding, per boot):");
        for (const point of measured) {
          report(
            `  ${String(point.threads).padStart(3)} qwen threads (~1.9 MiB each): ` +
              `${point.ms.toFixed(0).padStart(6)} ms/boot  (${(point.ms / point.threads).toFixed(1)} ms/thread)`,
          );
        }
      }),
    { timeout: 600_000 },
  );

  it.effect(
    "3. getShellSnapshot vs thread count (every cold shell load / reconnect without cursor)",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        let seeded = 0;
        report("\n[3] getShellSnapshot vs thread count:");
        for (const target of [500, 2_000]) {
          while (seeded < target) {
            yield* seedThreadRow(`perf-shell-thread-${seeded}`, `Shell thread ${seeded}`);
            seeded += 1;
          }
          const samples: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            yield* snapshotQuery.getShellSnapshot();
            samples.push(performance.now() - t0);
          }
          report(
            `  ${String(target).padStart(5)} threads: ${median(samples).toFixed(0).padStart(6)} ms`,
          );
        }
      }),
    { timeout: 600_000 },
  );

  it.effect(
    "5. transcript first frame: whole-JSONL parse per subscribe, per reconnect (extended chat)",
    () =>
      Effect.sync(() => {
        // transcriptService.ts:106-112 tails the session JSONL with a cursor at 0 —
        // the FIRST frame of every subscribe parses the entire file via
        // parseAndNormalize (parse.ts:486, fully synchronous). A reconnect makes a
        // new subscribe, so the whole parse re-runs each cycle. Record shape is an
        // approximation (generic JSON lines with a text body); JSON.parse dominates.
        const line = JSON.stringify({
          type: "assistant",
          uuid: "u",
          message: { content: [{ type: "text", text: "assistant output ".repeat(120) }] },
        });
        report("\n[5] transcript first-frame parse (per subscribe, per reconnect):");
        for (const totalMiB of [5, 50, 150]) {
          const lineCount = Math.ceil((totalMiB * 1024 * 1024) / (line.length + 1));
          const text = Array.from({ length: lineCount }, (_ignored, index) =>
            line.replace('"uuid":"u"', `"uuid":"u-${index}"`),
          ).join("\n");
          const samples: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const records = parseAndNormalize(text, TRANSCRIPT_WIRE_POLICY);
            samples.push(performance.now() - t0);
            assert.equal(records.length, lineCount);
          }
          const parseMs = median(samples);
          report(
            `  ${String(totalMiB).padStart(4)} MiB JSONL (${lineCount} lines): ` +
              `${parseMs.toFixed(0).padStart(6)} ms sync parse`,
          );
          assert.isBelow(
            parseMs,
            PONG_WINDOW_MS,
            `a ${totalMiB} MiB transcript first-frame parse must fit the pong window`,
          );
        }
      }),
    { timeout: 600_000 },
  );

  it.effect(
    "4. missing-thread snapshot cost — the server side of the 250 ms retry hammer",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const t0 = performance.now();
        for (let call = 0; call < 500; call++) {
          const missing = yield* snapshotQuery.getThreadDetailSnapshot(
            ThreadId.make("perf-missing-thread"),
          );
          assert.isTrue(missing._tag === "None");
        }
        const perCallMs = (performance.now() - t0) / 500;
        report(
          `\n[4] missing-thread snapshot: ${(perCallMs * 1000).toFixed(0)} µs/attempt ` +
            `(the client retries at 4/s per deleted thread, forever — cheap per hit, unbounded in time)`,
        );
        yield* Effect.promise(() => flushReport());
      }),
    { timeout: 600_000 },
  );
});
