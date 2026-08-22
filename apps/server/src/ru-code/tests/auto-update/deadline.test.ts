// ru-code: the deadline that backs "the UI cannot show work that is not happening".
//
// This is the ONLY place it can be proven. In the engine the deadline is a BACKSTOP: while every
// inner step carries its own budget (the web GET, the git probe, the download) one of those always
// fires first, so the outer deadline correctly never fires and a test through the engine would only
// ever observe the inner timeout. Its whole reason to exist is the step that has NO budget —
// `extractTarball` spawns `tar` with none — and code added later that forgets one.
//
// So the guarantee is tested against an effect that genuinely never completes.

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { withDeadline } from "../../auto-update/engine/deadline.ts";

const DEADLINE_MS = 60_000;

it.effect("a work that never completes is ended, and the state is settled", () =>
  Effect.gen(function* () {
    const settled = yield* Ref.make(0);
    const bounded = withDeadline({
      // Nothing ever completes this — the shape of a wedged `tar`.
      work: Effect.never,
      durationMs: DEADLINE_MS,
      label: "test work",
      onTimeout: Effect.succeed("timed out"),
      settle: Ref.update(settled, (n) => n + 1),
    });

    const fiber = yield* Effect.forkChild(bounded);
    yield* TestClock.adjust(Duration.millis(DEADLINE_MS - 1));
    assert.strictEqual(yield* Ref.get(settled), 0, "must not fire early");

    yield* TestClock.adjust(Duration.millis(1));
    assert.strictEqual(yield* Fiber.join(fiber), "timed out");
    assert.strictEqual(yield* Ref.get(settled), 1);
  }),
);

it.effect("work that finishes in time keeps its own answer, and still settles once", () =>
  Effect.gen(function* () {
    const settled = yield* Ref.make(0);

    const answer = yield* withDeadline({
      work: Effect.succeed("real answer"),
      durationMs: DEADLINE_MS,
      label: "test work",
      onTimeout: Effect.succeed("timed out"),
      settle: Ref.update(settled, (n) => n + 1),
    });

    assert.strictEqual(answer, "real answer");
    assert.strictEqual(yield* Ref.get(settled), 1);
  }),
);

// The three exits that are NOT "it finished". Each one is a way a run could end without a verdict,
// and each one has to reach the finalizer — that is the whole guarantee.
it.effect("a typed failure still settles, and the failure still propagates", () =>
  Effect.gen(function* () {
    const settled = yield* Ref.make(0);

    const exit = yield* Effect.exit(
      withDeadline({
        work: Effect.fail("boom" as const),
        durationMs: DEADLINE_MS,
        label: "test work",
        onTimeout: Effect.succeed("timed out"),
        settle: Ref.update(settled, (n) => n + 1),
      }),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.strictEqual(yield* Ref.get(settled), 1);
  }),
);

it.effect("a DEFECT still settles", () =>
  Effect.gen(function* () {
    const settled = yield* Ref.make(0);

    const exit = yield* Effect.exit(
      withDeadline({
        work: Effect.sync(() => {
          throw new Error("defect");
        }),
        durationMs: DEADLINE_MS,
        label: "test work",
        onTimeout: Effect.succeed("timed out"),
        settle: Ref.update(settled, (n) => n + 1),
      }),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.strictEqual(yield* Ref.get(settled), 1);
  }),
);

it.effect("an INTERRUPT still settles — the case a dead client produces", () =>
  Effect.gen(function* () {
    const settled = yield* Ref.make(0);
    const running = yield* Deferred.make<void>();

    const fiber = yield* Effect.forkChild(
      withDeadline({
        work: Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)),
        durationMs: DEADLINE_MS,
        label: "test work",
        onTimeout: Effect.void,
        settle: Ref.update(settled, (n) => n + 1),
      }),
    );

    // Interrupt only once the work is genuinely under way, not before it started.
    yield* Deferred.await(running);
    yield* Fiber.interrupt(fiber);

    assert.strictEqual(yield* Ref.get(settled), 1);
  }),
);
