// ru-code: coverage for the qwen-specific process-control surface the session
// runtime adds on top of the port's generic ACP runtime — `forceKill` (SIGKILL
// teardown) and `waitForExit` (child-exit watcher). We drive the runtime layer
// with a FAKE ChildProcessHandle (Stream.never stdio) so NO real process is
// spawned. The full start/prompt/session lifecycle rides real child stdio and is
// covered by the Phase 3 fake-ACP e2e suite (see AcpJsonRpcConnection.test.ts).
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";

import {
  QwenAcpSessionRuntime,
  type AcpSessionRuntimeOptions,
} from "../../../qwen/acp/QwenAcpSessionRuntime.ts";
// ru-code: warm-engine phase-split coverage drives the runtime over the fake
// ACP agent (real wire, no process) instead of the inert fake handle above.
import { FAKE_SESSION_ID, type FakeAcpScript } from "../fake-acp/fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "../fake-acp/fakeAcpSpawner.ts";

interface KillCall {
  readonly killSignal: string | undefined;
}

// Build a fake ChildProcessHandle whose stdio never emits (so the ACP client's
// background reader parks harmlessly) and whose exitCode / kill are scripted.
const makeFakeHandle = (config: {
  readonly exitCode: Effect.Effect<number, never>;
  readonly kill: (options?: { readonly killSignal?: string }) => Effect.Effect<void, never>;
}) =>
  ({
    pid: 4242,
    exitCode: config.exitCode,
    isRunning: Effect.succeed(true),
    kill: config.kill,
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    // The runtime never touches these on the tested paths; cast covers the
    // remaining structural/branding members of ChildProcessHandle.
  }) as unknown as ChildProcessSpawner.ChildProcessHandle;

const baseOptions: AcpSessionRuntimeOptions = {
  spawn: { command: process.execPath, args: ["/opt/cli.js", "--acp"] },
  cwd: "/tmp/qwen-test",
  clientInfo: { name: "t3-code", version: "0.0.0" },
  authMethodId: "openai",
};

// Provide the runtime layer with a fake spawner returning `handle`; Crypto comes
// from NodeServices. Everything runs scoped so the background ACP reader is
// interrupted on completion.
const withRuntime = <A>(
  handle: ChildProcessSpawner.ChildProcessHandle,
  use: (runtime: QwenAcpSessionRuntime["Service"]) => Effect.Effect<A>,
): Effect.Effect<A> => {
  const fakeSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: () => Effect.succeed(handle),
  } as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"]);

  return Effect.gen(function* () {
    const runtime = yield* QwenAcpSessionRuntime;
    return yield* use(runtime);
  }).pipe(
    Effect.provide(QwenAcpSessionRuntime.layer(baseOptions)),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    // ru-code: seal the layer-build error channel — a runtime construction
    // failure is a test defect, and it.effect requires `Effect<A, never, never>`.
    Effect.orDie,
  );
};

describe("QwenAcpSessionRuntime process control", () => {
  it.effect("forceKill sends SIGKILL to the child", () =>
    Effect.gen(function* () {
      const kills: Array<KillCall> = [];
      const handle = makeFakeHandle({
        exitCode: Effect.succeed(0),
        kill: (options) =>
          Effect.sync(() => {
            kills.push({ killSignal: options?.killSignal });
          }),
      });

      yield* withRuntime(handle, (runtime) => runtime.forceKill);

      expect(kills).toHaveLength(1);
      expect(kills[0]?.killSignal).toBe("SIGKILL");
    }),
  );

  it.effect("forceKill swallows a kill failure (Effect.ignore) and still completes", () =>
    Effect.gen(function* () {
      const handle = makeFakeHandle({
        exitCode: Effect.succeed(0),
        // A failing kill must not surface — forceKill is Effect<void> (no error channel).
        kill: () =>
          Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.BadArgument({
                module: "FakeHandle",
                method: "kill",
                description: "kernel refused",
              }),
            ),
          ) as unknown as Effect.Effect<void, never>,
      });

      // Resolving at all (no failure) is the assertion.
      const result = yield* withRuntime(handle, (runtime) => runtime.forceKill);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("waitForExit resolves once the child's exitCode settles", () =>
    Effect.gen(function* () {
      const handle = makeFakeHandle({
        exitCode: Effect.succeed(0),
        kill: () => Effect.void,
      });

      const result = yield* withRuntime(handle, (runtime) => runtime.waitForExit);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("waitForExit swallows an exitCode failure and still resolves", () =>
    Effect.gen(function* () {
      const handle = makeFakeHandle({
        // exitCode failing (e.g. read-exit-status error) must be swallowed — the
        // watcher only cares about the timing, never the error.
        exitCode: Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.BadArgument({
              module: "FakeHandle",
              method: "exitCode",
              description: "no exit status",
            }),
          ),
        ) as unknown as Effect.Effect<number, never>,
        kill: () => Effect.void,
      });

      const result = yield* withRuntime(handle, (runtime) => runtime.waitForExit);
      expect(result).toBeUndefined();
    }),
  );
});

// ru-code: warm-engine (acp-process-pool) phase split — `start` is now
// warmup (initialize+authenticate) composed with bind (session setup). These
// cases pin the split's memoization/reset semantics over the fake ACP agent.

// Runs `use` against a runtime wired to the fake agent driven by `script`.
// Mirrors `withRuntime` but rides the real ACP wire (in-memory queues).
const withFakeAgentRuntime = <A>(
  script: FakeAcpScript,
  use: (runtime: QwenAcpSessionRuntime["Service"]) => Effect.Effect<A>,
  optionOverrides?: Partial<AcpSessionRuntimeOptions>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const runtime = yield* QwenAcpSessionRuntime;
    return yield* use(runtime);
  }).pipe(
    Effect.provide(
      QwenAcpSessionRuntime.layer({ ...baseOptions, ...optionOverrides }).pipe(
        Layer.provide(fakeAcpSpawnerLayer(script)),
      ),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    // Layer-build failures are test defects (same convention as withRuntime).
    Effect.orDie,
  );

describe("QwenAcpSessionRuntime warm-engine phase split", () => {
  it.effect("warmup authenticates but creates no session", () =>
    Effect.gen(function* () {
      let authenticateCount = 0;
      let createSessionCount = 0;
      yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          onAuthenticate: () => {
            authenticateCount += 1;
          },
          onCreateSession: () => {
            createSessionCount += 1;
          },
        },
        (runtime) => Effect.orDie(runtime.warmup()),
      );
      expect(authenticateCount).toBe(1);
      expect(createSessionCount).toBe(0);
    }),
  );

  it.effect("warmup is memoized — a second call re-runs nothing", () =>
    Effect.gen(function* () {
      let authenticateCount = 0;
      yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          onAuthenticate: () => {
            authenticateCount += 1;
          },
        },
        (runtime) => Effect.orDie(runtime.warmup().pipe(Effect.andThen(runtime.warmup()))),
      );
      expect(authenticateCount).toBe(1);
    }),
  );

  it.effect("bindAndStart after warmup performs session setup exactly once", () =>
    Effect.gen(function* () {
      let authenticateCount = 0;
      let createSessionCount = 0;
      const result = yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          onAuthenticate: () => {
            authenticateCount += 1;
          },
          onCreateSession: () => {
            createSessionCount += 1;
          },
        },
        (runtime) =>
          Effect.orDie(
            runtime.warmup().pipe(
              Effect.andThen(runtime.bindAndStart({ cwd: "/tmp/warm-bind" })),
              // memoized: a follow-up start() must return the same session
              // without another session/new.
              Effect.tap(() => runtime.start()),
            ),
          ),
      );
      expect(result.sessionId).toBe(FAKE_SESSION_ID);
      expect(authenticateCount).toBe(1);
      expect(createSessionCount).toBe(1);
    }),
  );

  it.effect("start() without prior warmup runs both phases (classic-path equivalence)", () =>
    Effect.gen(function* () {
      let authenticateCount = 0;
      let createSessionCount = 0;
      const result = yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          onAuthenticate: () => {
            authenticateCount += 1;
          },
          onCreateSession: () => {
            createSessionCount += 1;
          },
        },
        (runtime) => Effect.orDie(runtime.start()),
      );
      expect(result.sessionId).toBe(FAKE_SESSION_ID);
      expect(authenticateCount).toBe(1);
      expect(createSessionCount).toBe(1);
    }),
  );

  it.effect("bindAndStart with a resume cursor takes session/load with the bind params", () =>
    Effect.gen(function* () {
      const loadedSessionIds: Array<string> = [];
      let createSessionCount = 0;
      const result = yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          onLoadSession: (sessionId) => {
            loadedSessionIds.push(sessionId);
          },
          onCreateSession: () => {
            createSessionCount += 1;
          },
        },
        (runtime) =>
          Effect.orDie(
            runtime
              .warmup()
              .pipe(
                Effect.andThen(
                  runtime.bindAndStart({ cwd: "/tmp/warm-bind", resumeSessionId: "prior-cursor" }),
                ),
              ),
          ),
      );
      // The fake accepts any load id and answers ok — the assertion is that the
      // BIND params (not the creation options, which carry no cursor) drove the
      // session/load request.
      expect(loadedSessionIds).toEqual(["prior-cursor"]);
      expect(createSessionCount).toBe(0);
      expect(result.sessionId).toBe("prior-cursor");
    }),
  );

  it.effect("a failed bind resets to Warmed — retry re-runs session setup, never auth", () =>
    Effect.gen(function* () {
      let authenticateCount = 0;
      let createSessionCount = 0;
      const exits = yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          startBehavior: "error",
          onAuthenticate: () => {
            authenticateCount += 1;
          },
          onCreateSession: () => {
            createSessionCount += 1;
          },
        },
        (runtime) =>
          Effect.gen(function* () {
            const first = yield* Effect.exit(runtime.bindAndStart({ cwd: "/tmp/warm-bind" }));
            const second = yield* Effect.exit(runtime.bindAndStart({ cwd: "/tmp/warm-bind" }));
            return [first, second] as const;
          }),
      );
      expect(Exit.isFailure(exits[0])).toBe(true);
      expect(Exit.isFailure(exits[1])).toBe(true);
      // Both attempts reached session/new (Binding→Warmed reset, not stuck),
      // while initialize+authenticate ran exactly once (warmup survives).
      expect(createSessionCount).toBe(2);
      expect(authenticateCount).toBe(1);
    }),
  );

  it.effect("concurrent bindAndStart single-flights the session setup", () =>
    Effect.gen(function* () {
      let createSessionCount = 0;
      const [first, second] = yield* withFakeAgentRuntime(
        {
          onPrompt: (steps) => steps.respondOk(),
          onCreateSession: () => {
            createSessionCount += 1;
          },
        },
        (runtime) =>
          Effect.orDie(
            Effect.all(
              [
                runtime.bindAndStart({ cwd: "/tmp/warm-bind" }),
                runtime.bindAndStart({ cwd: "/tmp/warm-bind" }),
              ],
              { concurrency: 2 },
            ),
          ),
      );
      expect(first?.sessionId).toBe(FAKE_SESSION_ID);
      expect(second?.sessionId).toBe(FAKE_SESSION_ID);
      expect(createSessionCount).toBe(1);
    }),
  );
});

// ru-code (qwen-compression wave): THE EVENT-STREAM BARRIER.
//
// `drainEvents` is what makes the compaction outcome readable the moment
// `session/prompt` resolves, with no timer: it offers an `EventStreamBarrier`
// into the SAME FIFO queue the `session/update` frames ride and awaits its
// acknowledgement, so every frame ahead of it must have been consumed first.
//
// These two cases pin the mechanism from both sides. The test itself plays the
// consumer the adapter's notification loop plays in production — including the
// acknowledgement, which is the whole contract.
describe("QwenAcpSessionRuntime event-stream barrier", () => {
  const promptOnce = (runtime: QwenAcpSessionRuntime["Service"]) =>
    Effect.orDie(
      runtime
        .start()
        .pipe(Effect.andThen(runtime.prompt({ prompt: [{ type: "text", text: "привет" }] }))),
    );

  // `it.live`: both cases measure a REAL wait (the point is that nothing
  // resolves the barrier), so the default TestClock would never fire the bound.
  it.live("blocks while the queued frames are UNCONSUMED", () =>
    Effect.gen(function* () {
      const outcome = yield* withFakeAgentRuntime(
        { onPrompt: (steps) => steps.emitText("один").emitText("два").respondOk() },
        (runtime) =>
          Effect.gen(function* () {
            yield* promptOnce(runtime);
            // NOTHING has consumed `getEvents()`, so both chunks are still in
            // the queue and the barrier lands behind them. The wait must not
            // resolve — this is exactly the window in which the old code read
            // `hiddenCompressOutcome` and found nothing.
            return yield* Effect.timeoutOption(runtime.drainEvents, "500 millis");
          }),
      );
      expect(Option.isNone(outcome)).toBe(true);
    }),
  );

  it.live("completes once a consumer has drained past it", () =>
    Effect.gen(function* () {
      const outcome = yield* withFakeAgentRuntime(
        { onPrompt: (steps) => steps.emitText("один").emitText("два").respondOk() },
        (runtime) =>
          Effect.gen(function* () {
            yield* promptOnce(runtime);
            // The consumer: drain forever, acknowledging every barrier — the
            // adapter's notification loop reduced to its one relevant line.
            yield* Effect.forkChild(
              Stream.runForEach(runtime.getEvents(), (event) =>
                event._tag === "EventStreamBarrier"
                  ? Deferred.succeed(event.acknowledge, undefined)
                  : Effect.void,
              ),
            );
            return yield* Effect.timeoutOption(runtime.drainEvents, "10 seconds");
          }),
      );
      expect(Option.isSome(outcome)).toBe(true);
    }),
  );
});

// ru-code (qwen-compression wave): SLASH-COMMAND CHUNKS MINT NO ASSISTANT SEGMENT.
//
// A behaviour change the move to the 0.21.1 channel forced. At 0.13.1 a
// `/compress` report arrived as a vendor ext notification and never reached this
// machinery at all; at 0.21.1 it is an ordinary `agent_message_chunk`, so it
// would open an assistant SEGMENT like any text. The adapter either drops that
// text (a HIDDEN `/compress`, which runs with no turn of ours — the segment's
// `item.started` would carry no turnId) or replaces it with the localized line,
// so a segment opened for it survives as an EMPTY assistant bubble in the
// thread. Suppressed at `QwenAcpSessionRuntime.ts` beside the existing
// background-frame guard.
//
// Pinned from both sides here, because the failure is user-visible on the wave's
// main path and silent in every other test: a compress suite that only checks
// the row would never notice the stray bubble.
describe("QwenAcpSessionRuntime slash-command segment suppression", () => {
  /** Drain `getEvents()` for `window`, acknowledging barriers, and collect tags. */
  const tagsOfOnePrompt = (script: FakeAcpScript): Effect.Effect<ReadonlyArray<string>> =>
    withFakeAgentRuntime(script, (runtime) =>
      Effect.gen(function* () {
        const seen: string[] = [];
        yield* Effect.forkChild(
          Stream.runForEach(runtime.getEvents(), (event) =>
            Effect.gen(function* () {
              seen.push(event._tag);
              // This fiber IS the consumer, so it owes the barrier its
              // acknowledgement — exactly what the adapter's loop does.
              if (event._tag === "EventStreamBarrier") {
                yield* Deferred.succeed(event.acknowledge, undefined);
              }
            }),
          ),
        );
        yield* Effect.orDie(
          runtime
            .start()
            .pipe(Effect.andThen(runtime.prompt({ prompt: [{ type: "text", text: "п" }] }))),
        );
        // The frames are offered from the transport's own fiber; drain past them.
        yield* Effect.orDie(runtime.drainEvents);
        return seen;
      }),
    );

  it("a slash_command chunk yields a ContentDelta and NO AssistantItemStarted", () =>
    Effect.gen(function* () {
      const tags = yield* tagsOfOnePrompt({
        onPrompt: (steps) => steps.emitCompressProgress().respondOk(),
      });
      expect(tags, `observed ${tags.join(", ")}`).toContain("ContentDelta");
      expect(
        tags,
        `THE BREAK: a compress report opened an assistant segment — every hidden ` +
          `/compress would leave an empty bubble. Observed ${tags.join(", ")}`,
      ).not.toContain("AssistantItemStarted");
    }).pipe(Effect.runPromise));

  it("an UNTAGGED chunk still yields both — the suppression is scoped", () =>
    Effect.gen(function* () {
      const tags = yield* tagsOfOnePrompt({
        onPrompt: (steps) => steps.emitText("привет").respondOk(),
      });
      expect(tags, `observed ${tags.join(", ")}`).toContain("AssistantItemStarted");
      expect(tags, `observed ${tags.join(", ")}`).toContain("ContentDelta");
    }).pipe(Effect.runPromise));
});
