import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type TranscriptStreamItem,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../src/config.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../../../src/provider/Services/ProviderSessionDirectory.ts";
import { QwenTranscriptLive } from "../../../src/ru-fork/qwen-transcript/QwenTranscriptLive.ts";
import { QwenTranscriptService } from "../../../src/ru-fork/qwen-transcript/QwenTranscriptService.ts";
import { resolveTranscriptFilePath } from "../../../src/ru-fork/qwen-transcript/paths.ts";

const THREAD_ID = ThreadId.make("thread-x");

const userLine = (sessionId: string, cwd: string, uuid = "u1") =>
  JSON.stringify({
    uuid,
    parentUuid: null,
    sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
    type: "user",
    message: { parts: [{ text: "hi" }] },
  });

const assistantLine = (sessionId: string, cwd: string, uuid = "a1") =>
  JSON.stringify({
    uuid,
    parentUuid: "u1",
    sessionId,
    timestamp: "2026-01-01T00:00:01.000Z",
    cwd,
    type: "assistant",
    model: "claude-opus-4",
    message: { parts: [{ text: "hello" }] },
  });

// Mock projection: optionally resolve a thread cwd (workspaceRoot + worktreePath).
const projectionLayer = (
  ctx: Option.Option<string> | "fail",
  worktreePath: string | null = null,
) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadCheckpointContext: () =>
      ctx === "fail"
        ? Effect.fail("boom")
        : Effect.succeed(
            Option.map(ctx, (workspaceRoot) => ({
              threadId: THREAD_ID,
              projectId: ProjectId.make("p1"),
              workspaceRoot,
              worktreePath,
              checkpoints: [],
            })),
          ),
  } as unknown as ProjectionSnapshotQueryShape);

// Mock directory: optionally expose a resume sessionId.
const directoryLayer = (sessionId: string | null) =>
  directoryWith(sessionId ? { schemaVersion: 1, sessionId } : null);

// Mock directory with an arbitrary resume cursor, or no binding at all.
const directoryWith = (resumeCursor: unknown | "no-binding") =>
  Layer.succeed(ProviderSessionDirectory, {
    getBinding: () =>
      Effect.succeed(
        resumeCursor === "no-binding"
          ? Option.none()
          : Option.some({
              threadId: THREAD_ID,
              provider: ProviderDriverKind.make("cli"),
              resumeCursor,
            }),
      ),
  } as unknown as ProviderSessionDirectoryShape);

const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-transcript-cfg-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("QwenTranscriptLive", (it) => {
  // Build a fresh service with the given mocked thread cwd + sessionId.
  const getService = (cwd: Option.Option<string> | "fail", sessionId: string | null) =>
    Effect.service(QwenTranscriptService).pipe(
      Effect.provide(
        QwenTranscriptLive.pipe(
          Layer.provide(projectionLayer(cwd)),
          Layer.provide(directoryLayer(sessionId)),
        ),
      ),
    );

  const filePathFor = (cwd: string, sessionId: string, runtimeOutputDirSetting?: string) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return resolveTranscriptFilePath({
        env: process.env,
        cliConfigDir: config.cliConfigDir,
        cwd,
        runtimeOutputDirSetting,
        sessionId,
      });
    });

  const writeFile = (filePath: string, content: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, content);
    });

  const mkCwd = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-transcript-cwd-" });
  });

  it.effect("emits a snapshot of an existing transcript", () =>
    Effect.gen(function* () {
      const cwd = yield* mkCwd;
      const sessionId = "sess-1";
      const filePath = yield* filePathFor(cwd, sessionId);
      yield* writeFile(filePath, `${userLine(sessionId, cwd)}\n${assistantLine(sessionId, cwd)}\n`);

      const svc = yield* getService(Option.some(cwd), sessionId);
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));

      const item = Option.getOrThrow(head);
      expect(item.kind).toBe("snapshot");
      expect(item.records.map((r) => r.type)).toEqual(["user", "assistant"]);
      expect(item.records[0]).toMatchObject({ parts: [{ kind: "text", text: "hi" }] });
    }),
  );

  it.effect("emits an empty snapshot when the file does not exist yet", () =>
    Effect.gen(function* () {
      const cwd = yield* mkCwd;
      const svc = yield* getService(Option.some(cwd), "sess-missing");
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
      expect(Option.getOrThrow(head)).toEqual({ kind: "snapshot", records: [] });
    }),
  );

  it.effect("emits an empty snapshot when the session id is not known yet", () =>
    Effect.gen(function* () {
      const cwd = yield* mkCwd;
      const svc = yield* getService(Option.some(cwd), null);
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
      expect(Option.getOrThrow(head)).toEqual({ kind: "snapshot", records: [] });
    }),
  );

  it.effect("skips malformed lines and stays alive", () =>
    Effect.gen(function* () {
      const cwd = yield* mkCwd;
      const sessionId = "sess-bad";
      const filePath = yield* filePathFor(cwd, sessionId);
      yield* writeFile(filePath, `${userLine(sessionId, cwd)}\n{not json}\n`);

      const svc = yield* getService(Option.some(cwd), sessionId);
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
      const item = Option.getOrThrow(head);
      expect(item.kind).toBe("snapshot");
      expect(item.records).toHaveLength(1);
    }),
  );

  it.effect("fails the stream when the thread cannot be resolved", () =>
    Effect.gen(function* () {
      const svc = yield* getService(Option.none(), "sess-x");
      const exit = yield* Effect.exit(Stream.runHead(svc.subscribe(THREAD_ID)));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("fails the stream when the cwd lookup errors", () =>
    Effect.gen(function* () {
      const svc = yield* getService("fail", "sess-x");
      const exit = yield* Effect.exit(Stream.runHead(svc.subscribe(THREAD_ID)));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("reads from advanced.runtimeOutputDir override, not cliConfigDir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* mkCwd;
      const overrideDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transcript-rt-" });
      const sessionId = "sess-override";

      // Workspace settings.json points the runtime base at overrideDir.
      yield* fs.makeDirectory(path.join(cwd, ".qwen"), { recursive: true });
      yield* fs.writeFileString(
        path.join(cwd, ".qwen", "settings.json"),
        JSON.stringify({ advanced: { runtimeOutputDir: overrideDir } }),
      );

      // Transcript written under the OVERRIDE dir.
      const filePath = yield* filePathFor(cwd, sessionId, overrideDir);
      yield* writeFile(filePath, `${userLine(sessionId, cwd)}\n`);

      const svc = yield* getService(Option.some(cwd), sessionId);
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
      const item = Option.getOrThrow(head);
      expect(item.kind).toBe("snapshot");
      expect(item.records).toHaveLength(1);
    }),
  );

  it.effect("uses worktreePath when present (over workspaceRoot)", () =>
    Effect.gen(function* () {
      const worktree = yield* mkCwd;
      const sessionId = "sess-wt";
      const filePath = yield* filePathFor(worktree, sessionId);
      yield* writeFile(filePath, `${userLine(sessionId, worktree)}\n`);

      const svc = yield* Effect.service(QwenTranscriptService).pipe(
        Effect.provide(
          QwenTranscriptLive.pipe(
            // workspaceRoot is a bogus dir; worktreePath is where the file lives.
            Layer.provide(projectionLayer(Option.some("/nonexistent-workspace"), worktree)),
            Layer.provide(directoryLayer(sessionId)),
          ),
        ),
      );
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
      expect(Option.getOrThrow(head).records).toHaveLength(1);
    }),
  );

  it.effect("emits an empty snapshot when no provider binding exists", () =>
    Effect.gen(function* () {
      const cwd = yield* mkCwd;
      const svc = yield* Effect.service(QwenTranscriptService).pipe(
        Effect.provide(
          QwenTranscriptLive.pipe(
            Layer.provide(projectionLayer(Option.some(cwd))),
            Layer.provide(directoryWith("no-binding")),
          ),
        ),
      );
      const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
      expect(Option.getOrThrow(head)).toEqual({ kind: "snapshot", records: [] });
    }),
  );

  it.effect("treats unparseable resume cursors as no session", () =>
    Effect.gen(function* () {
      const cwd = yield* mkCwd;
      const badCursors: unknown[] = [
        { schemaVersion: 2, sessionId: "x" },
        { schemaVersion: 1, sessionId: 123 },
        { schemaVersion: 1, sessionId: "" },
      ];
      for (const resumeCursor of badCursors) {
        const svc = yield* Effect.service(QwenTranscriptService).pipe(
          Effect.provide(
            QwenTranscriptLive.pipe(
              Layer.provide(projectionLayer(Option.some(cwd))),
              Layer.provide(directoryWith(resumeCursor)),
            ),
          ),
        );
        const head = yield* Stream.runHead(svc.subscribe(THREAD_ID));
        expect(Option.getOrThrow(head)).toEqual({ kind: "snapshot", records: [] });
      }
    }),
  );
});

// Real-clock test: fs.watch / poll / sleep advance in wall-clock time, so we
// observe a genuine live append (it.live runs outside the it.layer context, so
// this test provides its own layer + Scope).
it.live("streams a live append after the snapshot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transcript-live-" });
    const sessionId = "sess-live";
    const filePath = resolveTranscriptFilePath({
      env: process.env,
      cliConfigDir: config.cliConfigDir,
      cwd,
      runtimeOutputDirSetting: undefined,
      sessionId,
    });
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, `${userLine(sessionId, cwd)}\n`);

    const svc = yield* Effect.service(QwenTranscriptService).pipe(
      Effect.provide(
        QwenTranscriptLive.pipe(
          Layer.provide(projectionLayer(Option.some(cwd))),
          Layer.provide(directoryLayer(sessionId)),
        ),
      ),
    );

    // Append a record shortly after subscribing; the collector blocks until 2 items.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(300));
        yield* fs.writeFileString(
          filePath,
          `${userLine(sessionId, cwd)}\n${assistantLine(sessionId, cwd)}\n`,
        );
      }),
    );

    const items = (yield* Stream.runCollect(
      Stream.take(svc.subscribe(THREAD_ID), 2),
    )) as TranscriptStreamItem[];
    expect(items[0]?.kind).toBe("snapshot");
    expect(items[0]?.records.map((r) => r.uuid)).toEqual(["u1"]);
    expect(items[1]?.kind).toBe("append");
    expect(items[1]?.records.map((r) => r.uuid)).toEqual(["a1"]);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
