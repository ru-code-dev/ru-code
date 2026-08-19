// ru-code: coverage of the `CliErrorDecision` dispatcher (`dispatch.ts`). We
// build a fake `CliErrorDispatchEnv` whose four capabilities (killAcp /
// appendActivity / setLastError / endTurn) push a labelled string into a shared
// `calls` array, so each assertion pins BOTH which capabilities fired AND their
// order. Every surface of the routing table is exercised against the real
// exported `dispatch`: silent (no surface), T, T+N, the B-surface safety-net
// (a B decision reaching a non-prompt catch site), plus the `killAcp`/`endTurn`
// flag interactions. The shared `[runtime]` breadcrumb is captured with a
// replacement `Logger` and its `code`/`surface`/`info` fields are asserted.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { AcpRequestError } from "effect-acp/errors";

import {
  cliErrorFields,
  dispatch,
  dispatchCause,
  type CliErrorDispatchEnv,
} from "@ru-code/qwen/errors/dispatch";
import { Surface, type CliErrorDecision } from "@ru-code/qwen/errors/types";

interface FakeEnv {
  readonly env: CliErrorDispatchEnv<never>;
  readonly calls: string[];
}

const makeEnv = (options: { readonly withKill: boolean }): FakeEnv => {
  const calls: string[] = [];
  const env: CliErrorDispatchEnv<never> = {
    killAcp: options.withKill
      ? Effect.sync(() => {
          calls.push("killAcp");
        })
      : undefined,
    appendActivity: (detail) =>
      Effect.sync(() => {
        calls.push(`appendActivity:${detail}`);
      }),
    setLastError: (detail) =>
      Effect.sync(() => {
        calls.push(`setLastError:${detail}`);
      }),
    endTurn: Effect.sync(() => {
      calls.push("endTurn");
    }),
  };
  return { env, calls };
};

/** Run a dispatch and return the captured log messages (breadcrumb + any loud logs). */
const runDispatch = (
  effect: Effect.Effect<void, never, never>,
): Effect.Effect<ReadonlyArray<unknown>> =>
  Effect.gen(function* () {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    yield* effect.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    return logs;
  });

/** Locate the fixed `[runtime]` breadcrumb payload among captured messages. */
const runtimeBreadcrumb = (logs: ReadonlyArray<unknown>): Record<string, unknown> => {
  const entry = logs.find(
    (message): message is [string, Record<string, unknown>] =>
      Array.isArray(message) && message[0] === "[runtime]",
  );
  expect(entry).toBeDefined();
  return entry![1];
};

describe("cliErrorFields — shared breadcrumb fields", () => {
  it("silent decision (no surface) → surface defaults to 'silent'", () => {
    const decision: CliErrorDecision = { id: "silent-x", killAcp: true };
    const info = { cause: "boom" };
    expect(cliErrorFields(decision, info)).toEqual({
      code: "silent-x",
      surface: "silent",
      info,
    });
  });

  it("surfaced decision → surface + code passed through verbatim", () => {
    const decision: CliErrorDecision = {
      id: "A5",
      surface: [Surface.Timeline, Surface.Notification],
      text: "auth",
    };
    expect(cliErrorFields(decision, { code: -32000 })).toEqual({
      code: "A5",
      surface: "Timeline+Notification",
      info: { code: -32000 },
    });
  });
});

describe("dispatch — [runtime] breadcrumb", () => {
  it.effect("always emits one [runtime] breadcrumb carrying code/surface/failureFields", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = {
        id: "A6",
        surface: [Surface.Timeline],
        text: "not found",
      };
      const failureFields = { code: -32002, message: "missing" };
      const { env } = makeEnv({ withKill: false });

      const breadcrumb = runtimeBreadcrumb(
        yield* runDispatch(dispatch(decision, failureFields, env)),
      );
      expect(breadcrumb).toEqual({
        source: "cli",
        where: "pre-turn",
        code: "A6",
        surface: "Timeline",
        info: failureFields,
      });
    }),
  );
});

describe("dispatch — silent surface (no UI dispatch)", () => {
  it.effect("endTurn=true → only endTurn fires (no activity, no lastError)", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = { id: "silent-1", endTurn: true };
      const { env, calls } = makeEnv({ withKill: false });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).toEqual(["endTurn"]);
    }),
  );

  it.effect("endTurn omitted → no env capability fires at all", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = { id: "silent-2" };
      const { env, calls } = makeEnv({ withKill: false });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).toEqual([]);
    }),
  );
});

describe("dispatch — killAcp side effect", () => {
  it.effect("killAcp=true with a kill capability → killAcp runs BEFORE endTurn", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = { id: "E", killAcp: true, endTurn: true };
      const { env, calls } = makeEnv({ withKill: true });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).toEqual(["killAcp", "endTurn"]);
    }),
  );

  it.effect("killAcp=true but env.killAcp undefined → skipped silently, no crash", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = { id: "E", killAcp: true, endTurn: true };
      const { env, calls } = makeEnv({ withKill: false });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).toEqual(["endTurn"]);
    }),
  );

  it.effect("killAcp not set → kill capability is never invoked even when present", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = {
        id: "A4",
        surface: [Surface.Timeline],
        text: "protocol",
        endTurn: true,
      };
      const { env, calls } = makeEnv({ withKill: true });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).not.toContain("killAcp");
      expect(calls).toEqual(["appendActivity:protocol", "endTurn"]);
    }),
  );
});

describe("dispatch — T surface", () => {
  it.effect("endTurn=true → appendActivity(text) then endTurn", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = {
        id: "A4",
        surface: [Surface.Timeline],
        text: "protocol error",
        endTurn: true,
      };
      const { env, calls } = makeEnv({ withKill: false });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).toEqual(["appendActivity:protocol error", "endTurn"]);
    }),
  );

  it.effect("endTurn omitted → only appendActivity, turn left running", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = {
        id: "T-live",
        surface: [Surface.Timeline],
        text: "keep going",
      };
      const { env, calls } = makeEnv({ withKill: false });
      yield* runDispatch(dispatch(decision, {}, env));
      expect(calls).toEqual(["appendActivity:keep going"]);
    }),
  );
});

describe("dispatch — T+N surface", () => {
  it.effect(
    "setLastError(text) then appendActivity(text); endTurn NOT called (implicit via lastError)",
    () =>
      Effect.gen(function* () {
        const decision: CliErrorDecision = {
          id: "A5",
          surface: [Surface.Timeline, Surface.Notification],
          text: "auth required",
        };
        const { env, calls } = makeEnv({ withKill: false });
        yield* runDispatch(dispatch(decision, {}, env));
        expect(calls).toEqual(["setLastError:auth required", "appendActivity:auth required"]);
        expect(calls).not.toContain("endTurn");
      }),
  );
});

describe("dispatch — Bubble surface at a non-prompt catch site (safety net)", () => {
  it.effect("logs a loud fallback breadcrumb and surfaces the text on the timeline", () =>
    Effect.gen(function* () {
      const decision: CliErrorDecision = {
        id: "A1",
        surface: [Surface.Bubble],
        text: "empty response",
      };
      const { env, calls } = makeEnv({ withKill: false });
      const logs = yield* runDispatch(dispatch(decision, {}, env));

      // A bubble can't be emitted outside the prompt scope, so the text falls
      // back to the timeline only (no banner).
      expect(calls).toEqual(["appendActivity:empty response"]);

      // A second, loud log names the misconfiguration.
      const loud = logs.find(
        (message): message is [string, Record<string, unknown>] =>
          Array.isArray(message) &&
          typeof message[0] === "string" &&
          message[0].includes("b-surface-outside-prompt"),
      );
      expect(loud).toBeDefined();
      expect(loud![0]).toBe("[cli-error.A1.b-surface-outside-prompt]");
      expect(loud![1]).toHaveProperty("hint");
    }),
  );
});

describe("dispatchCause — derives failureFields from a Cause via describeRequestFailure", () => {
  it.effect(
    "AcpRequestError cause → breadcrumb info carries code/message and routes by decision",
    () =>
      Effect.gen(function* () {
        const decision: CliErrorDecision = {
          id: "A5",
          surface: [Surface.Timeline, Surface.Notification],
          text: "auth required",
        };
        const cause = Cause.fail(
          new AcpRequestError({
            code: -32000 as never,
            errorMessage: "authentication required",
            data: { details: "please re-auth" },
          }),
        );
        const { env, calls } = makeEnv({ withKill: false });
        const breadcrumb = runtimeBreadcrumb(
          yield* runDispatch(dispatchCause(decision, cause, env)),
        );

        // Routing is unchanged from `dispatch`.
        expect(calls).toEqual(["setLastError:auth required", "appendActivity:auth required"]);
        // Fields were computed by describeRequestFailure, not passed in.
        expect(breadcrumb.info).toEqual({
          code: -32000,
          message: "authentication required",
          details: "please re-auth",
        });
      }),
  );
});
