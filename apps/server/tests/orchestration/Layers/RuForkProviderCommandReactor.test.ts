// @effect-diagnostics nodeBuiltinImport:off
/**
 * RuForkProviderCommandReactor.test.ts
 *
 * ru-fork-specific behavior around runtimeMode plumbing.
 *
 * Verifies the Clean-1 design from
 * `ru-fork-instrumental/analysis/cli-code/02-setmode-plan-v013-A.md`:
 *
 *  - `runtimeModeChanged` was removed from the restart guard in
 *    `ProviderCommandReactor` — dropdown changes alone no longer restart
 *    the provider session.
 *  - `runtimeMode` is plumbed live via `ProviderSendTurnInput.runtimeMode`
 *    (every turn) and `ProviderRespondToRequestInput.runtimeMode` (every
 *    approval response) so the adapter can resolve CLI's ApprovalMode
 *    and pick plan-approval optionId from the current dropdown value.
 *  - Other restart triggers (cwd / provider-instance / model) are intact.
 *    Those are exercised in `ProviderCommandReactor.test.ts`; we don't
 *    duplicate them here.
 *
 * Harness is duplicated from `ProviderCommandReactor.test.ts`'s
 * `createHarness`. Extracting to a shared helper would restructure the
 * upstream test file; duplication keeps the upstream file untouched and
 * makes future sync mechanical.
 */
import { CLI_NAME, CLI_DEFAULT_MODEL } from "@ru-fork/branding";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  McpError,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../../src/config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { OrchestrationEventStoreLive } from "../../../src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../../src/provider/Services/ProviderService.ts";
import {
  TextGeneration,
  type TextGenerationShape,
} from "../../../src/textGeneration/TextGeneration.ts";
import { RepositoryIdentityResolverLive } from "../../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "../../../src/orchestration/Layers/ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../../../src/orchestration/Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../../../src/orchestration/Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../../src/serverSettings.ts";
import { VcsStatusBroadcaster } from "../../../src/vcs/VcsStatusBroadcaster.ts";
import { McpOverlay } from "../../../src/ru-fork/mcp/McpOverlay.ts";
import {
  GitWorkflowService,
  type GitWorkflowServiceShape,
} from "../../../src/git/GitWorkflowService.ts";

// ru-fork: a controllable stand-in for what McpOverlay.writeOverlay(projectId) returns at turn-start.
// The reactor compares `fingerprint` against what the thread's session spawned with to decide on a
// respawn; a test mutates these entries between turns to simulate "the overlay changed / didn't".
type OverlayEntry = {
  readonly overlayPath: string;
  readonly allowedServerNames: ReadonlyArray<string>;
  readonly fingerprint: string;
  readonly fail?: boolean; // writeOverlay rejects ⇒ reactor spawns WITHOUT an overlay (best-effort)
  // ru-fork #4: when set, the stub writeOverlay creates a REAL file at overlayPath each turn
  // (mirrors production) so deletion tests can observe the file appear and disappear.
  readonly materialize?: boolean;
};

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("RuForkProviderCommandReactor (runtimeMode Clean-1)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  // ru-fork: harness is a verbatim copy of `createHarness` in
  // ProviderCommandReactor.test.ts. Kept duplicated to avoid restructuring
  // the upstream test file. Thread is created with initial
  // runtimeMode: "approval-required".
  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    // ru-fork: per-project overlay results the McpOverlay stub returns (keyed by projectId). A test
    // owns this Map and mutates it between turns; absent ⇒ the default constant overlay (existing tests).
    readonly overlayEntries?: Map<string, OverlayEntry>;
    // ru-fork #4: make the provider's startSession FAIL, to prove the reactor still
    // deletes the ephemeral overlay on a failed spawn (Effect.ensuring fires on failure).
    readonly failStartSession?: boolean;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ru-fork-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make(CLI_NAME),
      model: CLI_DEFAULT_MODEL,
    };
    const failStartSession = input?.failStartSession ?? false;
    // ru-fork #4 ordering proof: snapshot the overlay file's on-disk state at the EXACT
    // moment the spawn is invoked (the mock runs synchronously when the reactor calls
    // startSession), so a test can assert the file was written + finalized BEFORE the spawn.
    const overlayPresentAtSpawn: Array<{ readonly exists: boolean; readonly content: string | null }> = [];
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const spawnOverlayPath =
        typeof input === "object" &&
        input !== null &&
        "settingsOverlayPath" in input &&
        typeof input.settingsOverlayPath === "string"
          ? input.settingsOverlayPath
          : null;
      const exists = spawnOverlayPath !== null && fs.existsSync(spawnOverlayPath);
      overlayPresentAtSpawn.push({
        exists,
        content: exists ? fs.readFileSync(spawnOverlayPath!, "utf8") : null,
      });
      if (failStartSession) {
        // ru-fork #4: simulated spawn failure (e.g. a start-handshake timeout). The
        // reactor's overlay finalizer must still delete the ephemeral file.
        return Effect.fail(new McpError({ detail: "simulated start failure (test)" }));
      }
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" ||
            input.runtimeMode === "auto-accept-edits" ||
            input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "approval-required",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) return;
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) runtimeSessions.splice(index, 1);
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(CLI_NAME);
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      hasParkedRequests: () => Effect.succeed(false),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      // ru-fork: stub the spawn-time MCP overlay (see ProviderCommandReactor.test.ts). Reads the
      // test-controlled per-project entries; absent ⇒ a stable default (so existing tests are unaffected).
      Layer.provideMerge(
        Layer.succeed(McpOverlay, {
          writeOverlay: (projectId) => {
            const entry = input?.overlayEntries?.get(projectId) ?? {
              overlayPath: "/tmp/mcp-test-overlay.json",
              allowedServerNames: [],
              fingerprint: "test-overlay",
            };
            if (entry.fail) {
              return Effect.fail(new McpError({ detail: "overlay write failed (test)" }));
            }
            return Effect.sync(() => {
              // ru-fork #4: materialize a real file so deletion tests can observe it.
              if (entry.materialize) {
                fs.mkdirSync(path.dirname(entry.overlayPath), { recursive: true });
                fs.writeFileSync(entry.overlayPath, "{}");
              }
            }).pipe(
              Effect.as({
                overlayPath: entry.overlayPath,
                allowedServerNames: entry.allowedServerNames,
                fingerprint: entry.fingerprint,
              }),
            );
          },
          removeOverlay: () => Effect.void,
          // ru-fork #4: real fs delete so the reactor's ensuring(deleteOverlayFile) is observable.
          deleteOverlayFile: (overlayPath: string) =>
            Effect.sync(() => {
              fs.rmSync(overlayPath, { force: true });
            }),
          removeAllOverlays: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowServiceShape>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Ru Fork Provider Project",
        workspaceRoot: "/tmp/ru-fork-provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      runtimeSessions,
      overlayPresentAtSpawn,
      stateDir,
      drain,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Group 1 — restart guard
  // ─────────────────────────────────────────────────────────────────────

  describe("restart guard", () => {
    it("does NOT restart the provider session when only runtimeMode changes between turns", async () => {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      // First turn with initial runtimeMode (approval-required from createHarness).
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      // Toggle the dropdown — orchestrator-side state change only.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-toggle"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "auto-accept-edits",
          createdAt: now,
        }),
      );

      await waitFor(async () => {
        const readModel = await harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        return thread?.runtimeMode === "auto-accept-edits";
      });

      // Send a second turn so the reactor processes the new runtimeMode.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "auto-accept-edits",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      // The contract: ONE startSession total, no restart fired.
      expect(harness.startSession.mock.calls.length).toBe(1);
      expect(harness.stopSession.mock.calls.length).toBe(0);
    });

    it("runtime-mode.set alone (no subsequent turn) does NOT call startSession or sendTurn", async () => {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      // No turn has been dispatched. Just toggle the runtime mode.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-toggle-only"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          createdAt: now,
        }),
      );

      await waitFor(async () => {
        const readModel = await harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        return thread?.runtimeMode === "full-access";
      });

      // Let the reactor drain any queued work — should produce no adapter calls.
      await harness.drain();

      expect(harness.startSession.mock.calls.length).toBe(0);
      expect(harness.sendTurn.mock.calls.length).toBe(0);
      expect(harness.stopSession.mock.calls.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Group 2 — live runtimeMode plumbing through sendTurn
  // ─────────────────────────────────────────────────────────────────────

  describe("live runtimeMode plumbing", () => {
    it("next sendTurn after a dropdown toggle carries the new runtimeMode in its input", async () => {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      // Bootstrap the session with the initial runtimeMode.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-bootstrap"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("bootstrap-message"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      // First sendTurn carries the initial runtimeMode.
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: "thread-1",
        runtimeMode: "approval-required",
      });

      // Toggle to auto-accept-edits.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-toggle-to-auto"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "auto-accept-edits",
          createdAt: now,
        }),
      );
      await waitFor(async () => {
        const readModel = await harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        return thread?.runtimeMode === "auto-accept-edits";
      });

      // Second turn should carry the new runtimeMode on its sendTurn input.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-second-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("second-message"),
            role: "user",
            text: "now please edit",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "auto-accept-edits",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        threadId: "thread-1",
        runtimeMode: "auto-accept-edits",
      });
    });

    it("multiple sequential toggles produce one startSession and N sendTurns each with the correct runtimeMode", async () => {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      const sequence: Array<"approval-required" | "auto-accept-edits" | "full-access"> = [
        "approval-required",
        "auto-accept-edits",
        "approval-required",
        "full-access",
      ];

      for (const [index, runtimeMode] of sequence.entries()) {
        if (index > 0) {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`cmd-toggle-${index}`),
              threadId: ThreadId.make("thread-1"),
              runtimeMode,
              createdAt: now,
            }),
          );
          await waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return thread?.runtimeMode === runtimeMode;
          });
        }
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-turn-${index}`),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: asMessageId(`message-${index}`),
              role: "user",
              text: `turn ${index}`,
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode,
            createdAt: now,
          }),
        );
        await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
      }

      // One session start covers all four turns — no restart on toggle.
      expect(harness.startSession.mock.calls.length).toBe(1);
      expect(harness.stopSession.mock.calls.length).toBe(0);

      // Each sendTurn carries the runtimeMode that was live when it dispatched.
      for (const [index, expectedMode] of sequence.entries()) {
        expect(harness.sendTurn.mock.calls[index]?.[0]).toMatchObject({
          threadId: "thread-1",
          runtimeMode: expectedMode,
        });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Group 3 — live runtimeMode plumbing through respondToRequest
  // ─────────────────────────────────────────────────────────────────────

  describe("live runtimeMode on approval responses", () => {
    it("thread.approval.respond carries the current dropdown value to respondToRequest", async () => {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      // Seed a session record on the thread so the approval-respond path
      // finds an active session to route to.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: CLI_NAME,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-respond-1"),
          threadId: ThreadId.make("thread-1"),
          requestId: asApprovalRequestId("approval-1"),
          decision: "accept",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
      expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        requestId: "approval-1",
        decision: "accept",
        runtimeMode: "approval-required",
      });
    });

    it("thread.approval.respond after a dropdown toggle carries the toggled value, not the session-start value", async () => {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      // Seed a session record (session was started in approval-required).
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-toggle"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: CLI_NAME,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      // User toggles the dropdown after the session is up.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-toggle-before-respond"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "auto-accept-edits",
          createdAt: now,
        }),
      );
      await waitFor(async () => {
        const readModel = await harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        return thread?.runtimeMode === "auto-accept-edits";
      });

      // User clicks Реализовать (or any approve) — the response must carry the
      // current dropdown value so CliAdapter picks the right plan-approval optionId.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-respond-after-toggle"),
          threadId: ThreadId.make("thread-1"),
          requestId: asApprovalRequestId("approval-2"),
          decision: "accept",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
      expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        requestId: "approval-2",
        decision: "accept",
        runtimeMode: "auto-accept-edits",
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Group 4 — MCP overlay applied at spawn + respawn on overlay change
  // (the qwen integration: apply overlay + allow-list each turn; restart
  //  the session iff the project's overlay fingerprint changed)
  // ─────────────────────────────────────────────────────────────────────

  describe("MCP overlay spawn + respawn", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make(CLI_NAME),
      model: CLI_DEFAULT_MODEL,
    };

    const startTurn = (harness: Awaited<ReturnType<typeof createHarness>>, threadId: string, turn: number) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-${threadId}-${turn}`),
          threadId: ThreadId.make(threadId),
          message: {
            messageId: asMessageId(`msg-${threadId}-${turn}`),
            role: "user",
            text: `turn-${turn}`,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

    it("hands the overlay path + allow-list to startSession on spawn", async () => {
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath: "/tmp/ov-p1.json", allowedServerNames: ["srv-a", "srv-b"], fingerprint: "fp-1" }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      expect(harness.startSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          settingsOverlayPath: "/tmp/ov-p1.json",
          allowedMcpServers: ["srv-a", "srv-b"],
        }),
      );
    });

    it("does NOT restart when the overlay fingerprint is unchanged between turns", async () => {
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath: "/tmp/ov.json", allowedServerNames: ["srv"], fingerprint: "stable" }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await startTurn(harness, "thread-1", 2); // identical overlay
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.startSession).toHaveBeenCalledTimes(1); // one spawn, no respawn
    });

    it("restarts WITH the prior resumeCursor when the overlay fingerprint changes", async () => {
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath: "/tmp/ov.json", allowedServerNames: ["srv"], fingerprint: "fp-1" }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      const spawnResumeCursor = harness.runtimeSessions[0]?.resumeCursor;

      // A config change moved this project's overlay fingerprint ⇒ next turn must respawn.
      overlayEntries.set("project-1", { overlayPath: "/tmp/ov.json", allowedServerNames: ["srv"], fingerprint: "fp-2" });
      await startTurn(harness, "thread-1", 2);
      await waitFor(() => harness.startSession.mock.calls.length === 2);

      // The respawn carries the prior session's resume cursor (history preserved).
      expect(harness.startSession).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ resumeCursor: spawnResumeCursor }),
      );
    });

    it("spawns WITHOUT an overlay (best-effort) when writeOverlay fails", async () => {
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath: "", allowedServerNames: [], fingerprint: "x", fail: true }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      // The turn still spawned — just without a settingsOverlayPath (overlay failure must not block it).
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      expect(harness.startSession).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.not.objectContaining({ settingsOverlayPath: expect.anything() }),
      );
    });

    it("an overlay change in ONE project does not restart another project's thread", async () => {
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath: "/tmp/p1.json", allowedServerNames: ["srv"], fingerprint: "p1-fp-1" }],
        ["project-2", { overlayPath: "/tmp/p2.json", allowedServerNames: ["srv"], fingerprint: "p2-fp-1" }],
      ]);
      const harness = await createHarness({ overlayEntries });

      // Stand up project-2 + thread-2 next to the harness's project-1/thread-1.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-2"),
          projectId: asProjectId("project-2"),
          title: "P2",
          workspaceRoot: "/tmp/ru-fork-provider-project-2",
          defaultModelSelection: modelSelection,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-2"),
          title: "Thread 2",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );

      const spawnsFor = (threadId: string) =>
        harness.startSession.mock.calls.filter((call) => call[0] === ThreadId.make(threadId)).length;

      // First turn for each thread ⇒ exactly one spawn each.
      await startTurn(harness, "thread-1", 1);
      await startTurn(harness, "thread-2", 1);
      await waitFor(() => spawnsFor("thread-1") === 1 && spawnsFor("thread-2") === 1);

      // Change ONLY project-1's overlay fingerprint, then take a turn on BOTH threads.
      overlayEntries.set("project-1", { overlayPath: "/tmp/p1.json", allowedServerNames: ["srv"], fingerprint: "p1-fp-2" });
      await startTurn(harness, "thread-1", 2);
      await startTurn(harness, "thread-2", 2);
      await waitFor(() => spawnsFor("thread-1") === 2); // thread-1 respawned (its overlay changed)
      await harness.drain();

      expect(spawnsFor("thread-1")).toBe(2);
      expect(spawnsFor("thread-2")).toBe(1); // thread-2's overlay unchanged ⇒ no respawn
    });

    // ── ru-fork #4: ephemeral overlay deletion ──────────────────────────────
    // The overlay file (plaintext secrets) must be deleted the moment the spawn it
    // fed settles — success, failure, OR reuse. (RED until the reactor wraps the
    // spawn region in Effect.ensuring(deleteOverlayFile).)

    const freshOverlayPath = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-fork-ov4-"));
      createdBaseDirs.add(dir);
      return path.join(dir, "p1", "system.json");
    };

    it("G4 — deletes the overlay file after a SUCCESSFUL spawn", async () => {
      const overlayPath = freshOverlayPath();
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath, allowedServerNames: [], fingerprint: "fp-1", materialize: true }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await harness.drain();
      expect(fs.existsSync(overlayPath)).toBe(false);
    });

    it("G5 — deletes the overlay file even when the spawn ERRORS", async () => {
      const overlayPath = freshOverlayPath();
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath, allowedServerNames: [], fingerprint: "fp-err", materialize: true }],
      ]);
      const harness = await createHarness({ overlayEntries, failStartSession: true });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.startSession.mock.calls.length === 1); // attempted once
      await harness.drain();
      expect(fs.existsSync(overlayPath)).toBe(false);
    });

    it("G6 — deletes the overlay file on a REUSE (no-respawn) turn", async () => {
      const overlayPath = freshOverlayPath();
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath, allowedServerNames: ["srv"], fingerprint: "stable", materialize: true }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      // Turn 2: identical fingerprint ⇒ reuse (no new spawn). writeOverlay re-materializes the file.
      await startTurn(harness, "thread-1", 2);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await harness.drain();
      expect(harness.startSession).toHaveBeenCalledTimes(1); // reuse: no respawn
      expect(fs.existsSync(overlayPath)).toBe(false); // still deleted on the reuse turn
    });

    it("G1 — deleting the overlay between turns NEVER triggers a spurious respawn", async () => {
      const overlayPath = freshOverlayPath();
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath, allowedServerNames: ["srv"], fingerprint: "stable", materialize: true }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      // Simulate the ephemeral delete having removed the file between turns.
      fs.rmSync(overlayPath, { force: true });
      await startTurn(harness, "thread-1", 2);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await harness.drain();
      // The restart decision uses the in-memory fingerprint (unchanged), NOT the file —
      // so a missing file must NOT cause a respawn. (Proves deletion ⊥ apply.)
      expect(harness.startSession).toHaveBeenCalledTimes(1);
    });

    it("G13 — the overlay file is on disk AND complete at the instant startSession is invoked", async () => {
      const overlayPath = freshOverlayPath();
      const overlayEntries = new Map<string, OverlayEntry>([
        ["project-1", { overlayPath, allowedServerNames: ["srv"], fingerprint: "fp-1", materialize: true }],
      ]);
      const harness = await createHarness({ overlayEntries });
      await startTurn(harness, "thread-1", 1);
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      // Snapshot taken synchronously INSIDE the startSession mock ⇒ proves the reactor
      // awaited writeOverlay (file written + finalized) BEFORE invoking the spawn.
      const snapshot = harness.overlayPresentAtSpawn[0];
      expect(snapshot?.exists).toBe(true);
      expect(() => JSON.parse(snapshot!.content!)).not.toThrow(); // complete, not a partial frame
    });
  });
});
