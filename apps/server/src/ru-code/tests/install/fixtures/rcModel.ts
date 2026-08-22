// ru-code: an independent TypeScript model of `rc_render` — the second implementation the bash one is
// checked against (model-based testing). It is deliberately NOT a port of the bash code but a direct
// transcription of the CONTRACT stated at the top of ru-code/installer/parts/25-rc-path.sh:
//
//   rc_render(content, wantLine) =
//       drop our export spans, character-exactly; when a line vanishes entirely, also drop the ONE
//       blank separator line we ourselves wrote in front of it
//     + terminate the last line (a text file ends with a newline)
//     + append (blank separator, unless the file is empty) + our line   [only when wantLine]
//
// Two implementations agreeing on ~60 corpus shapes is far stronger evidence than either agreeing with
// hand-written expectations, and it is what lets the suite assert byte-exact output rather than
// "contains" checks.

const OPEN = 'export PATH="';
const CLOSE = ':$PATH"';

/**
 * Mirrors the bash parameter expansions exactly: `${v%%"$open"*}` is the text before the FIRST
 * occurrence, `${v#*"$open"}` the text after it — i.e. indexOf semantics, not lastIndexOf.
 */
export function stripOurSpan(line: string, appDir: string): string {
  const needle = `/${appDir}/bin`;
  let rest = line;
  let out = "";
  for (;;) {
    const open = rest.indexOf(OPEN);
    if (open < 0) break;
    const head = rest.slice(0, open);
    const after = rest.slice(open + OPEN.length);
    const close = after.indexOf(CLOSE);
    if (close < 0) break; // unterminated — not our shape
    const inner = after.slice(0, close);
    out += inner.includes(needle) ? head : head + OPEN + inner + CLOSE;
    rest = after.slice(close + CLOSE.length);
  }
  return out + rest;
}

const SRC_OPEN = '[ -f "';
const SRC_MID = '" ] && . "';
const SRC_CLOSE = '"';

/**
 * The SOURCED-generation span (`rc_strip_source_span`): `[ -f "<path>" ] && . "<path>"` with both
 * paths byte-identical and carrying the marker. Mirrors the bash scan exactly, including the
 * rescan-from-after-the-open on a non-ours occurrence.
 */
export function stripSourceSpan(line: string, appDir: string): string {
  const needle = `/${appDir}/bin`;
  let rest = line;
  let out = "";
  for (;;) {
    const open = rest.indexOf(SRC_OPEN);
    if (open < 0) break;
    const head = rest.slice(0, open);
    const after = rest.slice(open + SRC_OPEN.length);
    const mid = after.indexOf(SRC_MID);
    if (mid < 0) break; // no middle token — not our shape
    const guardedPath = after.slice(0, mid);
    const midAfter = after.slice(mid + SRC_MID.length);
    const close = midAfter.indexOf(SRC_CLOSE);
    if (close < 0) break; // unterminated — not our shape
    const sourcedPath = midAfter.slice(0, close);
    if (guardedPath === sourcedPath && guardedPath.includes(needle)) {
      out += head;
      rest = midAfter.slice(close + SRC_CLOSE.length);
      continue;
    }
    out += head + SRC_OPEN;
    rest = after;
  }
  return out + rest;
}

const isBlank = (value: string): boolean => value.trim() === "";

const hasMarker = (value: string, appDir: string, appBin: string): boolean =>
  value.includes(`/${appDir}/bin`) || value.includes(`# ${appBin} v`);

/**
 * Bash's read loop: split on "\n" and drop ONE trailing empty element, so a file that ends with a
 * newline yields no phantom last line while a file that does NOT end with one still yields its final
 * line (`|| [ -n "$line" ]`).
 */
function readLines(content: string): ReadonlyArray<string> {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface RenderOptions {
  readonly pathLine: string;
  readonly appDir?: string;
  readonly appBin?: string;
}

/** The rendered bytes for `content`. `wantLine` false = the uninstall form. */
export function render(content: string, wantLine: boolean, options: RenderOptions): string {
  const appDir = options.appDir ?? ".ru-code";
  const appBin = options.appBin ?? "ru-code";

  let out = "";
  let pending: string | null = null;

  for (const line of readLines(content)) {
    let dropped = false;
    let emit = line;
    if (hasMarker(line, appDir, appBin)) {
      // BOTH generations are excised, always — mirrors rc_render's switch-blind scrub.
      const stripped = stripSourceSpan(stripOurSpan(line, appDir), appDir);
      if (stripped === line) {
        dropped = true; // marker we cannot parse → historic whole-line delete
      } else if (isBlank(stripped)) {
        dropped = true; // the line was wholly ours
      } else {
        emit = stripped; // ours was glued onto content we must keep
      }
    }
    if (dropped) {
      // Retract our own separator, and only ours: the uncommitted line directly above.
      if (pending !== null && isBlank(pending)) pending = null;
      continue;
    }
    if (pending !== null) out += `${pending}\n`;
    pending = emit;
  }
  if (pending !== null) out += `${pending}\n`;

  if (wantLine) {
    out = out === "" ? `${options.pathLine}\n` : `${out}\n${options.pathLine}\n`;
  }
  return out;
}

/**
 * The round-trip target: install-then-uninstall returns the user's original bytes, modulo the single
 * final newline a text file should have ended with. That newline is added by the renderer's
 * line-termination step and is the only byte the user can ever "gain".
 */
export function ensureFinalNewline(content: string): string {
  if (content === "") return "";
  return content.endsWith("\n") ? content : `${content}\n`;
}
