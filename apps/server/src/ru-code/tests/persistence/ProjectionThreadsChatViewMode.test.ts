// ru-code: the chat_view_mode SQL column round-trips a NON-NULL value — the
// persistence layer used to be exercised only on the null path (fixtures), so a
// broken column binding would have passed every fast test. Covers the marked
// seams in apps/server/src/persistence/{Layers,Services}/ProjectionThreads.ts
// and fork migration 002 (the column itself).
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../../persistence/Services/ProjectionThreads.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const THREAD_ID = ThreadId.make("thread-chat-view-sql");
const NOW = "2026-01-01T00:00:00.000Z";

const threadRow = (chatViewMode: "compact" | "detailed" | null, updatedAt: string) => ({
  threadId: THREAD_ID,
  projectId: ProjectId.make("project-chat-view-sql"),
  title: "Chat view SQL thread",
  modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "m" },
  runtimeMode: "approval-required" as const,
  chatViewMode,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurnId: null,
  createdAt: NOW,
  updatedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  latestUserMessageAt: null,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
});

layer("projection_threads.chat_view_mode round-trip", (it) => {
  it.effect("persists «detailed», reads it back, and upserts back to NULL", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-chat-view-sql"),
        title: "Chat view SQL project",
        workspaceRoot: "/tmp/project-chat-view-sql",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      });

      // Non-null write (INSERT path).
      yield* threads.upsert(threadRow("detailed", NOW));

      const rawAfterInsert = yield* sql<{ readonly chatViewMode: string | null }>`
        SELECT chat_view_mode AS "chatViewMode"
        FROM projection_threads
        WHERE thread_id = ${THREAD_ID}
      `;
      assert.strictEqual(rawAfterInsert[0]?.chatViewMode, "detailed");

      const decoded = yield* threads.getById({ threadId: THREAD_ID });
      assert.strictEqual(Option.getOrNull(decoded)?.chatViewMode, "detailed");

      // Conflict-update path back to NULL (= "never chose → settings default").
      yield* threads.upsert(threadRow(null, "2026-01-01T00:00:01.000Z"));

      const rawAfterUpdate = yield* sql<{ readonly chatViewMode: string | null }>`
        SELECT chat_view_mode AS "chatViewMode"
        FROM projection_threads
        WHERE thread_id = ${THREAD_ID}
      `;
      assert.strictEqual(rawAfterUpdate[0]?.chatViewMode, null);

      const decodedBack = yield* threads.getById({ threadId: THREAD_ID });
      assert.strictEqual(Option.getOrNull(decodedBack)?.chatViewMode, null);
    }),
  );
});
