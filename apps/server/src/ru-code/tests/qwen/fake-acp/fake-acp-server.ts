// ru-code: stdio shell for the fake ACP agent — LIVE manual mode.
//
// A standalone Node entry that speaks the real ndJSON-RPC ACP wire over actual
// stdin/stdout, so the REAL app can be driven against a scripted wire failure for
// manual UI checks. It shares `fakeAcpCore` with the unit tests, so "passes in CI"
// and "looks right when driven live" exercise the SAME agent behaviour — the only
// difference is real pipes instead of in-memory queues.
//
// Wire it in via the dev-only override (no production code change), on the DEFAULT
// (custom-profile) provider instance so the env override reaches the spawn:
//   RU_CODE_CLI_JS=<abs path to THIS file> RU_CODE_FAKE_ACP=C4 <start the app>
// Then send a turn and watch the real timeline + notification banner + bubble.
// Change RU_CODE_FAKE_ACP to another id below to reproduce a different error.
// No build step: our spawn treats a `.ts` bin as `node --experimental-strip-types
// <file>`, exactly how the server itself runs `node src/bin.ts`.
//
// NOTE on transport vs process-exit: a true "broken pipe, child still alive" (C4)
// isn't cheaply reproducible over a real OS pipe without hanging on the child's
// exitCode, so over stdio `closeTransport` exits the process — visually identical
// (T+N banner + persisting row + stopped timer). The exact C4 transport
// CLASSIFICATION is pinned by the in-memory unit tests. Likewise B2 (exit with no
// readable code) and the D-bucket (provider-adapter errors) are not wire-inducible
// from a running agent — they are covered by the in-memory + classifier tests.
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { type FakeAcpScript, runFakeAcpAgent } from "./fakeAcpCore.ts";

// CRITICAL: stdout is the ACP wire (ndJSON-RPC) — ANYTHING non-protocol on it
// corrupts the stream and the client fails to parse the handshake. Effect's
// default logger writes via `console.log` (→ stdout), so route the whole console
// to stderr. The protocol writer below uses `process.stdout.write` directly, so it
// is unaffected; only stray logs are redirected.
const toStderr =
  (prefix: string) =>
  (...args: ReadonlyArray<unknown>) =>
    process.stderr.write(`${prefix}${args.map((value) => String(value)).join(" ")}\n`);
console.log = toStderr("");
console.info = toStderr("");
console.debug = toStderr("");
console.warn = toStderr("");

// One script per error id (mirrors the error truth table). Default = a clean turn.
const SCENARIOS: Record<string, FakeAcpScript> = {
  // Mid-turn transport / process death → T+N (banner + row), timer stops.
  C4: { onPrompt: (steps) => steps.emitText("частичный ответ…").closeTransport() },
  C1: { onPrompt: (steps) => steps.emitText("привет").writeRaw("}{ not json\n") },
  B1: { onPrompt: (steps) => steps.emitText("частичный ответ…").exit(1) },
  // RPC errors while the agent stays alive.
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
  A3: {
    onPrompt: (steps) => steps.respondError(-32603, "internal", { details: "Model unloaded." }),
  },
  A7: {
    onPrompt: (steps) =>
      steps.respondError(-32603, "internal", { details: "Slash command not supported in ACP" }),
  },
  // Unrecognized clean request error → Z (T+N, detail verbatim).
  Z: { onPrompt: (steps) => steps.respondError(-32050, "Какая-то понятная ошибка из движка") },
  // Start handshake fails / hangs (drive the boot-time error / timeout paths).
  START_ERROR: { onPrompt: (steps) => steps.respondOk(), startBehavior: "error" },
  START_HANG: { onPrompt: (steps) => steps.respondOk(), startBehavior: "hang" },
  // Stop demo: a long-running turn the user can interrupt from the UI.
  HOLD: { onPrompt: (steps) => steps.emitText("работаю, нажмите Стоп…") },
  OK: { onPrompt: (steps) => steps.emitText("Готово.").respondOk("end_turn") },
};

const scenarioId = process.env["RU_CODE_FAKE_ACP"] ?? "OK";
const script = SCENARIOS[scenarioId] ?? SCENARIOS["OK"]!;

// Bridge Node process.stdin → an Effect queue the agent reads. This wiring lives at
// MODULE scope (the Node event-loop ↔ Effect boundary), so `Effect.runSync` here is
// a legitimate top-level run, not a nested one inside a surrounding Effect.
const stdinQueue = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done<void>>());
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

const program = Effect.scoped(
  Effect.gen(function* () {
    process.stderr.write(`[fake-acp-server] serving scenario ${scenarioId}\n`);
    yield* runFakeAcpAgent(stdio, script, controls);
    return yield* Effect.never; // keep serving until the parent kills us
  }),
);

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`[fake-acp-server] fatal: ${String(error)}\n`);
  process.exit(1);
});
