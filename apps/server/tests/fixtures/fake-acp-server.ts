// ru-fork: stdio shell for the fake ACP agent — LIVE manual mode (§9.5).
//
// A standalone Node entry that speaks the real ndJSON-RPC ACP wire over actual
// stdin/stdout, so the REAL app can be driven against a scripted wire failure
// for manual UI checks. It shares `fakeAcpCore` with the unit tests, so "passes
// in CI" and "looks right when driven live" exercise the SAME agent behaviour —
// the only difference is real pipes instead of in-memory queues.
//
// Wire it in via the dev-only override (no production code change):
//   RU_FORK_CLI_JS=<abs path to this file> RU_FORK_FAKE_ACP=C4 <start the app>
// Then send a turn and watch the real timeline + notification + bubble timer.
// Change RU_FORK_FAKE_ACP to another id below to reproduce a different error.
//
// NOTE on transport vs process-exit: a true "broken pipe, child still alive"
// (C4) isn't cheaply reproducible over a real OS pipe without hanging on the
// child's exitCode, so over stdio `closeTransport` exits the process — visually
// identical (T+N banner + persisting row + stopped timer). The exact C4
// transport CLASSIFICATION is pinned by the in-memory unit tests.
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { type FakeAcpScript, runFakeAcpAgent } from "../provider/fakeAcpCore.ts";

// CRITICAL: stdout is the ACP wire (ndJSON-RPC) — ANYTHING non-protocol on it
// corrupts the stream and the client fails to parse the handshake. Effect's
// default logger writes via `console.log` (→ stdout), so route the whole console
// to stderr. The protocol writer below uses `process.stdout.write` directly, so
// it is unaffected; only stray logs are redirected.
const toStderr =
  (prefix: string) =>
  (...args: ReadonlyArray<unknown>) =>
    process.stderr.write(`${prefix}${args.map((value) => String(value)).join(" ")}\n`);
console.log = toStderr("");
console.info = toStderr("");
console.debug = toStderr("");
console.warn = toStderr("");

// One script per error id (mirrors the §E matrix). Default = a clean turn.
const SCENARIOS: Record<string, FakeAcpScript> = {
  // Mid-turn transport / process death → T+N (banner + row), timer stops.
  C4: { onPrompt: (steps) => steps.emitText("частичный ответ…").closeTransport() },
  B1: { onPrompt: (steps) => steps.emitText("частичный ответ…").exit(1) },
  C1: { onPrompt: (steps) => steps.emitText("привет").writeRaw("}{ not json\n") },
  // RPC errors (qwen stays alive).
  A5: { onPrompt: (steps) => steps.respondError(-32000, "auth required") }, // T+N
  A4: { onPrompt: (steps) => steps.respondError(-32601, "method not found") }, // T
  A6: { onPrompt: (steps) => steps.respondError(-32002, "resource not found") }, // T
  // B-surface: friendly bubble, turn completes, no banner.
  A1: {
    onPrompt: (steps) =>
      steps.respondError(-32603, "internal", {
        details: "Model stream ended with empty response text",
      }),
  },
  A2: { onPrompt: (steps) => steps.respondError(429, "rate limit") },
  A3: { onPrompt: (steps) => steps.respondError(-32603, "internal", { details: "Model unloaded." }) },
  A7: {
    onPrompt: (steps) =>
      steps.respondError(-32603, "internal", { details: "Slash command not supported in ACP" }),
  },
  // Unrecognized clean request error → Z (T+N, detail verbatim).
  Z: { onPrompt: (steps) => steps.respondError(-32050, "Какая-то понятная ошибка из движка") },
  // Stop demo: a long-running turn the user can interrupt from the UI.
  HOLD: { onPrompt: (steps) => steps.emitText("работаю, нажмите Стоп…") },
  OK: { onPrompt: (steps) => steps.emitText("Готово.").respondOk("end_turn") },
};

const scenarioId = process.env["RU_FORK_FAKE_ACP"] ?? "OK";
const script = SCENARIOS[scenarioId] ?? SCENARIOS["OK"]!;

const program = Effect.scoped(
  Effect.gen(function* () {
    const stdinQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();

    // Bridge Node process.stdin → the queue the agent reads.
    process.stdin.on("data", (chunk: Buffer) => {
      Effect.runSync(Queue.offer(stdinQueue, new Uint8Array(chunk)).pipe(Effect.asVoid));
    });
    process.stdin.on("end", () => {
      Effect.runSync(Queue.end(stdinQueue).pipe(Effect.asVoid));
    });

    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(stdinQueue),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            process.stdout.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
          }),
        ),
      stderr: () => Sink.drain,
    });

    const controls = {
      writeRaw: (bytes: string) =>
        Effect.sync(() => {
          process.stdout.write(bytes);
        }),
      // Over a real pipe we exit the process (see header note).
      closeTransport: Effect.sync(() => process.exit(1)),
      exit: (code: number) => Effect.sync(() => process.exit(code)),
    };

    yield* Effect.logInfo(`[fake-acp-server] serving scenario ${scenarioId}`).pipe(Effect.ignore);
    yield* runFakeAcpAgent(stdio, script, controls);
    yield* Effect.never; // keep serving until the parent kills us
  }),
);

Effect.runPromise(program).catch((error) => {
  process.stderr.write(`[fake-acp-server] fatal: ${String(error)}\n`);
  process.exit(1);
});
