// ru-code: qwen ACP session runtime. Faithful port of the fork's runtime onto
// the port's effect-acp + shared AcpRuntimeModel. Differs from the port's
// generic AcpSessionRuntime by exposing process-level control the qwen adapter
// needs — `forceKill` (SIGKILL teardown) and `waitForExit` (child-exit watcher)
// — and by replaying-suppression on session/load with fallback to session/new.
// The silence-timeout watchdogs are intentionally NOT present (see plan §5.1).

import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "../../../provider/acp/AcpRuntimeModel.ts";

// ru-code: how long `readChildExit` waits for the child's exit status before
// concluding the child is still alive. On the B1 path the child has already
// exited, so exitCode resolves immediately; only a genuine child-alive transport
// break pays this bound.
const CHILD_EXIT_READ_TIMEOUT_MS = 500;

type AcpClientService = EffectAcpClient.AcpClient["Service"];

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

/**
 * ru-code: session-setup parameters for the deferred-bind path. A warm
 * (pre-spawned, initialized+authenticated) runtime is project-agnostic until
 * bound — the thread's cwd and resume cursor arrive here instead of via the
 * creation options.
 */
export interface AcpSessionBindParams {
  readonly cwd: string;
  readonly resumeSessionId?: string;
}

export interface AcpSessionRuntimeShape {
  readonly handleRequestPermission: AcpClientService["handleRequestPermission"];
  readonly handleElicitation: AcpClientService["handleElicitation"];
  readonly handleReadTextFile: AcpClientService["handleReadTextFile"];
  readonly handleWriteTextFile: AcpClientService["handleWriteTextFile"];
  readonly handleCreateTerminal: AcpClientService["handleCreateTerminal"];
  readonly handleTerminalOutput: AcpClientService["handleTerminalOutput"];
  readonly handleTerminalWaitForExit: AcpClientService["handleTerminalWaitForExit"];
  readonly handleTerminalKill: AcpClientService["handleTerminalKill"];
  readonly handleTerminalRelease: AcpClientService["handleTerminalRelease"];
  readonly handleSessionUpdate: AcpClientService["handleSessionUpdate"];
  readonly handleElicitationComplete: AcpClientService["handleElicitationComplete"];
  readonly handleUnknownExtRequest: AcpClientService["handleUnknownExtRequest"];
  readonly handleUnknownExtNotification: AcpClientService["handleUnknownExtNotification"];
  readonly handleExtRequest: AcpClientService["handleExtRequest"];
  readonly handleExtNotification: AcpClientService["handleExtNotification"];
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  /**
   * ru-code: warm-engine phase 1 of `start` — `initialize` + `authenticate`
   * only, no session. Memoized like `start`; a warm pool calls this right
   * after spawning so a later `bindAndStart` only pays session setup.
   */
  readonly warmup: () => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * ru-code: warm-engine phase 2 — session setup (`session/load`-or-`new`)
   * with the taken thread's cwd/resume cursor, awaiting a possibly-in-flight
   * warmup first. `start()` ≡ `bindAndStart(options.{cwd,resumeSessionId})`.
   */
  readonly bindAndStart: (
    params: AcpSessionBindParams,
  ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * SIGKILL the spawned ACP child process. Unmaskable by the OS — the kernel
   * reaps the process unconditionally, so this never hangs even when the agent
   * is stuck. Use only on tear-down paths where the session is being discarded.
   */
  readonly forceKill: Effect.Effect<void>;
  /**
   * ru-code (warm engine): the spawned child's OS pid — recorded into the
   * write-only pid journal so a future leftover-cleanup can reap children a
   * hard server crash orphaned.
   */
  readonly childPid: number;
  /**
   * Resolves when the spawned ACP child process has exited (for any reason).
   * Used by the adapter's child-exit watcher to detect "agent died on its own"
   * and force-complete an in-flight turn before the UI hangs. Errors swallowed.
   */
  readonly waitForExit: Effect.Effect<void>;
  /**
   * ru-code: bounded read of the child's exit status, used by the finalizer to
   * recover B1/B2 (process-exit) classification. effect-acp collapses a
   * mid-prompt child exit into a transport error at the RPC boundary, erasing
   * the exit code; this re-reads the real child status.
   *   `{ exited: true, code: N }`  — child exited with readable code N → recover B1.N
   *   `{ exited: false }`          — child still alive, OR its exit status is
   *                                  unreadable (indistinguishable from a genuine
   *                                  transport break) → keep the C4 classification
   */
  readonly readChildExit: Effect.Effect<{ readonly exited: boolean; readonly code?: number }>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

// ru-code: what a completed warmup (initialize + authenticate) yields — carried
// through Warmed/Binding so the final start result keeps the initialize response.
interface AcpWarmedState {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
}

// ru-code: warm-engine state machine. NotStarted → WarmingUp → Warmed →
// Binding → Started; failure resets WarmingUp→NotStarted and Binding→Warmed
// (both retryable, preserving the old Starting-failure reset semantics).
type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "WarmingUp";
      readonly deferred: Deferred.Deferred<AcpWarmedState, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Warmed"; readonly init: AcpWarmedState }
  | {
      readonly _tag: "Binding";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
      readonly init: AcpWarmedState;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export class QwenAcpSessionRuntime extends Context.Service<
  QwenAcpSessionRuntime,
  AcpSessionRuntimeShape
>()("t3/ru-code/qwen/acp/QwenAcpSessionRuntime") {
  static layer(
    options: AcpSessionRuntimeOptions,
  ): Layer.Layer<
    QwenAcpSessionRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    return Layer.effect(QwenAcpSessionRuntime, makeAcpSessionRuntime(options));
  }
}

const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    // True while a session/load request is in flight. Per ACP spec, the agent
    // replays prior conversation as session/update notifications during this
    // window. T3 already has its own thread history, so the replay is dropped
    // to avoid double-rendering historical messages into the live chat.
    const suppressUpdatesRef = yield* Ref.make(false);
    const crypto = yield* Crypto.Crypto;
    // Per-runtime-instance nonce. Used in assistant message item IDs so that a
    // resumed session (same acpSessionId, fresh in-memory segment counter at 0)
    // never collides with assistant message IDs persisted by the prior runtime.
    const runtimeInstanceId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8);

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    // ru-code: ACP session is the long-running chat-driving spawn. The command
    // is already `node <cliJs> --acp` (built by buildCliSpawn), so we spawn it
    // directly with shell:false — no bash/cmd/PowerShell, no PATH lookup.
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.spawn.command, [...options.spawn.args], {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: { ...process.env, ...options.spawn.env } } : {}),
          shell: false,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    yield* acp.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const suppress = yield* Ref.get(suppressUpdatesRef);
        if (suppress) return;
        yield* handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          toolCallsRef,
          assistantSegmentRef,
          params: notification,
          runtimeInstanceId,
        });
      }),
    );

    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: "ACP session runtime has not been started",
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    // ru-code: phase 1 of the old startOnce — initialize + authenticate. No
    // session exists yet; the process is project/cwd-agnostic at this point.
    const warmupOnce = Effect.gen(function* () {
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );

      const authenticatePayload = {
        methodId: options.authMethodId,
      } satisfies EffectAcpSchema.AuthenticateRequest;

      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        acp.agent.authenticate(authenticatePayload),
      );

      return { initializeResult } satisfies AcpWarmedState;
    });

    // ru-code: phase 2 — session setup (session/load-or-new) with the bind
    // params' cwd/resume cursor. Body unchanged from the old startOnce apart
    // from `options.*` → `params.*`.
    const bindOnce = (init: AcpWarmedState, params: AcpSessionBindParams) =>
      Effect.gen(function* () {
        let sessionId: string;
        let sessionSetupResult:
          | EffectAcpSchema.LoadSessionResponse
          | EffectAcpSchema.NewSessionResponse
          | EffectAcpSchema.ResumeSessionResponse;
        if (params.resumeSessionId) {
          const loadPayload = {
            sessionId: params.resumeSessionId,
            cwd: params.cwd,
            // ru-code: MCP servers come from the settings overlay
            // (QWEN_CODE_SYSTEM_SETTINGS_PATH), not this ACP array.
            mcpServers: [],
          } satisfies EffectAcpSchema.LoadSessionRequest;
          yield* Ref.set(suppressUpdatesRef, true);
          const resumed = yield* runLoggedRequest(
            "session/load",
            loadPayload,
            acp.agent.loadSession(loadPayload),
          ).pipe(Effect.exit, Effect.ensuring(Ref.set(suppressUpdatesRef, false)));
          if (Exit.isSuccess(resumed)) {
            sessionId = params.resumeSessionId;
            sessionSetupResult = resumed.value;
          } else {
            const createPayload = {
              cwd: params.cwd,
              mcpServers: [],
            } satisfies EffectAcpSchema.NewSessionRequest;
            const created = yield* runLoggedRequest(
              "session/new",
              createPayload,
              acp.agent.createSession(createPayload),
            );
            sessionId = created.sessionId;
            sessionSetupResult = created;
          }
        } else {
          const createPayload = {
            cwd: params.cwd,
            mcpServers: [],
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
        }

        yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
        yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

        const nextState = {
          sessionId,
          initializeResult: init.initializeResult,
          sessionSetupResult,
          modelConfigId: extractModelConfigId(sessionSetupResult),
        } satisfies AcpStartedState;
        return nextState;
      });

    // ru-code: memoized warmup — same single-flight/reset discipline the old
    // `start` had, applied to the initialize+authenticate half only.
    const warmupInternal: Effect.Effect<AcpWarmedState, EffectAcpErrors.AcpError> = Effect.gen(
      function* () {
        const deferred = yield* Deferred.make<AcpWarmedState, EffectAcpErrors.AcpError>();
        const effect = yield* Ref.modify(startStateRef, (state) => {
          switch (state._tag) {
            case "Started":
              return [
                Effect.succeed({
                  initializeResult: state.result.initializeResult,
                } satisfies AcpWarmedState),
                state,
              ] as const;
            case "Binding":
            case "Warmed":
              return [Effect.succeed(state.init), state] as const;
            case "WarmingUp":
              return [Deferred.await(state.deferred), state] as const;
            case "NotStarted":
              return [
                warmupOnce.pipe(
                  Effect.tap((init) =>
                    Ref.set(startStateRef, { _tag: "Warmed", init }).pipe(
                      Effect.andThen(Deferred.succeed(deferred, init)),
                    ),
                  ),
                  Effect.onError((cause) =>
                    Deferred.failCause(deferred, cause).pipe(
                      Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                    ),
                  ),
                ),
                { _tag: "WarmingUp", deferred } satisfies AcpStartState,
              ] as const;
          }
        });
        return yield* effect;
      },
    );

    // ru-code: memoized bind — awaits warmup, then single-flights session setup.
    // A bind failure resets to Warmed (the process stays usable), mirroring the
    // old Starting→NotStarted retryability.
    const bindInternal = (
      params: AcpSessionBindParams,
    ): Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        yield* warmupInternal;
        const deferred = yield* Deferred.make<
          AcpSessionRuntimeStartResult,
          EffectAcpErrors.AcpError
        >();
        const effect = yield* Ref.modify(startStateRef, (state) => {
          switch (state._tag) {
            case "Started":
              return [Effect.succeed(state.result), state] as const;
            case "Binding":
              return [Deferred.await(state.deferred), state] as const;
            case "Warmed":
              return [
                bindOnce(state.init, params).pipe(
                  Effect.tap((result) =>
                    Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                      Effect.andThen(Deferred.succeed(deferred, result)),
                    ),
                  ),
                  Effect.onError((cause) =>
                    Deferred.failCause(deferred, cause).pipe(
                      Effect.andThen(Ref.set(startStateRef, { _tag: "Warmed", init: state.init })),
                    ),
                  ),
                ),
                { _tag: "Binding", deferred, init: state.init } satisfies AcpStartState,
              ] as const;
            // Unreachable after a successful warmup (nothing resets Warmed
            // backwards); defensively re-run the whole sequence.
            case "NotStarted":
            case "WarmingUp":
              return [Effect.suspend(() => bindInternal(params)), state] as const;
          }
        });
        return yield* effect;
      });

    const start = bindInternal({
      cwd: options.cwd,
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
    });

    return {
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      start: () => start,
      warmup: () => Effect.asVoid(warmupInternal),
      bindAndStart: (params) => bindInternal(params),
      getEvents: () => Stream.fromQueue(eventQueue),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      prompt: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest;
            return closeActiveAssistantSegment({
              queue: eventQueue,
              assistantSegmentRef,
            }).pipe(
              Effect.andThen(
                runLoggedRequest(
                  "session/prompt",
                  requestPayload,
                  acp.agent.prompt(requestPayload),
                ),
              ),
              Effect.tap(() =>
                closeActiveAssistantSegment({
                  queue: eventQueue,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) => acp.agent.cancel({ sessionId: started.sessionId })),
      ),
      forceKill: Effect.ignore(child.kill({ killSignal: "SIGKILL" })),
      childPid: Number(child.pid), // ru-code: warm engine — pid journal source
      waitForExit: Effect.ignore(child.exitCode),
      // ru-code: bounded so a genuine transport break with the child still alive
      // (exitCode never resolves) falls back to `{ exited: false }` instead of
      // hanging the finalizer. When the child DID exit mid-prompt, exitCode
      // resolves near-instantly, so the common B1 path pays no real latency.
      readChildExit: child.exitCode.pipe(
        Effect.map((code): { readonly exited: boolean; readonly code?: number } => ({
          exited: true,
          code: code as number,
        })),
        // exitCode read FAILED (couldn't read status). This is indistinguishable
        // from a genuine transport break with the child still alive (C4) — both
        // yield an unreadable exit status — so we do NOT claim the child exited;
        // the finalizer keeps the C4 transport classification.
        Effect.orElseSucceed((): { readonly exited: boolean; readonly code?: number } => ({
          exited: false,
        })),
        Effect.timeoutOption(CHILD_EXIT_READ_TIMEOUT_MS),
        Effect.map(Option.getOrElse(() => ({ exited: false }))),
      ),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }
            return setConfigOption("mode", modeId).pipe(
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
          Effect.asVoid,
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntimeShape;
  });

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  params,
  runtimeInstanceId,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly params: EffectAcpSchema.SessionNotification;
  readonly runtimeInstanceId: string;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          queue,
          assistantSegmentRef,
        });
        const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
          continue;
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          runtimeInstanceId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous === undefined || previous.title !== next.title || previous.detail !== next.detail;
}

const assistantItemId = (sessionId: string, runtimeInstanceId: string, segmentIndex: number) =>
  `assistant:${sessionId}:r${runtimeInstanceId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
  runtimeInstanceId,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, runtimeInstanceId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
