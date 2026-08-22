// ru-code (round 7): approval DETAIL against the EXACT qwen 0.13.1 wire shape a
// subagent WriteFile produces (user's debug log, 2026-07-20): rich toolCall with
// title "WriteFile: Writing to …", kind "edit", rawInput{file_path, content} and
// content blocks. The port must surface the FILE PATH as the request detail —
// the old `command ?? title ?? detail` precedence let the generic presentation
// title («Изменение файлов») shadow it — and must carry the RAW request as
// `payload.args` so the web can synthesize the proposed diff on the awaiting
// row. A shell request keeps deriving its command unchanged.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  QwenSettings,
  ThreadId,
  defaultInstanceIdForDriver,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/schema";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

const testServices = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

// The exact 0.13.1 subagent WriteFile permission request from the user's log.
const writeFilePermission = (): AcpSchema.RequestPermissionRequest =>
  ({
    sessionId: FAKE_SESSION_ID,
    toolCall: {
      toolCallId: "write-1",
      title: "WriteFile: Writing to permission-test.txt",
      kind: "edit",
      status: "pending",
      rawInput: {
        file_path: "/proj/permission-test.txt",
        content: "hello from subagent\n",
      },
      content: [{ type: "content", content: { type: "text", text: "hello from subagent\n" } }],
      locations: [{ path: "/proj/permission-test.txt" }],
    },
    options: [
      { optionId: "proceed_once", name: "Yes, allow once", kind: "allow_once" },
      { optionId: "proceed_always", name: "Yes, allow always", kind: "allow_always" },
      { optionId: "cancel", name: "No (esc)", kind: "reject_once" },
    ],
  }) as AcpSchema.RequestPermissionRequest;

const shellPermission = (): AcpSchema.RequestPermissionRequest =>
  ({
    sessionId: FAKE_SESSION_ID,
    toolCall: {
      toolCallId: "shell-1",
      title: "Shell: sudo ls -la /var/root",
      kind: "execute",
      status: "pending",
      rawInput: { command: "sudo ls -la /var/root" },
    },
    options: [
      { optionId: "proceed_once", name: "Yes, allow once", kind: "allow_once" },
      { optionId: "cancel", name: "No (esc)", kind: "reject_once" },
    ],
  }) as AcpSchema.RequestPermissionRequest;

type RequestOpened = Extract<ProviderRuntimeEvent, { type: "request.opened" }>;

const runOpenedRequestProbe = (input: {
  readonly threadId: ThreadId;
  readonly prefix: string;
  readonly permission: () => AcpSchema.RequestPermissionRequest;
  readonly assertOpened: (event: RequestOpened) => void;
}) => {
  const script: FakeAcpScript = {
    onPrompt: (steps) => steps.requestPermission(input.permission()).respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const opened = yield* Deferred.make<RequestOpened>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      event.type === "request.opened" ? Deferred.succeed(opened, event) : Effect.void,
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: input.threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* Effect.forkChild(adapter.sendTurn({ threadId: input.threadId, input: "do the thing" }));

    const openedEvent = yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);
    input.assertOpened(openedEvent);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices(input.prefix))),
    TestClock.withLive,
  );
};

it.effect("a subagent WriteFile approval surfaces the file path + raw args", () =>
  runOpenedRequestProbe({
    threadId: ThreadId.make("qwen-approval-detail-write"),
    prefix: "ru-code-approval-write-",
    permission: writeFilePermission,
    assertOpened: (event) => {
      assert.strictEqual(event.payload.requestType, "file_change_approval");
      // The path, never the generic «Changed files» presentation title.
      assert.strictEqual(event.payload.detail, "/proj/permission-test.txt");
      // The raw request rides along for the web's proposed-diff synthesis.
      const args = event.payload.args as {
        toolCall?: { rawInput?: { file_path?: string; content?: string } };
      };
      assert.strictEqual(args.toolCall?.rawInput?.file_path, "/proj/permission-test.txt");
      assert.strictEqual(args.toolCall?.rawInput?.content, "hello from subagent\n");
    },
  }),
);

it.effect("a shell approval keeps surfacing the command (unchanged)", () =>
  runOpenedRequestProbe({
    threadId: ThreadId.make("qwen-approval-detail-shell"),
    prefix: "ru-code-approval-shell-",
    permission: shellPermission,
    assertOpened: (event) => {
      assert.strictEqual(event.payload.requestType, "exec_command_approval");
      assert.strictEqual(event.payload.detail, "sudo ls -la /var/root");
    },
  }),
);

// ── Full pipeline: the PROJECTED approval activity carries detail + raw args ──
// (real reactor → QwenAdapter over the fake ACP child → ingestion → projection —
// the exact activity `derivePendingApprovals` reads on the client; task 5's
// server half is only true if `args` survives THIS chain untruncated.)

const PIPE_PROJECT = ProjectId.make("approval-detail-project");
const PIPE_THREAD = ThreadId.make("approval-detail-thread");
const QWEN = ProviderDriverKind.make("qwen");
const NOW = "2026-05-01T00:00:00.000Z";
const decodeQwenSettingsEffect = Schema.decodeEffect(QwenSettings);

const registryOverride =
  (script: FakeAcpScript) => (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
    Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const qwenSettings = yield* decodeQwenSettingsEffect({});
        const qwenAdapter = yield* makeQwenAdapter(qwenSettings);
        return makeAdapterRegistryMock({ [QWEN]: qwenAdapter });
      }).pipe(Effect.orDie),
    ).pipe(
      Layer.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script),
          ServerConfig.layerTest(ctx.workspaceDir, ctx.rootDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      Layer.orDie,
    );

it.live("the projected approval.requested activity carries the path detail + raw args", () => {
  // The WriteFile permission parks (no respond step) — the approval stays open.
  const script: FakeAcpScript = {
    onPrompt: (steps) => {
      steps.requestPermission(writeFilePermission());
    },
  };
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride: registryOverride(script) }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("approval-detail-project-create"),
          projectId: PIPE_PROJECT,
          title: "Approval Detail Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null, // ru-code: thread-state chat view (extended chat)
          commandId: CommandId.make("approval-detail-thread-create"),
          threadId: PIPE_THREAD,
          projectId: PIPE_PROJECT,
          title: "Approval Detail Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("approval-detail-turn"),
          threadId: PIPE_THREAD,
          message: {
            messageId: MessageId.make("approval-detail-msg"),
            role: "user",
            text: "write the file",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });

        const thread = yield* harness.waitForThread(
          PIPE_THREAD,
          (candidate) => candidate.activities.some((a) => a.kind === "approval.requested"),
          20_000,
        );
        const activity = thread.activities.find((a) => a.kind === "approval.requested");
        const payload = activity!.payload as {
          requestKind?: string;
          detail?: string;
          args?: { toolCall?: { rawInput?: { file_path?: string; content?: string } } };
        };
        assert.strictEqual(payload.requestKind, "file-change");
        // The PATH, not the generic presentation title — and NOT truncated.
        assert.strictEqual(payload.detail, "/proj/permission-test.txt");
        // The raw request args survive ingestion/projection intact — the web's
        // proposed-diff synthesis depends on the unclamped rawInput.
        assert.strictEqual(
          payload.args?.toolCall?.rawInput?.file_path,
          "/proj/permission-test.txt",
        );
        assert.strictEqual(payload.args?.toolCall?.rawInput?.content, "hello from subagent\n");
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
});
