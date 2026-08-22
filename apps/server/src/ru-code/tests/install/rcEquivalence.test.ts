// @effect-diagnostics nodeBuiltinImport:off - install-flow test drives the real bash installer.
//
// ru-code: the ZERO-REGRESSION PROOF for the PATH-persistence rework. The rc logic as it shipped
// before the change is preserved verbatim in fixtures/legacyRcLogic.sh; this suite runs BOTH
// generations over the same ~60-shape corpus and holds the new one to a single rule:
//
//   the output must be byte-identical to the old one, EXCEPT in the two classes of input where the
//   old behavior was the bug we are fixing.
//
// Those three content classes, and nothing else, are allowed to differ:
//
//   GLUED         our export merged onto a line of the user's own (the field failure). Old deleted
//                 the whole line and took the user's content with it; new excises only our span.
//   EMPTY-RESULT  scrubbing would leave the file with no content at all — i.e. the file held nothing
//                 but our line, which means WE created it. Old refused to write and left the line
//                 behind forever (orphaned after uninstall); new completes the scrub.
//   SEPARATOR     a blank line sits directly above a line of ours. Old left it, which is how blank
//                 lines accumulated one per install; new retracts it, which is what makes the
//                 byte-exact fixpoint law hold.
//
// A fourth, orthogonal delta is about the FILE rather than its bytes: old renamed a temp file over the
// rc (destroying symlinks, widening mode 600 -> 644, breaking hardlinks), new writes in place. It is
// asserted separately at the bottom because it cannot show up in a content comparison.
//
// Any other divergence fails the suite. That is the whole point: "0 regression" is a measurement here,
// not a claim.
//
// The last block runs the LAWS against the old code to show they have teeth — a suite that passes on
// the buggy implementation would prove nothing about the fixed one.

import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { corpus, BIN, OUR } from "./fixtures/rcCorpus.ts";
import { makeSandbox, shq, sourceEval, type Sandbox } from "./harness.ts";

const RC_GLOBALS = {
  OS: "linux",
  APP_DIR_NAME: ".ru-code",
  APP_BIN: "ru-code",
  BIN_DIR: BIN,
};

const ORACLE = NodePath.resolve(import.meta.dirname, "fixtures/legacyRcLogic.sh");

function readLines(content: string): ReadonlyArray<string> {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const isOurs = (line: string): boolean =>
  line.includes("/.ru-code/bin") || line.includes("# ru-code v");

/** True when the old `grep -vF` scrub would have produced an empty file (so it bailed out instead). */
function legacyScrubWouldEmpty(content: string): boolean {
  const lines = readLines(content);
  return lines.length > 0 && lines.every(isOurs);
}

/** True when a blank line sits directly above a line of ours — the separator-retraction class. */
function hasSeparatorAboveOurs(content: string): boolean {
  const lines = readLines(content);
  return lines.some(
    (line, index) => index > 0 && isOurs(line) && (lines[index - 1] ?? "").trim() === "",
  );
}

/** Run new and old scrub over identical input in ONE bash process; return both results. */
function scrubBoth(sb: Sandbox, content: string): { readonly next: string; readonly prev: string } {
  sb.write("home/.bashrc", content);
  const r = sourceEval(
    sb,
    [
      `source ${shq(ORACLE)}`,
      // NEW generation
      `clean_rc >/dev/null 2>&1`,
      `cp "$HOME/.bashrc" ${shq(sb.path("out-next"))}`,
      // restore the pristine input, then the FROZEN generation
      `cp ${shq(sb.path("input"))} "$HOME/.bashrc"`,
      `rm -f "$HOME/.bashrc.bak" "$HOME/.bashrc.tmp"`,
      `legacy_clean_rc >/dev/null 2>&1`,
      `cp "$HOME/.bashrc" ${shq(sb.path("out-prev"))}`,
    ].join("\n"),
    { globals: RC_GLOBALS },
  );
  expect(r.status, `differential driver failed: ${r.all}`).toBe(0);
  return { next: sb.read("out-next"), prev: sb.read("out-prev") };
}

describe("rc scrub: differential vs the frozen pre-change implementation", () => {
  for (const testCase of corpus()) {
    const glued = testCase.shape.glued;
    const emptyResult = legacyScrubWouldEmpty(testCase.content);
    const separator = hasSeparatorAboveOurs(testCase.content);
    const label = glued
      ? "documented delta (glued)"
      : emptyResult
        ? "documented delta (empty-result)"
        : separator
          ? "documented delta (separator)"
          : "byte-identical";

    it(`${label}: ${testCase.id}`, () => {
      const sb = makeSandbox();
      try {
        sb.write("input", testCase.content);
        const { next, prev } = scrubBoth(sb, testCase.content);

        // Vacuity guard: a comparison of two empty strings would pass every branch below. Assert the
        // user's content is really there before trusting any equality.
        for (const survivor of testCase.shape.mustSurvive) {
          expect(next, `new scrub lost user content: ${survivor}`).toContain(survivor);
        }

        if (!glued && !emptyResult && !separator) {
          // The regression fence: everywhere outside the documented classes, the new scrub must be
          // indistinguishable from the one that shipped.
          expect(next, "new scrub diverged from the frozen implementation").toBe(prev);
          return;
        }

        if (separator && !glued && !emptyResult) {
          // The ONLY difference must be blank lines: same content, one fewer empty line.
          const significant = (value: string): ReadonlyArray<string> =>
            value.split("\n").filter((line) => line.trim() !== "");
          expect(significant(next)).toEqual(significant(prev));
          expect(next.length).toBeLessThan(prev.length);
          return;
        }

        if (emptyResult && !glued) {
          // Old refused to write (left our line in place); new finishes the job.
          expect(prev).toContain("/.ru-code/bin");
          expect(next).not.toContain("/.ru-code/bin");
          return;
        }

        // GLUED: old destroyed the user's own content, new keeps every byte of it.
        for (const survivor of testCase.shape.mustSurvive) {
          expect(next, `new scrub lost user content: ${survivor}`).toContain(survivor);
        }
        expect(next).not.toContain("/.ru-code/bin");
        // And the old behavior really was destructive — either it dropped the content or it left our
        // dead line in place. Both are the bug; neither is acceptable.
        const oldWasBroken =
          testCase.shape.mustSurvive.some((survivor) => !prev.includes(survivor)) ||
          prev.includes("/.ru-code/bin");
        expect(oldWasBroken, "expected the old scrub to be broken on a glued line").toBe(true);
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("rc write: differential vs the frozen pre-change implementation", () => {
  // The write is INTENTIONALLY not byte-identical — the leading newline is the fix. What must hold is
  // that it produces the same MEANINGFUL content (same lines, ignoring blank separators) everywhere
  // the old write already worked, and works in the one place the old write silently failed.
  for (const ending of ["lf", "none"] as const) {
    it(`same significant content as the old write (${ending} input)`, () => {
      const sb = makeSandbox();
      try {
        const content =
          ending === "lf" ? "alias ll='ls -la'\n# tail\n" : "alias ll='ls -la'\n# tail";
        sb.write("home/.bashrc", content);
        sb.write("home2/.bashrc", content);
        const r = sourceEval(
          sb,
          [
            `source ${shq(ORACLE)}`,
            `PATH_BIN=${shq(BIN)}; PATH_LINE=${shq(OUR)}`,
            `write_line "$HOME/.bashrc" >/dev/null 2>&1; echo "new=$?" > ${shq(sb.path("codes"))}`,
            `HOME=${shq(sb.path("home2"))} legacy_write_line ${shq(sb.path("home2/.bashrc"))} >/dev/null 2>&1; echo "old=$?" >> ${shq(sb.path("codes"))}`,
          ].join("\n"),
          { globals: RC_GLOBALS },
        );
        expect(r.status, r.all).toBe(0);
        const codes = sb.read("codes");
        expect(codes).toContain("new=0");
        expect(codes).toContain("old=0");

        const significant = (value: string): ReadonlyArray<string> =>
          value.split("\n").filter((line) => line.trim() !== "");
        const nextRc = sb.read("home/.bashrc");
        const prevRc = sb.read("home2/.bashrc");

        if (ending === "lf") {
          // Old write was already correct here — the only difference is our blank separator.
          expect(significant(nextRc)).toEqual(significant(prevRc));
        } else {
          // The field failure: the old write GLUED our export onto the user's last line.
          expect(prevRc).toContain(`# tail${OUR}`);
          expect(nextRc).not.toContain(`# tail${OUR}`);
          expect(nextRc.split("\n")).toContain(OUR);
        }
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("rc file identity: in-place write vs the old rename (measured, both generations)", () => {
  // These are the deltas that a content comparison can never show. Each assertion below states what
  // the shipped code DID and what the new code does instead, so the improvement is recorded rather
  // than asserted in the abstract.
  it("old rename destroyed a symlink and left a stale line in the target; new writes through it", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/dotfiles/rc-old", `alias ll=1\n${OUR}\n`);
      sb.write("home/dotfiles/rc-new", `alias ll=1\n${OUR}\n`);
      const r = sourceEval(
        sb,
        [
          `source ${shq(ORACLE)}`,
          // OLD generation, driven directly at a symlinked path.
          `ln -s "$HOME/dotfiles/rc-old" "$HOME/.old"`,
          `grep -vF -e "/.ru-code/bin" "$HOME/.old" > "$HOME/.old.tmp" 2>/dev/null`,
          `mv "$HOME/.old.tmp" "$HOME/.old"`,
          // NEW generation.
          `ln -s "$HOME/dotfiles/rc-new" "$HOME/.new"`,
          `rc_apply "$HOME/.new" 0 >/dev/null 2>&1`,
          `{ [ -L "$HOME/.old" ] && echo "OLD_SYMLINK=yes" || echo "OLD_SYMLINK=no";`,
          `  [ -L "$HOME/.new" ] && echo "NEW_SYMLINK=yes" || echo "NEW_SYMLINK=no";`,
          `} > ${shq(sb.path("identity"))}`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.status, r.all).toBe(0);
      const identity = sb.read("identity");
      expect(identity).toContain("OLD_SYMLINK=no"); // rename severed the link
      expect(identity).toContain("NEW_SYMLINK=yes"); // in-place kept it
      // The old way left our line behind in the dotfiles repo; the new way cleaned it.
      expect(sb.read("home/dotfiles/rc-old")).toContain(".ru-code/bin");
      expect(sb.read("home/dotfiles/rc-new")).not.toContain(".ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("old rename widened mode 600 -> 644; new preserves it", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.old", `alias ll=1\n${OUR}\n`, 0o600);
      sb.write("home/.new", `alias ll=1\n${OUR}\n`, 0o600);
      const r = sourceEval(
        sb,
        [
          `grep -vF -e "/.ru-code/bin" "$HOME/.old" > "$HOME/.old.tmp" 2>/dev/null`,
          `mv "$HOME/.old.tmp" "$HOME/.old"`,
          `rc_apply "$HOME/.new" 0 >/dev/null 2>&1`,
          `{ echo "OLD=$(ls -l "$HOME/.old" | cut -c1-10)";`,
          `  echo "NEW=$(ls -l "$HOME/.new" | cut -c1-10)";`,
          `} > ${shq(sb.path("modes"))}`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.status, r.all).toBe(0);
      const modes = sb.read("modes");
      expect(modes).toContain("OLD=-rw-r--r--"); // the tmp file's mode won
      expect(modes).toContain("NEW=-rw-------"); // the user's mode survived
    } finally {
      sb.cleanup();
    }
  });

  it("a read-only rc: old rewrote it anyway, new leaves it byte-for-byte untouched", () => {
    const sb = makeSandbox();
    try {
      const original = `# keep\n${OUR}\n`;
      sb.write("home/.old", original, 0o444);
      sb.write("home/.new", original, 0o444);
      const r = sourceEval(
        sb,
        [
          `grep -vF -e "/.ru-code/bin" "$HOME/.old" > "$HOME/.old.tmp" 2>/dev/null`,
          `mv "$HOME/.old.tmp" "$HOME/.old" 2>/dev/null; echo "old_mv=$?" > ${shq(sb.path("codes"))}`,
          `rc_apply "$HOME/.new" 0 >/dev/null 2>&1; echo "new_rc=$?" >> ${shq(sb.path("codes"))}`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.status, r.all).toBe(0);
      // rename does not need write permission on the target, so the old code modified a file the
      // user had marked read-only.
      expect(sb.read("codes")).toContain("old_mv=0");
      expect(sb.read("home/.old")).not.toContain(".ru-code/bin");
      // The new code respects the bit: it reports failure and changes nothing.
      expect(sb.read("codes")).toContain("new_rc=1");
      expect(sb.read("home/.new")).toBe(original);
    } finally {
      sb.cleanup();
    }
  });
});

describe("the law suite has teeth (it fails on the pre-change implementation)", () => {
  it("old write produces an rc that no shell can use, and the EFFECTIVE law catches it", () => {
    const sb = makeSandbox();
    try {
      // Exactly the field-failure precondition: an rc file with no trailing newline.
      sb.write("home/.bashrc", "alias ll='ls -la'");
      const r = sourceEval(
        sb,
        [
          `source ${shq(ORACLE)}`,
          `PATH_BIN=${shq(BIN)}; PATH_LINE=${shq(OUR)}`,
          `legacy_write_line "$HOME/.bashrc" >/dev/null 2>&1; echo "rc=$?" > ${shq(sb.path("code"))}`,
          `env -i PATH="$PATH" HOME="$HOME" bash --norc --noprofile -c '. "$HOME/.bashrc" >/dev/null 2>&1; case ":$PATH:" in *":${BIN}:"*) echo YES;; *) echo NO;; esac' > ${shq(sb.path("probe"))} 2>/dev/null || echo SHELLFAIL > ${shq(sb.path("probe"))}`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.status, r.all).toBe(0);

      // The old code reported SUCCESS…
      expect(sb.read("code")).toContain("rc=0");
      // …for a file that does not put the bin dir on PATH. This is the bug, reproduced.
      expect(sb.read("probe").trim()).not.toBe("YES");
      // And the glued line is right there in the file.
      expect(sb.read("home/.bashrc")).toContain(`alias ll='ls -la'${OUR}`);
    } finally {
      sb.cleanup();
    }
  });

  it("old scrub destroys user content on a glued line", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", `alias ll='ls -la'${OUR}\nexport EDITOR=vim\n`);
      const r = sourceEval(
        sb,
        [`source ${shq(ORACLE)}`, `legacy_clean_rc >/dev/null 2>&1`].join("\n"),
        {
          globals: RC_GLOBALS,
        },
      );
      expect(r.status, r.all).toBe(0);
      const rc = sb.read("home/.bashrc");
      expect(rc).toContain("export EDITOR=vim");
      expect(rc, "the old scrub silently ate the user's alias").not.toContain("alias ll=");
    } finally {
      sb.cleanup();
    }
  });
});
