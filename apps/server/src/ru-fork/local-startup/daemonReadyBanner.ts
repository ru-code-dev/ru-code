import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { ARROW_DIM, ARROW_OK, isTty, paint } from "./cliPaint.ts";

// ru-fork: daemon-launcher "ready" banner. Same bordered-box treatment
// as foregroundLaunchBanner so the two CLI surfaces feel like one product.
//
// Visual shape (TTY only):
//
//   ┌────────────────────────────────────────────────────┐
//   │ ▸ ru-fork готов                                │
//   │ Адрес: http://localhost:7777                       │
//   │ Открыть: http://localhost:7777/?pair=xyz           │   ← only if web-mode target differs
//   │ ▸ Сервер работает в фоне — терминал можно закрыть. │
//   │   Остановить: ru-fork stop                     │
//   └────────────────────────────────────────────────────┘
//
// Non-TTY fallback (daemon log capture, piped stdout, IDE terminals): plain
// `Console.log` lines without box-drawing chars or ANSI escapes. Daemon-mode
// stdout is `process.stdout` of the LAUNCHER process (a TTY when the user
// invoked `ru-fork` from a terminal), not the spawned child — so this
// banner does typically render styled. The non-TTY fallback covers the
// piped/captured-output case.
export const printDaemonReadyBanner = (input: {
  readonly origin: string;
  readonly browserTarget: string;
  readonly alreadyRunning: boolean;
}) =>
  Effect.gen(function* () {
    const headlineText = input.alreadyRunning ? "ru-fork уже запущен" : "ru-fork готов";
    const showSecondUrl = input.browserTarget !== input.origin;

    if (!isTty) {
      yield* Console.log("");
      yield* Console.log(`  ▸ ${headlineText}`);
      yield* Console.log(`    Адрес: ${input.origin}`);
      if (showSecondUrl) {
        yield* Console.log(`    Открыть: ${input.browserTarget}`);
      }
      yield* Console.log(`  ▸ Сервер работает в фоне — терминал можно закрыть.`);
      yield* Console.log(`    Остановить: ru-fork stop`);
      yield* Console.log("");
      return;
    }

    type Row = { readonly plain: string; readonly styled: string };
    const rows: Row[] = [
      {
        plain: `▸ ${headlineText}`,
        styled: `${ARROW_OK} ${paint.bold(headlineText)}`,
      },
      {
        plain: `Адрес: ${input.origin}`,
        styled: `${paint.dim("Адрес:")} ${paint.bold(paint.cyan(input.origin))}`,
      },
    ];
    if (showSecondUrl) {
      rows.push({
        plain: `Открыть: ${input.browserTarget}`,
        styled: `${paint.dim("Открыть:")} ${paint.bold(paint.cyan(input.browserTarget))}`,
      });
    }
    rows.push(
      {
        plain: `▸ Сервер работает в фоне — терминал можно закрыть.`,
        styled: `${ARROW_DIM} ${paint.green("Сервер работает в фоне — терминал можно закрыть.")}`,
      },
      {
        plain: `  Остановить: ru-fork stop`,
        styled: `  ${paint.dim("Остановить:")} ${paint.bold(paint.magenta("ru-fork stop"))}`,
      },
    );

    const inner = Math.max(...rows.map((r) => r.plain.length));
    const horiz = "─".repeat(inner + 2);
    const v = paint.dim("│");

    yield* Console.log("");
    yield* Console.log(`  ${paint.dim(`┌${horiz}┐`)}`);
    for (const r of rows) {
      yield* Console.log(`  ${v} ${r.styled}${" ".repeat(inner - r.plain.length)} ${v}`);
    }
    yield* Console.log(`  ${paint.dim(`└${horiz}┘`)}`);
    yield* Console.log("");
  });
