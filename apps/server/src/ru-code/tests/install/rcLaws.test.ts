// @effect-diagnostics nodeBuiltinImport:off - install-flow test drives the real bash installer.
//
// ru-code: the PATH-persistence LAW SUITE. Every rc-file shape in the corpus is driven through the
// real bash renderer and writer in a sandbox, and each law is asserted BYTE-EXACTLY — the earlier
// blank-line-insensitive comparison is exactly what let unbounded blank-line growth slip through.
//
//   MODEL      the rendered bytes equal an independent TypeScript model of the contract
//   FIXPOINT   render(render(x)) == render(x) — nothing accumulates, ever, over any number of installs
//   ROUNDTRIP  install then uninstall returns the user's original bytes (modulo one final newline)
//   CONVERGE   any older on-disk shape renders to the SAME bytes as the canonical shape, in one pass
//   SURVIVE    every byte of user content is still present after both operations
//   EFFECTIVE  sourcing the result in a REAL bash AND a REAL zsh puts the bin dir on PATH
//   TRUTHFUL   add_path returns 0 exactly when EFFECTIVE holds
//   IDENTITY   the file is never replaced: symlink, inode, mode and hardlinks all survive
//
// EFFECTIVE is the only law that tests what the user actually cares about; every byte assertion is a
// proxy for it. IDENTITY is the one that keeps us from breaking a dotfiles setup.
//
// Full background: SPECS/todo/add path-problems.md.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { BIN, corpus, OUR, PRIOR_SHAPES } from "./fixtures/rcCorpus.ts";
import { ensureFinalNewline, render } from "./fixtures/rcModel.ts";
import { makeSandbox, readLog, shq, sourceEval, type Sandbox } from "./harness.ts";

const RC_GLOBALS = {
  OS: "linux",
  APP_DIR_NAME: ".ru-code",
  APP_BIN: "ru-code",
  BIN_DIR: BIN,
  PATH_BIN: BIN,
  PATH_LINE: OUR,
};

const MODEL = { pathLine: OUR };

const PART_FILE = NodePath.resolve(
  import.meta.dirname,
  "../../../../../..",
  "ru-code/installer/parts/25-rc-path.sh",
);

/** `rc_render <file> <want>` straight to a file, so no shell strips trailing newlines. */
function renderInBash(sb: Sandbox, content: string, want: 0 | 1): string {
  sb.write("home/.bashrc", content);
  const r = sourceEval(sb, `rc_render "$HOME/.bashrc" ${want} > ${shq(sb.path("rendered"))}`, {
    globals: RC_GLOBALS,
  });
  expect(r.status, r.all).toBe(0);
  return sb.read("rendered");
}

interface Lifecycle {
  readonly installed: string;
  readonly installedTwice: string;
  readonly afterFiveCycles: string;
  readonly uninstalled: string;
  readonly addStatus: number;
  readonly bashProbe: string;
  readonly zshProbe: string;
}

/**
 * One bash process drives the whole lifecycle and snapshots the file at each stage. The probes run
 * under `env -i` with only PATH and HOME, so a pass proves the rc file ALONE sets up PATH — no
 * inherited environment can fake it.
 */
function runLifecycle(sb: Sandbox, content: string): Lifecycle {
  sb.write("home/.bashrc", content);
  const out = (name: string): string => shq(sb.path(name));
  const probe = (shell: string, flags: string, dest: string): string =>
    `env -i PATH="$PATH" HOME="$HOME" ${shell} ${flags} -c '. "$HOME/.bashrc" >/dev/null 2>&1; case ":$PATH:" in *":${BIN}:"*) echo YES;; *) echo NO;; esac' > ${out(dest)} 2>/dev/null || echo SHELLFAIL > ${out(dest)}`;

  const r = sourceEval(
    sb,
    [
      `clean_rc >/dev/null 2>&1`,
      `add_path >/dev/null 2>&1; echo "$?" > ${out("add-status")}`,
      `cp "$HOME/.bashrc" ${out("installed")}`,
      probe("bash", "--norc --noprofile", "probe-bash"),
      probe("zsh", "-f", "probe-zsh"),
      `clean_rc >/dev/null 2>&1; add_path >/dev/null 2>&1`,
      `cp "$HOME/.bashrc" ${out("installed-twice")}`,
      `for i in 3 4 5; do clean_rc >/dev/null 2>&1; add_path >/dev/null 2>&1; done`,
      `cp "$HOME/.bashrc" ${out("five-cycles")}`,
      `clean_rc >/dev/null 2>&1`,
      `cp "$HOME/.bashrc" ${out("uninstalled")}`,
    ].join("\n"),
    { globals: RC_GLOBALS },
  );
  expect(r.status, `lifecycle driver failed: ${r.all}`).toBe(0);

  return {
    installed: sb.read("installed"),
    installedTwice: sb.read("installed-twice"),
    afterFiveCycles: sb.read("five-cycles"),
    uninstalled: sb.read("uninstalled"),
    addStatus: Number(sb.read("add-status").trim()),
    bashProbe: sb.read("probe-bash").trim(),
    zshProbe: sb.read("probe-zsh").trim(),
  };
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("rc PATH laws (corpus sweep)", () => {
  const cases = corpus();

  it("the corpus covers the field-failure shape and every line ending", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(cases.some((c) => c.shape.glued && c.ending === "none")).toBe(true);
    expect(cases.some((c) => c.ending === "crlf")).toBe(true);
  });

  for (const testCase of cases) {
    it(`upholds every law: ${testCase.id}`, () => {
      const sb = makeSandbox();
      try {
        // MODEL — the renderer agrees with the independent model, in both directions.
        expect(renderInBash(sb, testCase.content, 1), "install render differs from model").toBe(
          render(testCase.content, true, MODEL),
        );
        expect(renderInBash(sb, testCase.content, 0), "uninstall render differs from model").toBe(
          render(testCase.content, false, MODEL),
        );

        const life = runLifecycle(sb, testCase.content);

        // FIXPOINT — byte-exact, and it must still hold after five full cycles.
        expect(life.installedTwice, "second install changed the bytes").toBe(life.installed);
        expect(life.afterFiveCycles, "bytes drifted across five install cycles").toBe(
          life.installed,
        );

        // ROUNDTRIP — the user gets their bytes back.
        expect(life.uninstalled, "uninstall did not restore the original bytes").toBe(
          ensureFinalNewline(render(testCase.content, false, MODEL)),
        );

        // SURVIVE — user content is never collateral damage.
        for (const survivor of testCase.shape.mustSurvive) {
          expect(life.installed, `install destroyed user content: ${survivor}`).toContain(survivor);
          expect(life.uninstalled, `uninstall destroyed user content: ${survivor}`).toContain(
            survivor,
          );
        }

        // EFFECTIVE + TRUTHFUL.
        expect(life.bashProbe, `bash did not get ${BIN} from the rc file`).toBe("YES");
        expect(life.zshProbe, `zsh did not get ${BIN} from the rc file`).toBe("YES");
        expect(life.addStatus).toBe(0);

        // Exactly one copy of our line, and nothing of ours left after uninstall.
        expect(occurrences(life.installed, OUR)).toBe(1);
        expect(life.uninstalled).not.toContain("/.ru-code/bin");
        expect(life.uninstalled).not.toContain("# ru-code v");
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("rc PATH converges from every prior on-disk shape in one pass", () => {
  // Why a user upgrading from ANY older installer generation lands in the canonical state immediately
  // instead of carrying their old layout forward. Three assertions per shape: the bash renderer agrees
  // with the independent model, the result is indistinguishable from a fresh install onto the same
  // user content, and it is already a fixpoint so nothing drifts afterwards.
  for (const prior of PRIOR_SHAPES) {
    const label = prior.note ? `${prior.id} (${prior.note})` : prior.id;
    it(`converges: ${label}`, () => {
      const sb = makeSandbox();
      try {
        const rendered = renderInBash(sb, prior.content, 1);
        expect(rendered, "bash renderer disagrees with the model").toBe(
          render(prior.content, true, MODEL),
        );
        expect(rendered, "upgrading differs from a fresh install on the same content").toBe(
          renderInBash(sb, prior.freshEquivalent, 1),
        );
        expect(renderInBash(sb, rendered, 1), "the converged shape is not a fixpoint").toBe(
          rendered,
        );
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("rc PATH never replaces the file (identity is preserved)", () => {
  it("writes THROUGH a symlink: the link survives and the target is edited", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/dotfiles/bashrc", `alias ll='ls -la'\n`);
      const r = sourceEval(
        sb,
        [
          `ln -s "$HOME/dotfiles/bashrc" "$HOME/.bashrc"`,
          `TARGET_BEFORE=$(ls -i "$HOME/dotfiles/bashrc" | cut -d" " -f1)`,
          `add_path >/dev/null 2>&1`,
          `clean_rc >/dev/null 2>&1; add_path >/dev/null 2>&1`,
          `TARGET_AFTER=$(ls -i "$HOME/dotfiles/bashrc" | cut -d" " -f1)`,
          `{ [ -L "$HOME/.bashrc" ] && echo "SYMLINK=yes" || echo "SYMLINK=no"; `,
          `  [ "$TARGET_BEFORE" = "$TARGET_AFTER" ] && echo "INODE=same" || echo "INODE=changed"; `,
          `} > ${shq(sb.path("identity"))}`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.status, r.all).toBe(0);
      const identity = sb.read("identity");
      expect(identity).toContain("SYMLINK=yes");
      expect(identity).toContain("INODE=same");
      // The real file behind the link is the one that carries our line.
      const target = sb.read("home/dotfiles/bashrc");
      expect(target.split("\n")).toContain(OUR);
      expect(target).toContain("alias ll='ls -la'");
      // …and uninstall cleans the target through the link, leaving nothing stale behind.
      const r2 = sourceEval(sb, `clean_rc >/dev/null 2>&1`, { globals: RC_GLOBALS });
      expect(r2.status, r2.all).toBe(0);
      expect(sb.read("home/dotfiles/bashrc")).not.toContain(".ru-code/bin");
      expect(sb.exists("home/.bashrc")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("preserves inode, mode and hardlinks on a plain rc", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", `alias ll='ls -la'\n`, 0o600);
      const r = sourceEval(
        sb,
        [
          `ln "$HOME/.bashrc" "$HOME/.bashrc.hard"`,
          `BEFORE=$(ls -i "$HOME/.bashrc" | cut -d" " -f1)`,
          `add_path >/dev/null 2>&1`,
          `AFTER=$(ls -i "$HOME/.bashrc" | cut -d" " -f1)`,
          `{ [ "$BEFORE" = "$AFTER" ] && echo "INODE=same" || echo "INODE=changed"; `,
          `  echo "MODE=$(ls -l "$HOME/.bashrc" | cut -c1-10)"; `,
          `  echo "LINKS=$(ls -l "$HOME/.bashrc" | tr -s " " | cut -d" " -f2)"; `,
          `} > ${shq(sb.path("identity"))}`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.status, r.all).toBe(0);
      const identity = sb.read("identity");
      expect(identity).toContain("INODE=same");
      expect(identity, "mode must not widen (a rename would make it 644)").toContain(
        "MODE=-rw-----",
      );
      expect(identity, "the hardlink must survive").toContain("LINKS=2");
      // The hardlinked twin sees the same content, which is only true if we edited in place.
      expect(sb.read("home/.bashrc.hard").split("\n")).toContain(OUR);
    } finally {
      sb.cleanup();
    }
  });

  it("leaves an unwritable rc completely untouched and reports failure", () => {
    const sb = makeSandbox();
    try {
      const original = `# keep me\nalias ll='ls -la'\n`;
      sb.write("home/.bashrc", original, 0o444);
      const r = sourceEval(sb, `write_line "$HOME/.bashrc"; echo "rc=$?"`, { globals: RC_GLOBALS });
      expect(r.all).toContain("rc=1");
      // Byte-for-byte untouched — no partial write, no truncation, no replacement.
      expect(sb.read("home/.bashrc")).toBe(original);
      expect(sb.exists("home/.bashrc.tmp")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("does not touch a file that is already correct (no rewrite, no backup)", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", `alias ll='ls -la'\n`);
      const r = sourceEval(
        sb,
        [
          `add_path >/dev/null 2>&1`,
          `rm -f "$HOME/.bashrc.bak"`,
          `write_line "$HOME/.bashrc"; echo "rc=$?"`,
          `[ -e "$HOME/.bashrc.bak" ] && echo "BACKUP=made" || echo "BACKUP=none"`,
        ].join("\n"),
        { globals: RC_GLOBALS },
      );
      expect(r.all).toContain("rc=0");
      expect(r.all).toContain("BACKUP=none");
      // The journal (not the screen) is where per-file detail goes.
      expect(readLog(sb)).toContain("уже присутствует");
    } finally {
      sb.cleanup();
    }
  });
});

describe("rc PATH write is glue-proof by construction", () => {
  it("never merges our line onto a file that lacks a trailing newline", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", "alias ll='ls -la'"); // no trailing newline — the field failure
      const r = sourceEval(sb, `add_path >/dev/null 2>&1; echo "rc=$?"`, { globals: RC_GLOBALS });
      expect(r.all).toContain("rc=0");
      const rc = sb.read("home/.bashrc");
      expect(rc.split("\n")).toContain(OUR);
      expect(rc).toContain("alias ll='ls -la'\n");
      expect(rc).not.toContain(`alias ll='ls -la'${OUR}`);
    } finally {
      sb.cleanup();
    }
  });
});

// The corpus runs on this machine's bash and GNU userland, so it proves the LOGIC but cannot prove BSD
// behavior. That gap is closed structurally instead: the shipped part uses no external text tool and no
// bash-4 syntax, so there is nothing left that could behave differently on macOS's bash 3.2.
describe("rc PATH part is portable to macOS by construction", () => {
  const source = NodeFS.readFileSync(PART_FILE, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("uses no external text-processing tool", () => {
    for (const tool of ["sed ", "awk ", "perl ", "readarray", "mapfile"]) {
      expect(code, `must not depend on ${tool.trim()}`).not.toContain(tool);
    }
  });

  it("uses no GNU-only grep flags", () => {
    expect(code).not.toContain("grep -P");
    expect(code).not.toContain("--include");
  });

  it("uses no bash-4+ syntax (macOS ships bash 3.2)", () => {
    for (const syntax of ["declare -A", "${!", ",,}", "^^}", "&>>", "wait -n", "globstar"]) {
      expect(code, `bash 3.2 cannot parse ${syntax}`).not.toContain(syntax);
    }
  });

  it("never renames a file over an rc path", () => {
    // A single `mv` here would silently reintroduce every identity loss the IDENTITY laws forbid.
    expect(code, "the writer must not rename over the target").not.toContain("mv ");
  });

  it("keeps the read loops that preserve a final line without a newline", () => {
    const loops = code.split("while IFS= read -r line").slice(1);
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) {
      expect(loop.slice(0, 40)).toContain('|| [ -n "$line" ]');
    }
  });
});
