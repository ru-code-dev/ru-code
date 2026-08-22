// ru-code: the rc-file shape corpus — the shared input set for the PATH-persistence law suite
// (rcLaws.test.ts) and the differential proof against the frozen oracle (rcEquivalence.test.ts).
//
// Every shape here is a real rc-file layout the installer can meet on a user's machine, and each is
// crossed with the three line-ending forms that actually occur in the wild. The one that caused the
// field failure is `glued`: an rc file whose last line has no trailing newline, so a blind append
// concatenates our export onto it and produces config no shell can use.
//
// The corpus is data only — no assertions, no bash. Both suites import it so they can never drift
// apart on what "every case" means.

/** The bin dir every fixture line points at — matches the BIN_DIR the tests inject. */
export const BIN = "/foo/.ru-code/bin";

/** Our export, exactly as add_path composes it. */
export const OUR = `export PATH="${BIN}:$PATH"`;

/** Our export from an EARLIER install at a different location (relocated root / --install-dir). */
export const STALE = `export PATH="/other/home/.ru-code/bin:$PATH"`;

/** A PATH export that is NOT ours — must survive byte-for-byte, even sharing a line with ours. */
export const FOREIGN = `export PATH="$HOME/other/bin:$PATH"`;

/** Plain user content with no marker anywhere. */
export const USER = `alias ll='ls -la'`;
export const USER2 = `export EDITOR=vim`;

/** The legacy version marker from an older installer generation. */
export const LEGACY = `# ru-code v1`;

/** A comment that merely NAMES our bin dir — carries the marker but is not an export. */
export const COMMENT = `# see ${BIN} for details`;

/** A hand-written unquoted form: marker present, but not the span shape we parse. */
export const UNQUOTED = `export PATH=${BIN}:$PATH`;

export type Ending = "lf" | "none" | "crlf";

export interface RcShape {
  readonly id: string;
  /** Logical lines. Empty array = an empty (zero-byte) file. */
  readonly lines: ReadonlyArray<string>;
  /** True when our span is merged onto a line that also holds content we must preserve. */
  readonly glued: boolean;
  /** Content that MUST still be present after a scrub (substrings, checked verbatim). */
  readonly mustSurvive: ReadonlyArray<string>;
}

/**
 * The shapes. `mustSurvive` is the data-loss contract: whatever a user had that is not ours has to
 * come back out of every scrub, which is exactly what the old line-granular delete got wrong.
 */
export const SHAPES: ReadonlyArray<RcShape> = [
  { id: "empty", lines: [], glued: false, mustSurvive: [] },
  { id: "user-only", lines: [USER], glued: false, mustSurvive: [USER] },
  { id: "our-only", lines: [OUR], glued: false, mustSurvive: [] },
  { id: "our-only-indented", lines: [`  ${OUR}`], glued: false, mustSurvive: [] },
  { id: "user-then-our", lines: [USER, OUR], glued: false, mustSurvive: [USER] },
  { id: "user-blank-our", lines: [USER, "", OUR], glued: false, mustSurvive: [USER] },
  { id: "our-then-user", lines: [OUR, USER], glued: false, mustSurvive: [USER] },
  { id: "our-twice", lines: [OUR, OUR], glued: false, mustSurvive: [] },
  { id: "our-twice-apart", lines: [OUR, USER, OUR], glued: false, mustSurvive: [USER] },
  { id: "stale-only", lines: [STALE], glued: false, mustSurvive: [] },
  { id: "stale-and-our", lines: [STALE, OUR, USER], glued: false, mustSurvive: [USER] },
  { id: "legacy-marker", lines: [LEGACY, USER], glued: false, mustSurvive: [USER] },
  { id: "comment-marker", lines: [COMMENT, USER], glued: false, mustSurvive: [USER] },
  { id: "unquoted", lines: [UNQUOTED, USER], glued: false, mustSurvive: [USER] },
  { id: "foreign-export", lines: [FOREIGN, USER], glued: false, mustSurvive: [FOREIGN, USER] },
  { id: "no-marker", lines: [USER, USER2], glued: false, mustSurvive: [USER, USER2] },
  // ---- the field failure and its neighbours: our span merged onto a line we must not destroy ----
  { id: "glued-user", lines: [`${USER}${OUR}`], glued: true, mustSurvive: [USER] },
  {
    id: "glued-user-then-more",
    lines: [`${USER}${OUR}`, USER2],
    glued: true,
    mustSurvive: [USER, USER2],
  },
  { id: "glued-foreign", lines: [`${FOREIGN}${OUR}`], glued: true, mustSurvive: [FOREIGN] },
  { id: "glued-twice", lines: [`${USER}${OUR}${OUR}`], glued: true, mustSurvive: [USER] },
  {
    id: "glued-then-clean-our",
    lines: [`${USER}${OUR}`, OUR],
    glued: true,
    mustSurvive: [USER],
  },
];

export const ENDINGS: ReadonlyArray<Ending> = ["lf", "none", "crlf"];

/** Render a shape into file bytes. `none` = no trailing newline (the field-failure precondition). */
export function render(shape: RcShape, ending: Ending): string {
  if (shape.lines.length === 0) return "";
  if (ending === "crlf") return `${shape.lines.join("\r\n")}\r\n`;
  if (ending === "none") return shape.lines.join("\n");
  return `${shape.lines.join("\n")}\n`;
}

/**
 * On-disk layouts left behind by EARLIER installer generations. Upgrading must land each of them in
 * the canonical state in ONE pass, so nobody carries an old layout forward forever.
 *
 * `freshEquivalent` is the user content a FRESH install would have to start from to produce the same
 * bytes. For every shape but the last it is simply the user's content with all of ours removed — i.e.
 * upgrading is indistinguishable from installing cleanly.
 *
 * The last shape documents the ONE irreducible ambiguity in a marker-less design: when an older
 * generation's line sits directly under a blank line, nothing in the file records whether that blank
 * was OUR separator or the USER's own. The renderer treats it as ours and absorbs it, which costs the
 * user one blank line ONCE, on the upgrade that normalizes the file. From then on the file is
 * canonical and the byte-exact laws hold with no further drift. Recording it as a fixture (rather than
 * asserting a convenient expectation) is what keeps it from being mistaken for a bug later — a
 * delimited `# >>> … >>>` block is the only thing that would remove the ambiguity, and it was
 * deliberately not adopted.
 */
export interface PriorShape {
  readonly id: string;
  /** What an older generation left on disk. */
  readonly content: string;
  /** User content that, freshly installed onto, yields identical bytes. */
  readonly freshEquivalent: string;
  readonly note?: string;
}

export const PRIOR_SHAPES: ReadonlyArray<PriorShape> = [
  {
    // Pre-fix writer: appended with no blank separator.
    id: "no-separator",
    content: `${USER}\n${OUR}\n`,
    freshEquivalent: `${USER}\n`,
  },
  {
    // Pre-fix writer onto a file with no trailing newline: our line got GLUED on.
    id: "glued",
    content: `${USER}${OUR}`,
    freshEquivalent: `${USER}\n`,
  },
  {
    // An install that relocated: the line points at a bin dir that no longer exists.
    id: "stale-path",
    content: `${USER}\n${STALE}\n`,
    freshEquivalent: `${USER}\n`,
  },
  {
    // Two generations both appended.
    id: "duplicated",
    content: `${USER}\n${OUR}\n${OUR}\n`,
    freshEquivalent: `${USER}\n`,
  },
  {
    // Duplicates that each already carried a separator — every separator must be retracted.
    id: "duplicated-with-separators",
    content: `${USER}\n\n${OUR}\n\n${OUR}\n`,
    freshEquivalent: `${USER}\n`,
  },
  {
    // The oldest generation wrote a version marker comment.
    id: "legacy-marker",
    content: `${USER}\n${LEGACY}\n${OUR}\n`,
    freshEquivalent: `${USER}\n`,
  },
  {
    // A file the installer created itself and nothing else.
    id: "ours-only",
    content: `${OUR}\n`,
    freshEquivalent: "",
  },
  {
    id: "legacy-line-under-a-blank-line",
    content: `${USER}\n\n\n${OUR}\n`,
    // The user had TWO trailing blank lines; one is read as our separator and absorbed. A fresh
    // install onto the remaining single blank line produces exactly these bytes.
    freshEquivalent: `${USER}\n\n`,
    note: "absorbs one blank line, once — the marker-less ambiguity",
  },
];

export interface RcCase {
  readonly id: string;
  readonly shape: RcShape;
  readonly ending: Ending;
  readonly content: string;
}

/** The full cross product — the "every case" both suites iterate. */
export function corpus(): ReadonlyArray<RcCase> {
  const cases: RcCase[] = [];
  for (const shape of SHAPES) {
    for (const ending of ENDINGS) {
      // An empty file has no line endings to vary; emit it once.
      if (shape.lines.length === 0 && ending !== "lf") continue;
      cases.push({
        id: `${shape.id}/${ending}`,
        shape,
        ending,
        content: render(shape, ending),
      });
    }
  }
  return cases;
}

// ============================================================================
// SOURCED-launcher generation (USE_RC_SOURCED_LAUNCHER=true) — additive fixtures.
// Everything above is the classic-generation corpus, byte-frozen: rcLaws.test.ts and
// rcEquivalence.test.ts iterate it unchanged. The sourced-generation suite
// (rcSourcedLaunch.test.ts) consumes these additions.
// ============================================================================

/** The env.sh path every sourced fixture line points at (inside {@link BIN}). */
export const ENV_FILE = `${BIN}/env.sh`;

/** Our sourced-generation rc line, exactly as rc_source_line composes it. */
export const SRC = `[ -f "${ENV_FILE}" ] && . "${ENV_FILE}"`;

/** A sourced line from an EARLIER install at a different location (relocated root / --install-dir). */
export const STALE_SRC = `[ -f "/other/home/.ru-code/bin/env.sh" ] && . "/other/home/.ru-code/bin/env.sh"`;

/** A source guard that is NOT ours (no marker) — must survive byte-for-byte. */
export const FOREIGN_SRC = `[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"`;

/** Sourced-generation shapes — the SRC-line analogue of {@link SHAPES}, plus mixed-generation ones. */
export const SOURCED_SHAPES: ReadonlyArray<RcShape> = [
  { id: "src-only", lines: [SRC], glued: false, mustSurvive: [] },
  { id: "src-only-indented", lines: [`  ${SRC}`], glued: false, mustSurvive: [] },
  { id: "user-then-src", lines: [USER, SRC], glued: false, mustSurvive: [USER] },
  { id: "user-blank-src", lines: [USER, "", SRC], glued: false, mustSurvive: [USER] },
  { id: "src-then-user", lines: [SRC, USER], glued: false, mustSurvive: [USER] },
  { id: "src-twice", lines: [SRC, SRC], glued: false, mustSurvive: [] },
  { id: "src-twice-apart", lines: [SRC, USER, SRC], glued: false, mustSurvive: [USER] },
  { id: "stale-src", lines: [STALE_SRC, USER], glued: false, mustSurvive: [USER] },
  { id: "foreign-src", lines: [FOREIGN_SRC, USER], glued: false, mustSurvive: [FOREIGN_SRC, USER] },
  // ---- glued: our sourced span merged onto a line we must not destroy ----
  { id: "glued-user-src", lines: [`${USER}${SRC}`], glued: true, mustSurvive: [USER] },
  {
    id: "glued-foreign-src",
    lines: [`${FOREIGN_SRC}${SRC}`],
    glued: true,
    mustSurvive: [FOREIGN_SRC],
  },
  // ---- mixed generations in one file (and on one line) ----
  { id: "both-generations", lines: [USER, OUR, SRC], glued: false, mustSurvive: [USER] },
  {
    id: "both-generations-separated",
    lines: [USER, "", OUR, "", SRC],
    glued: false,
    mustSurvive: [USER],
  },
  { id: "both-on-one-line", lines: [`${OUR}${SRC}`], glued: false, mustSurvive: [] },
  { id: "glued-user-both", lines: [`${USER}${OUR}${SRC}`], glued: true, mustSurvive: [USER] },
];

/** The sourced-generation cross product, same construction as {@link corpus}. */
export function sourcedCorpus(): ReadonlyArray<RcCase> {
  const cases: RcCase[] = [];
  for (const shape of SOURCED_SHAPES) {
    for (const ending of ENDINGS) {
      if (shape.lines.length === 0 && ending !== "lf") continue;
      cases.push({ id: `${shape.id}/${ending}`, shape, ending, content: render(shape, ending) });
    }
  }
  return cases;
}

/**
 * Cross-generation convergence inputs: on-disk states left by the OTHER generation (or both).
 * Rendering each with EITHER target line must equal a fresh install onto `freshEquivalent` —
 * flipping the switch converges in one pass, in both directions.
 */
export const CROSS_GEN_SHAPES: ReadonlyArray<PriorShape> = [
  { id: "classic-line", content: `${USER}\n${OUR}\n`, freshEquivalent: `${USER}\n` },
  { id: "sourced-line", content: `${USER}\n${SRC}\n`, freshEquivalent: `${USER}\n` },
  { id: "sourced-with-separator", content: `${USER}\n\n${SRC}\n`, freshEquivalent: `${USER}\n` },
  { id: "both-generations", content: `${USER}\n${OUR}\n${SRC}\n`, freshEquivalent: `${USER}\n` },
  {
    id: "both-with-separators",
    content: `${USER}\n\n${OUR}\n\n${SRC}\n`,
    freshEquivalent: `${USER}\n`,
  },
  { id: "glued-sourced", content: `${USER}${SRC}`, freshEquivalent: `${USER}\n` },
  { id: "stale-both", content: `${STALE}\n${STALE_SRC}\n${USER}\n`, freshEquivalent: `${USER}\n` },
  { id: "sourced-only-file", content: `${SRC}\n`, freshEquivalent: "" },
  {
    id: "legacy-marker-then-sourced",
    content: `${USER}\n${LEGACY}\n${SRC}\n`,
    freshEquivalent: `${USER}\n`,
  },
];
