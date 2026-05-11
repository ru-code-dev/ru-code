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
import {
  GitWorkflowService,
  type GitWorkflowServiceShape,
} from "../../../src/git/GitWorkflowService.ts";

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
    const startSession = vi.fn((_: unknown, input: unknown) => {
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
});
