// ru-fork: round-trip test for the probe-result cache repository. One row per
// authored config (keyed by configCacheKey); JSON tools column decodes back to
// the structured McpTool[]; checked_at_ms survives so the supervisor's due check
// works after a restart hydrate.

import { IsoDateTime, type McpProbeRecord } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { McpProbeCacheRepository } from "../../../src/persistence/Services/McpProbeCache.ts";
import { McpProbeCacheRepositoryLive } from "../../../src/persistence/Layers/ProjectionMcpProbeCache.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";

const layer = it.layer(
  McpProbeCacheRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const onlineRecord = {
  configKey: "abc12345",
  transport: "stdio",
  status: "online",
  tools: [
    { name: "read_file", description: "Read a file" },
    { name: "write_file", description: "Write a file" },
  ],
  lastError: null,
  serverDescription: null,
  serverWebsiteUrl: null,
  checkedAt: IsoDateTime.make("2026-06-07T10:00:00.000Z"),
  checkedAtMs: 1_780_000_000_000,
} satisfies McpProbeRecord;

layer("McpProbeCache", (it) => {
  it.effect("upserts then reads back the decoded record", () =>
    Effect.gen(function* () {
      const repo = yield* McpProbeCacheRepository;
      yield* repo.upsert(onlineRecord);

      const found = yield* repo.getByKey({ configKey: onlineRecord.configKey });
      assert.isTrue(Option.isSome(found));
      const record = Option.getOrThrow(found);
      assert.equal(record.status, "online");
      assert.equal(record.transport, "stdio");
      assert.equal(record.checkedAtMs, onlineRecord.checkedAtMs);
      assert.equal(record.lastError, null);
      assert.deepEqual([...record.tools], [...onlineRecord.tools]);
    }),
  );

  it.effect("upsert overwrites the existing row for the same configKey", () =>
    Effect.gen(function* () {
      const repo = yield* McpProbeCacheRepository;
      yield* repo.upsert(onlineRecord);
      yield* repo.upsert({
        ...onlineRecord,
        status: "offline",
        tools: [],
        lastError: "connect timed out",
        checkedAtMs: onlineRecord.checkedAtMs + 60_000,
      });

      const record = Option.getOrThrow(
        yield* repo.getByKey({ configKey: onlineRecord.configKey }),
      );
      assert.equal(record.status, "offline");
      assert.equal(record.lastError, "connect timed out");
      assert.equal(record.tools.length, 0);
    }),
  );

  it.effect("getByKey returns None for an unknown key", () =>
    Effect.gen(function* () {
      const repo = yield* McpProbeCacheRepository;
      const found = yield* repo.getByKey({ configKey: "does-not-exist" });
      assert.isTrue(Option.isNone(found));
    }),
  );

  it.effect("deleteKeysNotIn keeps the live keys and drops the rest (GC)", () =>
    Effect.gen(function* () {
      const repo = yield* McpProbeCacheRepository;
      yield* repo.upsert({ ...onlineRecord, configKey: "keep-1" });
      yield* repo.upsert({ ...onlineRecord, configKey: "keep-2" });
      yield* repo.upsert({ ...onlineRecord, configKey: "orphan" });

      yield* repo.deleteKeysNotIn(["keep-1", "keep-2"]);

      assert.isTrue(Option.isSome(yield* repo.getByKey({ configKey: "keep-1" })));
      assert.isTrue(Option.isSome(yield* repo.getByKey({ configKey: "keep-2" })));
      assert.isTrue(Option.isNone(yield* repo.getByKey({ configKey: "orphan" })));
    }),
  );

  it.effect("deleteKeysNotIn with an empty list clears the whole cache", () =>
    Effect.gen(function* () {
      const repo = yield* McpProbeCacheRepository;
      yield* repo.upsert({ ...onlineRecord, configKey: "a" });
      yield* repo.upsert({ ...onlineRecord, configKey: "b" });

      yield* repo.deleteKeysNotIn([]);

      assert.isTrue(Option.isNone(yield* repo.getByKey({ configKey: "a" })));
      assert.isTrue(Option.isNone(yield* repo.getByKey({ configKey: "b" })));
    }),
  );
});
