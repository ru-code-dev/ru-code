// @effect-diagnostics preferSchemaOverJson:off — the "CLI recorder" writes qwen's foreign JSONL verbatim.
// ru-code: the COMPOSITE chain proof (test-composites rule) — no segment mocked
// except thread→cwd projection (orthogonal table plumbing):
//
//   fake-ACP handshake (REAL QwenAdapter over the in-memory fake agent)
//     → the adapter mints the resume cursor {schemaVersion:1, sessionId}
//     → persisted through the REAL ProviderSessionDirectory.upsert (the exact
//       production call shape) into REAL in-memory sqlite
//     → a "CLI recorder" writes the transcript JSONL at the REAL resolved path
//       (qwen writes this file OUT-OF-BAND of ACP — that is the true topology)
//     → the packaged transcript service (via the QwenTranscriptHostLive seam) with
//       the REAL directory resolves binding → cursor → file, tails it, and streams
//       snapshot + append during a live fake turn.
//
// If any hop drifts (cursor shape, directory decode, path formula, tailing),
// this test — not production — finds out.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  QwenSettings,
  ThreadId,
  type TranscriptStreamItem,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../../config.ts";
import { SqlitePersistenceMemory } from "../../../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../../../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { QwenTranscriptService } from "@smart-tools/qwen-cli-extended-chat/server";
import { resolveTranscriptFilePath } from "@smart-tools/qwen-cli-transcript-core";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { QwenTranscriptHostLive } from "../../../qwen/transcript/transcriptHost.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "../fake-acp/fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "../fake-acp/fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("transcript-chain-thread");

/** Raw qwen ChatRecord lines — the exact on-disk shape chatRecordingService writes. */
const rawUserLine = (cwd: string, uuid: string, text: string) =>
  JSON.stringify({
    uuid,
    parentUuid: null,
    sessionId: FAKE_SESSION_ID,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "user",
    cwd,
    version: "0.13.1",
    message: { role: "user", parts: [{ text }] },
  });

const rawAssistantLine = (cwd: string, uuid: string) =>
  JSON.stringify({
    uuid,
    parentUuid: "chain-u1",
    sessionId: FAKE_SESSION_ID,
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "assistant",
    cwd,
    version: "0.13.1",
    model: "qwen3-coder-plus",
    message: { role: "model", parts: [{ text: "streamed reply" }] },
  });

const projectionLayerWith = (workspaceRoot: string, worktreePath: string | null) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadCheckpointContext: () =>
      Effect.succeed(
        Option.some({
          threadId: THREAD_ID,
          projectId: ProjectId.make("p-chain"),
          workspaceRoot,
          worktreePath,
          checkpoints: [],
        }),
      ),
  } as unknown as ProjectionSnapshotQueryShape);

const projectionLayerFor = (cwd: string) => projectionLayerWith(cwd, null);

// ru-code: the draft branch — an unknown thread resolves to Option.none, which
// the host seam must translate into `null` (empty snapshot), never an error.
const projectionLayerNone = Layer.succeed(ProjectionSnapshotQuery, {
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
} as unknown as ProjectionSnapshotQueryShape);

const SCRIPT: FakeAcpScript = {
  onPrompt: (steps) => steps.emitText("streamed reply").respondOk(),
};

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-transcript-chain-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.live("the full session→binding→file→stream chain over the fake ACP agent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "transcript-chain-cwd-" });

    // One REAL directory instance (in-memory sqlite) shared by the upsert below
    // and the transcript reader — exactly the production topology.
    const realDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const chainLayer = Layer.mergeAll(
      fakeAcpSpawnerLayer(SCRIPT),
      QwenTranscriptHostLive.pipe(Layer.provide(projectionLayerFor(cwd))),
    ).pipe(Layer.provideMerge(realDirectoryLayer));

    yield* Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const platform = yield* HostProcessPlatform;

      // 1. REAL adapter over the fake ACP agent — the handshake mints the
      //    session and the SAME resume cursor shape production persists.
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      yield* adapter.startSession({ threadId: THREAD_ID, cwd, runtimeMode: "approval-required" });
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === THREAD_ID,
      );
      assert.isDefined(session, "the fake handshake registered a session");
      assert.deepStrictEqual(session!.resumeCursor, {
        schemaVersion: 1,
        sessionId: FAKE_SESSION_ID,
      });

      // 2. Persist the binding through the REAL directory (production call shape).
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("qwen"),
        providerInstanceId: ProviderInstanceId.make("qwen"),
        runtimeMode: "approval-required",
        resumeCursor: session!.resumeCursor,
      });

      // 3. The "CLI recorder" writes the transcript at the REAL resolved path —
      //    qwen writes this file out-of-band of ACP, exactly like this.
      const filePath = resolveTranscriptFilePath({
        cliConfigDir: config.cliConfigDir,
        cwd,
        platform,
        sessionId: FAKE_SESSION_ID,
      });
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, `${rawUserLine(cwd, "chain-u1", "hello")}\n`);

      // 4. The transcript service resolves binding → cursor → file THROUGH the
      //    real directory over the real sqlite row.
      const transcript = yield* Effect.service(QwenTranscriptService);

      // 5. Mid-"turn": run a real fake-ACP turn and let the recorder append —
      //    the tail must deliver it as an append with the SAME session id.
      //    STATE-BASED sequencing (no wall clock): the fork waits until the
      //    stream's first snapshot was actually observed before it runs the
      //    turn and appends — the poll cadence can be arbitrarily slow.
      const snapshotSeen = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Deferred.await(snapshotSeen);
          yield* adapter
            .sendTurn({ threadId: THREAD_ID, input: "hello" })
            .pipe(Effect.timeout("10 seconds"));
          yield* fs.writeFileString(
            filePath,
            `${rawUserLine(cwd, "chain-u1", "hello")}\n${rawAssistantLine(cwd, "chain-a1")}\n`,
          );
        }),
      );

      const items = (yield* Stream.runCollect(
        Stream.take(
          transcript
            .subscribe(THREAD_ID)
            .pipe(
              Stream.tap((item) =>
                item.kind === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
              ),
            ),
          2,
        ),
      ).pipe(Effect.timeout("15 seconds"))) as TranscriptStreamItem[];

      assert.deepStrictEqual(
        items.map((item) => item.kind),
        ["snapshot", "append"],
      );
      assert.strictEqual(items[0]!.sessionId, FAKE_SESSION_ID);
      assert.deepStrictEqual(
        items[0]!.records.map((record) => record.uuid),
        ["chain-u1"],
      );
      assert.deepStrictEqual(
        items[1]!.records.map((record) => record.uuid),
        ["chain-a1"],
      );
      const appended = items[1]!.records[0];
      assert.strictEqual(appended?.type, "assistant");
      if (appended?.type === "assistant") {
        assert.strictEqual(appended.model, "qwen3-coder-plus");
      }
    }).pipe(Effect.provide(chainLayer));
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

// ru-code: the resolveThread cwd preference — when a worktree is provisioned,
// `worktreePath ?? workspaceRoot` must pick the WORKTREE. The recorder writes the
// transcript under the worktree path only; a workspaceRoot fallback would find
// nothing and stream an empty snapshot instead of the record.
it.live("resolveThread prefers worktreePath over workspaceRoot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "chain-root-" });
    const worktree = yield* fs.makeTempDirectoryScoped({ prefix: "chain-worktree-" });

    const realDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const hostLayer = QwenTranscriptHostLive.pipe(
      Layer.provide(projectionLayerWith(workspaceRoot, worktree)),
      Layer.provideMerge(realDirectoryLayer),
    );

    yield* Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const platform = yield* HostProcessPlatform;

      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("qwen"),
        providerInstanceId: ProviderInstanceId.make("qwen"),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
      });

      const filePath = resolveTranscriptFilePath({
        cliConfigDir: config.cliConfigDir,
        cwd: worktree,
        platform,
        sessionId: FAKE_SESSION_ID,
      });
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(
        filePath,
        `${rawUserLine(worktree, "chain-w1", "from worktree")}\n`,
      );

      const transcript = yield* Effect.service(QwenTranscriptService);
      const items = (yield* Stream.runCollect(Stream.take(transcript.subscribe(THREAD_ID), 1)).pipe(
        Effect.timeout("15 seconds"),
      )) as TranscriptStreamItem[];

      assert.strictEqual(items[0]!.kind, "snapshot");
      assert.strictEqual(items[0]!.sessionId, FAKE_SESSION_ID);
      assert.deepStrictEqual(
        items[0]!.records.map((record) => record.uuid),
        ["chain-w1"],
      );
    }).pipe(Effect.provide(hostLayer));
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

// ru-code: the draft branch at the APP seam — an unknown thread (projection
// Option.none) must stream one EMPTY snapshot (sessionId null), not fail.
it.live("resolveThread maps an unknown thread (draft) to an empty snapshot", () =>
  Effect.gen(function* () {
    const realDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const hostLayer = QwenTranscriptHostLive.pipe(
      Layer.provide(projectionLayerNone),
      Layer.provideMerge(realDirectoryLayer),
    );

    yield* Effect.gen(function* () {
      const transcript = yield* Effect.service(QwenTranscriptService);
      const items = (yield* Stream.runCollect(Stream.take(transcript.subscribe(THREAD_ID), 1)).pipe(
        Effect.timeout("15 seconds"),
      )) as TranscriptStreamItem[];

      assert.deepStrictEqual(items[0], { kind: "snapshot", sessionId: null, records: [] });
    }).pipe(Effect.provide(hostLayer));
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);
