// ru-code: TTY-aware ANSI palette for the daemon's launcher banner. ANSI escapes
// are emitted only when stdout is a real terminal; plain text otherwise (piped
// output, or the daemon child whose stdout is the log file) so logs never fill
// with escape sequences. `process.stdout` is a global — no node import needed.

import { BRAND_GRADIENT_FROM, BRAND_GRADIENT_TO } from "@ru-code/branding";

const TTY = Boolean(process.stdout.isTTY);
const ESC = "\x1b[";
const RESET = TTY ? `${ESC}0m` : "";

const wrap =
  (codes: string) =>
  (text: string): string =>
    TTY ? `${ESC}${codes}m${text}${RESET}` : text;

export const paint = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  cyan: wrap("36"),
  magenta: wrap("35"),
};

export const ARROW_OK = paint.green("▸");
export const ARROW_DIM = paint.dim("▸");
export const isTty = TTY;

/**
 * Smooth two-colour gradient across the characters (bold truecolor). A short
 * cyan→violet ramp reads as one classy sweep, not a garish full-spectrum rainbow.
 * Plain text off-TTY.
 */
export const gradient = (text: string): string => {
  if (!TTY) {
    return text;
  }
  const [fromR, fromG, fromB] = BRAND_GRADIENT_FROM; // cyan
  const [toR, toG, toB] = BRAND_GRADIENT_TO; // violet
  const chars = [...text];
  const span = Math.max(1, chars.length - 1);
  return chars
    .map((char, index) => {
      if (char === " ") {
        return char;
      }
      const t = index / span;
      const r = Math.round(fromR + (toR - fromR) * t);
      const g = Math.round(fromG + (toG - fromG) * t);
      const b = Math.round(fromB + (toB - fromB) * t);
      return `${ESC}1;38;2;${r};${g};${b}m${char}${RESET}`;
    })
    .join("");
};
