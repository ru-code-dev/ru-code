import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { ARROW_DIM, isTty, paint } from "./cliPaint.ts";

// ru-fork: prominent foreground startup banner. TTY-gated so daemon
// child (stdout → log file) and piped users don't get the box-drawing
// characters or ANSI escapes — only visible to a human at a terminal.
//
// Visual shape (TTY only):
//
//   ┌──────────────────────────────────────────────────┐
//   │ Адрес: http://127.0.0.1:7777                     │
//   │ ▸ Не закрывайте терминал. Ctrl+C — остановить.   │
//   └──────────────────────────────────────────────────┘
//
// Width is computed from the longer of the two rows' plain text so the
// box stays flush regardless of the URL length (web-mode pairing URL is
// noticeably longer than the desktop-mode bare URL).
export const printForegroundLaunchBanner = (url: string) =>
  Effect.gen(function* () {
    // Non-TTY (piped output, IDE terminal that reports isTty=false, daemon
    // child whose stdout is a log file): fall back to a plain log line so
    // the URL still reaches the output, just without the box-drawing chars
    // and ANSI escapes that would render as garbage.
    if (!isTty) {
      yield* Effect.logInfo(`Адрес: ${url}`);
      return;
    }

    const addrPlain = `Адрес: ${url}`;
    const warnPlain = "▸ Не закрывайте терминал. Ctrl+C — остановить.";
    const inner = Math.max(addrPlain.length, warnPlain.length);

    const addrStyled = `${paint.dim("Адрес:")} ${paint.bold(paint.cyan(url))}`;
    const warnStyled = `${ARROW_DIM} ${paint.bold(paint.red("Не закрывайте терминал."))} ${paint.dim("Ctrl+C — остановить.")}`;

    const horiz = "─".repeat(inner + 2);
    const v = paint.dim("│");
    const row = (plain: string, styled: string) =>
      `  ${v} ${styled}${" ".repeat(inner - plain.length)} ${v}`;

    yield* Console.log("");
    yield* Console.log(`  ${paint.dim(`┌${horiz}┐`)}`);
    yield* Console.log(row(addrPlain, addrStyled));
    yield* Console.log(row(warnPlain, warnStyled));
    yield* Console.log(`  ${paint.dim(`└${horiz}┘`)}`);
  });
