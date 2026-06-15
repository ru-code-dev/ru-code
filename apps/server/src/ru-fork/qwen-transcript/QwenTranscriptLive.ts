// ru-fork: Live layer for QwenTranscriptService. Resolves a thread's transcript
// path from durable state (cwd via ProjectionSnapshotQuery.getThreadCheckpointContext,
// sessionId via ProviderSessionDirectory.getBinding), then tails the append-only
// JSONL with the proven serverSettings.ts watch+debounce pattern. Race-free and
// dedup-free: the watch is attached before the first read and every emission is a
// slice from one monotonic counter. See ru-fork-instrumental/advanced-chat/PLAN.md.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ThreadId, TranscriptStreamItem } from "@t3tools/contracts";
import { TranscriptSubscribeError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { readRuntimeOutputDirOverride } from "./cliSettings.ts";
import { parseAndNormalize } from "./parse.ts";
import { resolveChatsDir } from "./paths.ts";
import { QwenTranscriptService, type QwenTranscriptServiceShape } from "./QwenTranscriptService.ts";

/** Parse our `CliResumeCursor` ({ schemaVersion: 1, sessionId }) → sessionId. */
const parseResumeSessionId = (raw: unknown): Option.Option<string> => {
  if (typeof raw !== "object" || raw === null) return Option.none();
  const candidate = raw as { schemaVersion?: unknown; sessionId?: unknown };
  if (candidate.schemaVersion !== 1) return Option.none();
  return typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
    ? Option.some(candidate.sessionId)
    : Option.none();
};

export const QwenTranscriptLive = Layer.effect(
  QwenTranscriptService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const directory = yield* ProviderSessionDirectory;
    const projection = yield* ProjectionSnapshotQuery;

    const resolveSessionId = (threadId: ThreadId): Effect.Effect<Option.Option<string>> =>
      directory.getBinding(threadId).pipe(
        Effect.map((binding) =>
          Option.isSome(binding) ? parseResumeSessionId(binding.value.resumeCursor) : Option.none(),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    const subscribe = (
      threadId: ThreadId,
    ): Stream.Stream<TranscriptStreamItem, TranscriptSubscribeError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const ctx = yield* projection.getThreadCheckpointContext(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TranscriptSubscribeError({
                  message: `Не удалось определить рабочий каталог потока: ${String(cause)}`,
                  threadId,
                }),
            ),
          );
          if (Option.isNone(ctx)) {
            return yield* new TranscriptSubscribeError({
              message: `Поток ${threadId} не найден.`,
              threadId,
            });
          }
          const cwd = ctx.value.worktreePath ?? ctx.value.workspaceRoot;
          const runtimeOutputDirSetting = yield* readRuntimeOutputDirOverride(
            fs,
            path,
            config.cliConfigDir,
            cwd,
          );
          const baseInput = {
            env: process.env,
            cliConfigDir: config.cliConfigDir,
            cwd,
            runtimeOutputDirSetting,
          };
          const chatsDir = resolveChatsDir(baseInput);
          yield* fs.makeDirectory(chatsDir, { recursive: true }).pipe(Effect.ignore);

          const emitted = yield* Ref.make(0);

          // Read + normalize all records currently on disk for a known session.
          // Missing session id or missing file → no records (an empty feed).
          const readRecords = (sessionId: Option.Option<string>) =>
            Effect.gen(function* () {
              if (Option.isNone(sessionId)) return [];
              const filePath = path.join(chatsDir, `${sessionId.value}.jsonl`);
              const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
              const text = exists
                ? yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""))
                : "";
              return parseAndNormalize(text);
            });

          // First non-empty read is a `snapshot`; every later read is an `append`
          // of only the records beyond what we've already emitted.
          const readDelta: Effect.Effect<TranscriptStreamItem> = Effect.gen(function* () {
            const sessionId = yield* resolveSessionId(threadId);
            const records = yield* readRecords(sessionId);
            const prev = yield* Ref.getAndSet(emitted, records.length);
            return prev === 0
              ? { kind: "snapshot" as const, records }
              : { kind: "append" as const, records: records.slice(prev) };
          });

          // Hybrid liveness: fs.watch gives instant updates where inotify works;
          // a low-frequency poll guarantees eventual delivery on filesystems that
          // don't deliver watch events (network/virtual mounts, some containers).
          // Each trigger re-reads + slices, so duplicate triggers are harmless and
          // any append missed in the watch-attach window is healed by the next poll.
          const watchTriggers = fs.watch(chatsDir).pipe(
            Stream.filter((event) => event.path.endsWith(".jsonl")),
            Stream.debounce(Duration.millis(100)),
            Stream.catchCause(() => Stream.empty),
          );
          const pollTriggers = Stream.tick(Duration.seconds(1));
          const liveDeltas = Stream.merge(watchTriggers, pollTriggers).pipe(
            Stream.mapEffect(() => readDelta),
          );

          return Stream.concat(Stream.fromEffect(readDelta), liveDeltas).pipe(
            Stream.filter((item) => item.kind === "snapshot" || item.records.length > 0),
          );
        }),
      );

    return { subscribe } satisfies QwenTranscriptServiceShape;
  }),
);
