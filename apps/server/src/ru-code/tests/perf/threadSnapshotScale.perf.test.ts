// ru-code: MEASURED scaling of the thread-snapshot serving pipeline vs thread size.
//
// Field defect (production-error.md §5): a client with one sufficiently large thread
// enters a permanent reconnect loop. The serving chain has FOUR O(size) stages, and two
// hard deadlines cut across them:
//
//   HTTP path  (6 s):  SQL read → row decode → decodeThread (schema) → localizeWireValue
//                      scan → JSON body → client-side schema decode
//                      (packages/client-runtime/src/state/threadSnapshotHttp.ts:22)
//   Socket path (5 s): same query → JSON encode via the localized egress serializer →
//                      ONE giant WS frame → client parse + schema decode; the RPC pinger
//                      fails the socket if no Pong lands within its 5 s window
//                      (effect RpcClient makePinger).
//
// This test seeds a realistic huge thread (activity rows carrying tool payloads) at
// growing total sizes into the in-memory projection store and MEASURES each stage, so
// the byte threshold where a given machine crosses the deadlines is a printed number,
// not a guess. The final assertions state the production requirement — the pipeline must
// fit the deadlines at the largest seeded size — so on hardware where it does not, this
// test is RED, which is the point: it catches "huge DB breaks the app" as a class.
//
// console.log is deliberate: the measurement table is this test's OUTPUT (the runner
// hides it on pass; RU_SNAPSHOT_PERF_REPORT captures it to a file), and so is raw
// JSON.parse — the client-side parse cost of the wire frame is one of the measured
// stages:
// @effect-diagnostics globalConsoleInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import { containsToken, Lc } from "@ru-code/localization";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
// ru-code: t3 grew the projection pipeline's requirements (A15).
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { localizedJsonSerialization } from "../../localization/wireEgress.ts";

// The two production deadlines the pipeline must fit inside (see header).
const HTTP_TIMEOUT_MS = 6_000;
const PONG_WINDOW_MS = 5_000;

// Per-row payload: a tool-output-shaped JSON string. 256 KiB per activity row is an
// ordinary large command output (test runs, greps, file dumps).
const PAYLOAD_BYTES_PER_ROW = 256 * 1024;

// Total payload sizes to sweep. 64 MiB ≈ a couple of weeks of heavy tool-driven work in
// one thread — the reporter's profile (15-day-old install, single power user).
const SWEEP_TOTAL_MIB = [2, 8, 32, 64];

const decodeSnapshot = Schema.decodeUnknownEffect(OrchestrationThreadDetailSnapshot);
const threadId = ThreadId.make("perf-thread");

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
  { timeout: 300_000 },
);

function makePayloadJson(row: number, bytes: number): string {
  // Realistic payload shape: one long output string inside a small JSON envelope.
  const envelope = `{"taskId":"task-${row}","status":"completed","output":""}`;
  const chunk = `[row ${row}] tool output line with paths src/module-${row}.ts and exit codes; `;
  const filler = chunk.repeat(Math.ceil((bytes - envelope.length) / chunk.length));
  return `{"taskId":"task-${row}","status":"completed","output":${JSON.stringify(filler)}}`;
}

const seedBaseRows = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      'perf-project', 'Perf', '/tmp/perf-project',
      '{"provider":"codex","model":"gpt-5-codex"}', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, latest_user_message_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${threadId}, 'perf-project', 'Perf thread',
      '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
      0, 0, 0,
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

const seedActivityRows = Effect.fnUntraced(function* (fromRow: number, toRowExclusive: number) {
  const sql = yield* SqlClient.SqlClient;
  for (let row = fromRow; row < toRowExclusive; row++) {
    const payload = makePayloadJson(row, PAYLOAD_BYTES_PER_ROW);
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      ) VALUES (
        ${`activity-${row}`}, ${threadId}, NULL, 'info', 'runtime.note',
        ${`Ran tool step ${row}`}, ${payload}, '2026-01-01T00:00:01.000Z'
      )
    `;
  }
});

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface StageTimings {
  readonly totalMiB: number;
  readonly encodedMiB: number;
  readonly queryMs: number;
  readonly tokenScanMs: number;
  readonly egressEncodeMs: number;
  readonly clientParseMs: number;
  readonly clientDecodeMs: number;
  readonly httpPathMs: number;
  readonly socketPathMs: number;
}

function formatRow(t: StageTimings): string {
  const ms = (v: number) => v.toFixed(0).padStart(7);
  return (
    `${String(t.totalMiB).padStart(5)} MiB payload | encoded ${t.encodedMiB.toFixed(1).padStart(6)} MiB | ` +
    `query ${ms(t.queryMs)} ms | tokenScan ${ms(t.tokenScanMs)} ms | egressEncode ${ms(t.egressEncodeMs)} ms | ` +
    `clientParse ${ms(t.clientParseMs)} ms | clientDecode ${ms(t.clientDecodeMs)} ms | ` +
    `HTTP-path ${ms(t.httpPathMs)} ms | socket-path ${ms(t.socketPathMs)} ms`
  );
}

projectionSnapshotLayer("thread snapshot serving pipeline vs thread size", (it) => {
  it.effect(
    "measures every O(size) stage across the sweep and asserts the production deadlines",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* seedBaseRows();

        const parser = localizedJsonSerialization.makeUnsafe();
        const timings: StageTimings[] = [];
        let seededRows = 0;

        for (const totalMiB of SWEEP_TOTAL_MIB) {
          const targetRows = Math.round((totalMiB * 1024 * 1024) / PAYLOAD_BYTES_PER_ROW);
          yield* seedActivityRows(seededRows, targetRows);
          seededRows = targetRows;

          // Stage 1 — the projection query: SQL read + row decode + decodeThread
          // (the schema decode of the WHOLE thread happens inside, on the server).
          const querySamples: number[] = [];
          let snapshot: OrchestrationThreadDetailSnapshot | null = null;
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const loaded = yield* snapshotQuery.getThreadDetailSnapshot(threadId);
            querySamples.push(performance.now() - t0);
            assert.isTrue(loaded._tag === "Some", "seeded thread must load");
            snapshot = loaded._tag === "Some" ? loaded.value : null;
          }
          const queryMs = median(querySamples);
          const value = snapshot!;

          // Stage 2 — HTTP egress token scan (`localizeWireValue` fast path): an
          // allocation-free deep walk over the whole decoded value.
          const t1 = performance.now();
          const hasToken = containsToken(value);
          const tokenScanMs = performance.now() - t1;
          assert.isFalse(hasToken, "seed carries no localization token");

          // Stage 3 — socket egress encode (localized serializer, token-free fast
          // path): JSON.stringify + one native includes() scan. This is the frame
          // the WS would carry when the client subscribes without afterSequence.
          const wsMessage = { _tag: "Exit", value: { kind: "snapshot", snapshot: value } };
          const t2 = performance.now();
          const encoded = parser.encode(wsMessage) as string;
          const egressEncodeMs = performance.now() - t2;
          const encodedMiB = encoded.length / (1024 * 1024);

          // Stage 4 — client side: parse the frame, then schema-decode the snapshot
          // (what the contracts HTTP client / RPC client must do before the thread
          // can render). Runs on the renderer's only thread, ahead of Pong handling.
          const t3 = performance.now();
          const parsed = JSON.parse(encoded) as {
            value: { snapshot: unknown };
          };
          const clientParseMs = performance.now() - t3;
          const t4 = performance.now();
          yield* decodeSnapshot(parsed.value.snapshot);
          const clientDecodeMs = performance.now() - t4;

          timings.push({
            totalMiB,
            encodedMiB,
            queryMs,
            tokenScanMs,
            egressEncodeMs,
            clientParseMs,
            clientDecodeMs,
            httpPathMs: queryMs + tokenScanMs + egressEncodeMs + clientParseMs + clientDecodeMs,
            socketPathMs: queryMs + egressEncodeMs + clientParseMs + clientDecodeMs,
          });
        }

        const per64 = timings[timings.length - 1]!;
        const report = [
          "thread snapshot serving pipeline — measured on this machine:",
          ...timings.map(formatRow),
          `extrapolation: HTTP 6 s deadline crossed near ~${Math.round(
            (HTTP_TIMEOUT_MS / per64.httpPathMs) * per64.totalMiB,
          )} MiB, pong 5 s window near ~${Math.round(
            (PONG_WINDOW_MS / per64.socketPathMs) * per64.totalMiB,
          )} MiB of thread payload (linear model).`,
        ].join("\n");
        console.log(`\n${report}\n`);
        // The runner hides console output of passing tests; the file keeps the
        // measurements reachable either way.
        const reportPath = process.env["RU_SNAPSHOT_PERF_REPORT"];
        if (reportPath !== undefined && reportPath.length > 0) {
          yield* Effect.promise(() => import("node:fs/promises")).pipe(
            Effect.flatMap((fs) => Effect.promise(() => fs.writeFile(reportPath, `${report}\n`))),
          );
        }

        // Prove the seeded bytes actually flowed through every stage — a frame
        // smaller than the seed would mean the measurement measured nothing.
        assert.isAbove(per64.encodedMiB, per64.totalMiB * 0.95);

        // Production requirement, stated as-is. A machine (or a future regression)
        // that cannot serve a 64 MiB thread inside the deadlines strands that user in
        // the §5 reconnect loop — the cache never warms, and every retry repeats the
        // identical work.
        const largest = timings[timings.length - 1]!;
        assert.isBelow(
          largest.httpPathMs,
          HTTP_TIMEOUT_MS,
          `HTTP snapshot pipeline for a ${largest.totalMiB} MiB thread must fit the ${HTTP_TIMEOUT_MS} ms client timeout`,
        );
        assert.isBelow(
          largest.socketPathMs,
          PONG_WINDOW_MS,
          `socket snapshot pipeline for a ${largest.totalMiB} MiB thread must fit the ${PONG_WINDOW_MS} ms pong window`,
        );
      }),
    { timeout: 300_000 },
  );

  it.effect(
    "measures per-ROW overhead: many small activity+message rows (the degenerate real-thread shape)",
    () =>
      Effect.gen(function* () {
        // The sweep above uses few rows with huge payloads — bytes dominate, and
        // per-byte cost is tiny. The opposite shape is the dangerous one: a thread
        // that accumulated tens of thousands of SMALL rows. Every row pays SQL row
        // materialization + row decode + schema decode + object mapping, so the
        // per-row constant — not bytes — sets the serving time.
        const sql = yield* SqlClient.SqlClient;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const rowThreadId = ThreadId.make("perf-thread-rows");
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            branch, worktree_path, latest_turn_id, latest_user_message_at,
            pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
            created_at, updated_at, deleted_at
          ) VALUES (
            ${rowThreadId}, 'perf-project', 'Perf thread (rows)',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
            0, 0, 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
          )
        `;

        const parser = localizedJsonSerialization.makeUnsafe();
        const seedRowsBatch = (fromRow: number, toRowExclusive: number) =>
          Effect.gen(function* () {
            const batchSize = 500;
            for (let start = fromRow; start < toRowExclusive; start += batchSize) {
              const end = Math.min(start + batchSize, toRowExclusive);
              const activityValues: string[] = [];
              const messageValues: string[] = [];
              for (let row = start; row < end; row++) {
                activityValues.push(
                  `('act-${row}', '${rowThreadId}', NULL, 'info', 'runtime.note', ` +
                    `'Ran tool step ${row} touching src/module-${row}.ts', ` +
                    `'{"taskId":"task-${row}","status":"completed","exitCode":0}', ` +
                    `'2026-01-01T00:00:01.000Z')`,
                );
                messageValues.push(
                  `('msg-${row}', '${rowThreadId}', NULL, '${row % 2 === 0 ? "user" : "assistant"}', ` +
                    `'message ${row}: a short chat line of ordinary length for this thread', 0, ` +
                    `'2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')`,
                );
              }
              yield* sql.unsafe(
                `INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at) VALUES ${activityValues.join(",")}`,
              );
              yield* sql.unsafe(
                `INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES ${messageValues.join(",")}`,
              );
            }
          });

        const rowSweep = [2_000, 10_000, 40_000];
        const lines: string[] = [];
        let seeded = 0;
        let worstServeMs = 0;
        for (const rowCount of rowSweep) {
          yield* seedRowsBatch(seeded, rowCount);
          seeded = rowCount;
          const samples: number[] = [];
          let encodedLength = 0;
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const loaded = yield* snapshotQuery.getThreadDetailSnapshot(rowThreadId);
            assert.isTrue(loaded._tag === "Some");
            const encoded = parser.encode({
              _tag: "Exit",
              value: { kind: "snapshot", snapshot: loaded._tag === "Some" ? loaded.value : null },
            }) as string;
            samples.push(performance.now() - t0);
            encodedLength = encoded.length;
          }
          const serveMs = median(samples);
          worstServeMs = Math.max(worstServeMs, serveMs);
          lines.push(
            `${String(rowCount).padStart(6)} rows ×2 tables | encoded ${(encodedLength / 1024 / 1024).toFixed(1).padStart(6)} MiB | query+encode ${serveMs.toFixed(0).padStart(7)} ms | per-row ${((serveMs / rowCount) * 1000).toFixed(1)} µs`,
          );
        }
        const report = `per-row overhead (small rows):\n${lines.join("\n")}`;
        console.log(`\n${report}\n`);
        const reportPath = process.env["RU_SNAPSHOT_PERF_REPORT"];
        if (reportPath !== undefined && reportPath.length > 0) {
          yield* Effect.promise(() => import("node:fs/promises")).pipe(
            Effect.flatMap((fs) =>
              Effect.promise(() => fs.appendFile(reportPath, `\n${report}\n`)),
            ),
          );
        }

        // Same production requirement as the byte sweep: a 40k-row thread must
        // still serve inside the pong window, or its owner lands in the §5 loop.
        assert.isBelow(worstServeMs, PONG_WINDOW_MS);
      }),
    { timeout: 300_000 },
  );

  it.effect(
    "a single localization token in a huge snapshot triggers the full parse→resolve→re-stringify triple pass",
    () =>
      Effect.sync(() => {
        // Independent of the sweep above: the egress serializer's slow path scales
        // with FRAME size, not token count. One token inside a ~32 MiB frame makes
        // the serializer parse and re-stringify all of it — synchronously, on the
        // server's only event loop, inside the pong window.
        const parser = localizedJsonSerialization.makeUnsafe();
        const bigOutput = "tool output line; ".repeat((32 * 1024 * 1024) / 18);
        const message = {
          _tag: "Exit",
          value: {
            kind: "snapshot",
            snapshot: {
              snapshotSequence: 1,
              thread: {
                id: "t-1",
                activities: [
                  {
                    id: "a-0",
                    summary: Lc(
                      "Compaction succeeded {0}.",
                      "Сжатие выполнено успешно {0}.",
                      "(1)",
                    ),
                  },
                  { id: "a-1", payload: bigOutput },
                ],
              },
            },
          },
        };

        const fastPathMessage = {
          ...message,
          value: {
            ...message.value,
            snapshot: {
              ...message.value.snapshot,
              thread: {
                ...message.value.snapshot.thread,
                activities: [
                  { id: "a-0", summary: "Compaction succeeded (1)." },
                  { id: "a-1", payload: bigOutput },
                ],
              },
            },
          },
        };

        const t0 = performance.now();
        const fastEncoded = parser.encode(fastPathMessage) as string;
        const fastMs = performance.now() - t0;

        const t1 = performance.now();
        const slowEncoded = parser.encode(message) as string;
        const slowMs = performance.now() - t1;

        console.log(
          `egress encode of a ${(fastEncoded.length / 1024 / 1024).toFixed(1)} MiB frame: ` +
            `token-free ${fastMs.toFixed(0)} ms, with ONE token ${slowMs.toFixed(0)} ms ` +
            `(triple-pass multiplier ×${(slowMs / Math.max(fastMs, 0.01)).toFixed(1)})`,
        );
        assert.notInclude(slowEncoded, "\\u001e");

        // The requirement: even the tokened worst case must fit the pong window,
        // because this encode runs synchronously between two heartbeats.
        assert.isBelow(
          slowMs,
          PONG_WINDOW_MS,
          "tokened egress encode of a 32 MiB frame must fit the 5 s pong window",
        );
      }),
    { timeout: 120_000 },
  );
});
