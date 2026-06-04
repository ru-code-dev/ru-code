// ru-fork: transport-agnostic fake ACP **agent** (server) for the error-engine
// tests. It speaks the REAL ndJSON-RPC wire contract by reusing effect-acp's
// own `AcpAgent` (so "passes in CI" and "looks right when driven live" exercise
// the same protocol machinery). A test supplies a per-prompt script via the
// `PromptSteps` DSL; the agent interprets it to reproduce each error class from
// the §4 table (RPC error, malformed frame, broken pipe, process exit, …).
//
// Two shells consume this core:
//   - the in-memory shell (`fakeAcpSpawner.ts`) for unit tests;
//   - the stdio shell (`tests/fixtures/fake-acp-server.ts`) for live manual mode.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Stdio from "effect/Stdio";
import * as AcpAgent from "effect-acp/agent";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

/** The session id the fake hands back from `session/new` (and accepts on prompt). */
export const FAKE_SESSION_ID = "fake-acp-session";

type StopReason = AcpSchema.PromptResponse["stopReason"];

/**
 * Transport-level controls the SHELL provides. These reach below the JSON-RPC
 * layer to reproduce wire failures the agent handler cannot express as a normal
 * response:
 *   - `writeRaw`        → emit a malformed frame   → client AcpProtocolParseError (C1)
 *   - `closeTransport`  → EOF + failed exit status  → client AcpTransportError    (C4)
 *   - `exit(code)`      → EOF + exit status `code`   → client AcpProcessExitedError (B1)
 */
export interface FakeAcpTransportControls {
  readonly writeRaw: (bytes: string) => Effect.Effect<void>;
  readonly closeTransport: Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
}

/** Fluent recorder for a single `session/prompt`. Chainable; terminal ops end it. */
export interface PromptSteps {
  /** Stream an assistant text chunk (`session/update` agent_message_chunk). */
  emitText(text: string): PromptSteps;
  /** Resolve the prompt with a stopReason (turn completes). Terminal. */
  respondOk(stopReason?: StopReason): void;
  /** Reply with a JSON-RPC error (qwen stays alive). Terminal. */
  respondError(code: number, message: string, data?: unknown): void;
  /** Write a malformed frame to the client (→ AcpProtocolParseError). Terminal. */
  writeRaw(bytes: string): void;
  /** Close the transport mid-prompt (→ AcpTransportError). Terminal. */
  closeTransport(): void;
  /** Exit the child with `code` (→ AcpProcessExitedError). Terminal. */
  exit(code: number): void;
}

export interface FakeAcpScript {
  /** Called once per `session/prompt`; build the response with the step DSL. */
  readonly onPrompt: (steps: PromptSteps) => void;
}

type FakeStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ok"; readonly stopReason: StopReason }
  | { readonly kind: "error"; readonly code: number; readonly message: string; readonly data?: unknown }
  | { readonly kind: "raw"; readonly bytes: string }
  | { readonly kind: "close" }
  | { readonly kind: "exit"; readonly code: number };

class PromptStepsRecorder implements PromptSteps {
  readonly steps: FakeStep[] = [];
  emitText(text: string): PromptSteps {
    this.steps.push({ kind: "text", text });
    return this;
  }
  respondOk(stopReason: StopReason = "end_turn"): void {
    this.steps.push({ kind: "ok", stopReason });
  }
  respondError(code: number, message: string, data?: unknown): void {
    this.steps.push({ kind: "error", code, message, ...(data !== undefined ? { data } : {}) });
  }
  writeRaw(bytes: string): void {
    this.steps.push({ kind: "raw", bytes });
  }
  closeTransport(): void {
    this.steps.push({ kind: "close" });
  }
  exit(code: number): void {
    this.steps.push({ kind: "exit", code });
  }
}

/**
 * Build the fake agent over `stdio` and register the §B method handlers. Returns
 * after registration; the agent's RPC server runs forked in the current scope.
 * `controls` lets the prompt DSL induce transport-level failures.
 */
export const runFakeAcpAgent = (
  stdio: Stdio.Stdio,
  script: FakeAcpScript,
  controls: FakeAcpTransportControls,
): Effect.Effect<void, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const agent = yield* AcpAgent.make(stdio);
    // Per-prompt cancel hook: session/cancel resolves the in-flight prompt with
    // stopReason "cancelled" (matches qwen's wire behaviour). Stop in the adapter
    // currently force-kills, so this is exercised only by a graceful cancel path.
    const activeCancelRef = yield* Ref.make<Deferred.Deferred<StopReason> | undefined>(undefined);

    yield* agent.handleInitialize(() =>
      Effect.succeed({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
        },
      }),
    );
    yield* agent.handleAuthenticate(() => Effect.succeed({}));
    yield* agent.handleCreateSession(() => Effect.succeed({ sessionId: FAKE_SESSION_ID }));
    yield* agent.handleLoadSession(() => Effect.succeed({ sessionId: FAKE_SESSION_ID }));
    yield* agent.handleSetSessionConfigOption(() => Effect.succeed({ configOptions: [] }));
    yield* agent.handleSetSessionModel(() => Effect.succeed({}));
    yield* agent.handleCancel(() =>
      Ref.get(activeCancelRef).pipe(
        Effect.flatMap((deferred) =>
          deferred ? Deferred.succeed(deferred, "cancelled").pipe(Effect.asVoid) : Effect.void,
        ),
      ),
    );

    yield* agent.handlePrompt((request) =>
      Effect.gen(function* () {
        const recorder = new PromptStepsRecorder();
        script.onPrompt(recorder);
        const cancelled = yield* Deferred.make<StopReason>();
        yield* Ref.set(activeCancelRef, cancelled);

        for (const step of recorder.steps) {
          switch (step.kind) {
            case "text":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                },
              });
              break;
            case "raw":
              yield* controls.writeRaw(step.bytes);
              break;
            case "close":
              yield* controls.closeTransport;
              break;
            case "exit":
              yield* controls.exit(step.code);
              break;
            case "ok":
              return { stopReason: step.stopReason };
            case "error":
              return yield* new AcpErrors.AcpRequestError({
                code: step.code,
                errorMessage: step.message,
                ...(step.data !== undefined ? { data: step.data } : {}),
              });
          }
        }
        // No terminal response in the script: park until session/cancel resolves
        // us cancelled, or until the transport dies (the client fails the prompt
        // and this fiber is interrupted on scope teardown).
        const stopReason = yield* Deferred.await(cancelled);
        return { stopReason };
      }),
    );
  });

export { PromptStepsRecorder };
