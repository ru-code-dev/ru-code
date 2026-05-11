// ru-fork: shared TTY-aware ANSI palette for ru-fork CLI surfaces.
// Extracted from daemonLauncher.ts so the foreground launch banner can
// reuse the same style without duplicating colour codes. Plain text when
// the underlying stream is not a TTY (piped output, redirected to a file,
// captured by a supervisor) — both daemon child and `> log` users see
// readable text instead of escape sequences.
const TTY = Boolean(process.stdout.isTTY);
const ESC = "\x1b[";
const RESET = TTY ? `${ESC}0m` : "";
const wrap = (codes: string) => (s: string) => (TTY ? `${ESC}${codes}m${s}${RESET}` : s);

export const paint = {
  bold: wrap("1"),
  dim: wrap("2"),
  green: wrap("32"),
  cyan: wrap("36"),
  magenta: wrap("35"),
  yellow: wrap("33"),
  red: wrap("31"),
};

export const ARROW_OK = paint.green("▸");
export const ARROW_WARN = paint.yellow("▸");
export const ARROW_DIM = paint.dim("▸");

export const isTty = TTY;
