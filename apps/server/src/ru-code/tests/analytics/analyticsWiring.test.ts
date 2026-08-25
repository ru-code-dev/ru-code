// ru-code: wiring tests for the analytics feature — the package engine composed the way
// the HOST composes it: the fork-migrated database graph (SqlitePersistenceMemory runs
// upstream + ru_code migrations, so analytics_file_cache exists exactly as in prod) +
// AnalyticsRuntimeLive + the config port. Proves the full chain transcript-on-disk →
// scanner → fork-migrated cache table → snapshot, and the host config adapter's mapping.

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AnalyticsManagerConfig,
  AnalyticsRuntimeLive,
  AnalyticsScanner,
} from "@smart-tools/qwen-cli-analytics/server";

import { ServerConfig } from "../../../config.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { analyticsConfigLayer, AnalyticsHostLayer } from "../../analytics/analyticsPorts.ts";

const telemetryLine = (uiEvent: Record<string, unknown>): string =>
  JSON.stringify({ type: "system", subtype: "ui_telemetry", systemPayload: { uiEvent } });

const FIXTURE_TRANSCRIPT = [
  JSON.stringify({
    sessionId: "session-fixture",
    cwd: "/home/user/sample-project",
    gitBranch: "main",
    type: "user",
    message: "почини сборку",
  }),
  telemetryLine({
    "event.name": "qwen-code.api_response",
    "event.timestamp": "2026-07-01T10:00:00.000Z",
    model: "qwen3-coder",
    input_token_count: 100,
    output_token_count: 50,
    thoughts_token_count: 10,
    cached_content_token_count: 5,
    duration_ms: 1200,
    prompt_id: "session-fixture########1",
  }),
  telemetryLine({
    "event.name": "qwen-code.tool_call",
    "event.timestamp": "2026-07-01T10:00:05.000Z",
    function_name: "run_shell_command",
    success: true,
    decision: "auto_accept",
  }),
].join("\n");

// Config port over a scoped temp dir as the cliConfigDir (the scan reads
// `<cliConfigDir>/projects`) with a deterministic zone — the layer owns the dir for the
// block's lifetime.
const scopedTestConfigLayer = Layer.effect(
  AnalyticsManagerConfig,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cliConfigDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ru-analytics-wiring-",
    });
    return AnalyticsManagerConfig.of({
      cliConfigDir,
      timeZone: "UTC",
    });
  }),
);

// The exact composition shape ws.ts provides, over the HOST's fork-migrated memory DB.
const makeWiringLayer = () =>
  AnalyticsRuntimeLive.pipe(
    Layer.provideMerge(scopedTestConfigLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const wiringLayer = it.layer(makeWiringLayer());

wiringLayer("analytics host wiring", (it) => {
  it.effect("scans a transcript into the fork-migrated cache and serves it back", () =>
    Effect.gen(function* () {
      const config = yield* AnalyticsManagerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const chatsDir = path.join(
        config.cliConfigDir,
        "projects",
        "-home-user-sample-project",
        "chats",
      );
      yield* fileSystem.makeDirectory(chatsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        // qwen-shaped filename (32 hex chars) — the scanner accepts ONLY qwen's own
        // session pattern now; the in-record sessionId ("session-fixture") still wins
        // over the filename stem, so every assertion below is unaffected.
        path.join(chatsDir, "abcdef0123456789abcdef0123456789.jsonl"),
        FIXTURE_TRANSCRIPT,
      );

      const scanner = yield* AnalyticsScanner;
      const refreshed = yield* scanner.refresh();

      assert.strictEqual(refreshed.scannedFiles, 1);
      assert.strictEqual(refreshed.parsedFiles, 1);
      assert.lengthOf(refreshed.sessions, 1);
      const session = refreshed.sessions[0]!;
      assert.strictEqual(session.sessionId, "session-fixture");
      assert.strictEqual(session.projectId, "-home-user-sample-project");
      assert.strictEqual(session.projectLabel, "sample-project");
      assert.strictEqual(session.projectKind, "real");
      assert.strictEqual(session.branch, "main");
      assert.strictEqual(session.model, "qwen3-coder");
      assert.strictEqual(session.category, "dialog");
      assert.strictEqual(session.turns, 1);
      assert.strictEqual(session.apiCalls, 1);
      assert.deepStrictEqual(session.tokens, { input: 100, output: 50, thinking: 10, cached: 5 });
      assert.deepStrictEqual(session.toolCounts, { run_shell_command: 1 });
      assert.strictEqual(session.autoAccepted, 1);
      assert.deepStrictEqual(session.tokensByDay["2026-07-01"], {
        input: 100,
        output: 50,
        thinking: 10,
        cached: 5,
        apiCalls: 1,
      });

      // The pure read must serve the same rows straight from the fork-migrated table.
      const reread = yield* scanner.getSnapshot();
      assert.lengthOf(reread.sessions, 1);
      assert.strictEqual(reread.scannedFiles, 0);
      assert.strictEqual(reread.sessions[0]!.sessionId, "session-fixture");
    }),
  );
});

// A separate layer block = a fresh in-memory database (this scenario destroys the table).
const brokenTableLayer = it.layer(makeWiringLayer());

brokenTableLayer("analytics host wiring — persistence failure", (it) => {
  it.effect("fails with AnalyticsError when the cache table is unavailable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE analytics_file_cache`;
      const scanner = yield* AnalyticsScanner;
      const failure = yield* scanner.getSnapshot().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AnalyticsError");
      assert.strictEqual(failure.detail, "Failed to read analytics snapshot");
    }),
  );
});

// ── the lifetime guards ─────────────────────────────────────────────────────────────────
//
// The scanner forks its scan into its OWN layer scope. If the layer is built only at the ws
// route, that scope closes as soon as the route handler is CONSTRUCTED — before any RPC is
// served — and `forkIn` on a closed scope interrupts the fiber before its first step: the
// scan never runs and every refresh fails with "…the scanner layer's scope is already
// closed…". The fix is to build it in the long-lived runtime graph (`server.ts`).
//
// This regressed once, in the worst possible way: the `server.ts` line was lost in a
// recovery, and typecheck, lint, build and the whole test suite stayed GREEN because
// nothing asserted the wiring. These two tests exist so that cannot repeat.

// ru-code: GUARD 1 (the type-level assertion that server.ts's exported runtime graph
// publishes AnalyticsScanner) is dropped on this base per C-app-007 option B — decisions
// row 6: "no guard why would it disapear". The graph is no longer a module-level value any
// file can name (it is built inside `makeServerLayer`, server.ts:697), so the guard's
// original form cannot exist here, and no replacement is added — same precedent as the
// structurally identical auto-update engine, which ships with no wiring guard at all
// (`grep -rna 'AutoUpdateHostLayer' apps/server/src/ru-code/tests/` → no output). The
// closed-scope diagnostic below (GUARD 3) still converts a lost attachment into a named,
// fast failure instead of a silent hang.

// GUARD 2 — runtime. The ws route provides AnalyticsHostLayer a SECOND time; that must be a
// memo HIT onto the graph's instance, not a second scanner with its own single-flight state.
// Built twice through ONE explicit memo map because `CurrentMemoMap.getOrCreate` does not
// cache — two bare `buildWithScope` calls in a plain fiber would get DIFFERENT memo maps and
// the test would pass for the wrong reason.
//
// Then the route-shaped scope is closed while the graph-shaped one stays open, and refresh
// must still work — which is precisely what fails when only the route builds the layer.
const memoLayer = it.layer(makeWiringLayer());

memoLayer("analytics layer memoization", (it) => {
  it.effect("the ws build reuses the graph's scanner and survives its own scope closing", () =>
    Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap;
      const hostLayer = AnalyticsRuntimeLive.pipe(Layer.provideMerge(scopedTestConfigLayer));

      const graphScope = yield* Scope.make();
      const graphContext = yield* Layer.buildWithMemoMap(hostLayer, memoMap, graphScope);

      const routeScope = yield* Scope.make();
      const routeContext = yield* Layer.buildWithMemoMap(hostLayer, memoMap, routeScope);

      const graphScanner = Context.get(graphContext, AnalyticsScanner);
      const routeScanner = Context.get(routeContext, AnalyticsScanner);
      // Memo HIT: one scanner, therefore one single-flight slot.
      assert.strictEqual(graphScanner, routeScanner);

      // The ws route's own scope closing must NOT take the scanner down with it.
      yield* Scope.close(routeScope, Exit.void);
      const snapshot = yield* graphScanner.refresh();
      assert.isArray(snapshot.sessions);

      yield* Scope.close(graphScope, Exit.void);
    }),
  );

  // The test above builds a layer SHAPED like production; this one builds the exact object
  // production imports — `AnalyticsHostLayer`, the const that `server.ts:419` and
  // `ws.ts:2201` both provide — together with the real `analyticsConfigLayer` rather than a
  // test stand-in.
  //
  // Measured while writing it: memoization keys on the INNER `AnalyticsRuntimeLive` const,
  // not on the outer composition, so rebuilding the same shape around it shares the scanner
  // too. The audit's complaint that the shape test "proves generic memoization, not the
  // production seam" is therefore weaker than it reads — the two are equivalent for the
  // memo map. What this adds is coverage of the exported object and its real config layer:
  // it fails if `AnalyticsHostLayer` is ever pointed at a different config, or wrapped in
  // something that does not memoize. Single-scanner-ness itself is guaranteed one level
  // down, by `AnalyticsRuntimeLive` being a module-level const.
  it.effect("the EXPORTED AnalyticsHostLayer yields one scanner across both provide sites", () =>
    Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap;
      const hostLayer = AnalyticsHostLayer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ru-analytics-host-" })),
      );

      const serverScope = yield* Scope.make();
      const serverContext = yield* Layer.buildWithMemoMap(hostLayer, memoMap, serverScope);
      const wsScope = yield* Scope.make();
      const wsContext = yield* Layer.buildWithMemoMap(hostLayer, memoMap, wsScope);

      assert.strictEqual(
        Context.get(serverContext, AnalyticsScanner),
        Context.get(wsContext, AnalyticsScanner),
      );

      yield* Scope.close(wsScope, Exit.void);
      yield* Scope.close(serverScope, Exit.void);
    }),
  );

  // GUARD 3 — the NEGATIVE case (D-1, 2026-08-02). The misconfiguration itself: the layer
  // built ONLY in a scope that closes before any RPC — exactly the 2026-07-27 incident.
  // `diagnoseUnstartedScan` must convert the pre-start interrupt into the NAMED error,
  // fast. Delete the diagnostic (or the second settle behind it) and this test dies with
  // "all fibers interrupted" — the silent-spinner symptom, caught here instead of live.
  //
  // ⚠ Built through an EXPLICIT FRESH memo map, for the inverse of the reason the memo
  // test above needs one: inside this `it.layer` block the AMBIENT memo map already
  // holds the block's AnalyticsRuntimeLive build (module-level const ⇒ memo key), so a
  // bare buildWithScope would MEMO-HIT the block's scanner — whose scope never closes —
  // and this test would assert nothing. Discovered the hard way on 2026-08-02.
  it.effect("refresh fails FAST with the named wiring error when the ONLY scope is closed", () =>
    Effect.gen(function* () {
      const freshMemoMap = yield* Layer.makeMemoMap;
      const hostLayer = AnalyticsRuntimeLive.pipe(Layer.provideMerge(scopedTestConfigLayer));
      const onlyScope = yield* Scope.make();
      const context = yield* Layer.buildWithMemoMap(hostLayer, freshMemoMap, onlyScope);
      const scanner = Context.get(context, AnalyticsScanner);
      yield* Scope.close(onlyScope, Exit.void);
      const failure = yield* scanner.refresh().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AnalyticsError");
      assert.include(failure.detail, "the scanner layer's scope is already closed");
    }),
  );
});

const adapterLayer = it.layer(
  analyticsConfigLayer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ru-analytics-config-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

adapterLayer("analytics host config adapter", (it) => {
  it.effect("maps ServerConfig.cliConfigDir and pins no zone in prod", () =>
    Effect.gen(function* () {
      const analyticsConfig = yield* AnalyticsManagerConfig;
      const serverConfig = yield* ServerConfig;
      assert.strictEqual(analyticsConfig.cliConfigDir, serverConfig.cliConfigDir);
      // Machine-local bucketing in prod: the adapter must NOT pin a zone.
      assert.isUndefined(analyticsConfig.timeZone);
    }),
  );
});
