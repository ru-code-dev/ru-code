// @effect-diagnostics nodeBuiltinImport:off - install-flow test drives the real bash installer.
//
// ru-code: the SOURCED-launcher law suite (USE_RC_SOURCED_LAUNCHER=true). The classic-generation
// laws live in rcLaws.test.ts and run UNCHANGED — this suite adds the second generation on top:
//
//   MODEL       the rendered bytes equal the independent TypeScript model, sourced corpus included
//   FIXPOINT    render(render(x)) == render(x) over every sourced/mixed shape
//   ROUNDTRIP   install then uninstall returns the user's original bytes (modulo one final newline)
//   CROSS-GEN   any state left by EITHER generation converges to EITHER target in ONE pass —
//               flipping the switch never needs a second install and never strands an old line
//   FUNCTION    sourcing the rc in a REAL bash AND zsh defines `<APP_BIN>` AS A FUNCTION that
//               answers --version even with the wrapper file's exec bit STRIPPED — the exact
//               environment this generation exists for, reproduced in captivity
//   DEDUP       sourcing env.sh any number of times leaves exactly ONE PATH entry
//   DEGRADE     a failed env.sh write falls back to the classic PATH line (persistence never
//               hinges on the new file); a guarded line whose env.sh is gone is a silent no-op
//
// The switch default is OFF and asserted here against the SHIPPED artifact: with the flag off the
// renderer, writer and every rc byte are the classic generation, which rcLaws/rcEquivalence pin.
//
// Full background: SPECS/todo/add path-problems.md.

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { BIN, CROSS_GEN_SHAPES, OUR, SRC, sourcedCorpus } from "./fixtures/rcCorpus.ts";
import { ensureFinalNewline, render } from "./fixtures/rcModel.ts";
import { INSTALL_SCRIPT, makeSandbox, readLog, shq, sourceEval, type Sandbox } from "./harness.ts";

/** Pure-renderer globals — same fixture BIN as the classic suite; only the line shape differs. */
const RC_GLOBALS_SRC = {
  OS: "linux",
  APP_DIR_NAME: ".ru-code",
  APP_BIN: "ru-code",
  BIN_DIR: BIN,
  PATH_BIN: BIN,
  PATH_LINE: SRC,
};

const MODEL_SRC = { pathLine: SRC };
const MODEL_OUR = { pathLine: OUR };

/** `rc_render <file> <want>` straight to a file, so no shell strips trailing newlines. */
function renderInBash(
  sb: Sandbox,
  content: string,
  want: 0 | 1,
  globals: Record<string, string> = RC_GLOBALS_SRC,
): string {
  sb.write("home/.bashrc", content);
  const r = sourceEval(sb, `rc_render "$HOME/.bashrc" ${want} > ${shq(sb.path("rendered"))}`, {
    globals,
  });
  expect(r.status, r.all).toBe(0);
  return sb.read("rendered");
}

/**
 * A sandbox with a REAL bin dir for the sourced generation: a fake cli.js that answers --version,
 * and the wrapper file present WITHOUT its exec bit — running it via PATH would fail with
 * "permission denied", so a probe that gets the version proves the FUNCTION resolved, not the file.
 */
function seedRealBin(sb: Sandbox): Record<string, string> {
  const binDir = sb.path("app/.ru-code/bin");
  sb.write(
    "app/.ru-code/bin/cli.js",
    `if (process.argv[2] === "--version") { process.stdout.write("ru-code v9.9.9\\n"); }\nprocess.exit(0);\n`,
  );
  sb.write("app/.ru-code/bin/ru-code", "#!/bin/sh\nexit 97\n", 0o644); // exec bit STRIPPED
  return {
    OS: "linux",
    APP_DIR_NAME: ".ru-code",
    APP_BIN: "ru-code",
    APP_DISPLAY_NAME: "Ru Code",
    BIN_DIR: binDir,
    PATH_BIN: binDir,
    ENTRY_JS: "cli.js",
    NODE_PATH: process.execPath,
    NODE_FLAGS: "",
    USE_RC_SOURCED_LAUNCHER: "true",
  };
}

interface SourcedLifecycle {
  readonly installed: string;
  readonly installedTwice: string;
  readonly afterFiveCycles: string;
  readonly uninstalled: string;
  readonly addStatus: number;
  readonly bashType: string;
  readonly bashVersion: string;
  readonly bashPath: string;
  readonly zshType: string;
  readonly zshVersion: string;
  readonly dedupCount: string;
}

/** One bash process drives the whole ON-mode lifecycle; probes run under `env -i`. */
function runSourcedLifecycle(sb: Sandbox, content: string): SourcedLifecycle {
  const globals = seedRealBin(sb);
  const binDir = globals.BIN_DIR as string;
  sb.write("home/.bashrc", content);
  const out = (name: string): string => shq(sb.path(name));
  const probe = (shell: string, flags: string, dest: string): string =>
    `env -i PATH="$PATH" HOME="$HOME" ${shell} ${flags} -c '` +
    `. "$HOME/.bashrc" >/dev/null 2>&1; ` +
    `t=$(LC_ALL=C type ru-code 2>/dev/null | head -n 1 || true); ` +
    `v=$(ru-code --version 2>/dev/null || echo FAIL); ` +
    `case ":$PATH:" in *":${binDir}:"*) p=YES;; *) p=NO;; esac; ` +
    `printf "type=%s\\nversion=%s\\npath=%s\\n" "$t" "$v" "$p"' > ${out(dest)} 2>/dev/null ` +
    `|| echo SHELLFAIL > ${out(dest)}`;
  const dedup =
    `env -i PATH="$PATH" HOME="$HOME" bash --norc --noprofile -c '` +
    `. "$HOME/.bashrc" >/dev/null 2>&1; . "$HOME/.bashrc" >/dev/null 2>&1; ` +
    `. "${binDir}/env.sh" >/dev/null 2>&1; ` +
    `printf "%s\\n" "$PATH" | tr ":" "\\n" | grep -cx "${binDir}"' > ${out("dedup")} 2>/dev/null ` +
    `|| echo SHELLFAIL > ${out("dedup")}`;

  const r = sourceEval(
    sb,
    [
      `clean_rc >/dev/null 2>&1`,
      `add_path >/dev/null 2>&1; echo "$?" > ${out("add-status")}`,
      `cp "$HOME/.bashrc" ${out("installed")}`,
      probe("bash", "--norc --noprofile", "probe-bash"),
      probe("zsh", "-f", "probe-zsh"),
      dedup,
      `clean_rc >/dev/null 2>&1; add_path >/dev/null 2>&1`,
      `cp "$HOME/.bashrc" ${out("installed-twice")}`,
      `for i in 3 4 5; do clean_rc >/dev/null 2>&1; add_path >/dev/null 2>&1; done`,
      `cp "$HOME/.bashrc" ${out("five-cycles")}`,
      `clean_rc >/dev/null 2>&1`,
      `cp "$HOME/.bashrc" ${out("uninstalled")}`,
    ].join("\n"),
    { globals },
  );
  expect(r.status, `lifecycle driver failed: ${r.all}`).toBe(0);

  const kv = (file: string, key: string): string => {
    const line = sb
      .read(file)
      .split("\n")
      .find((candidate) => candidate.startsWith(`${key}=`));
    return line === undefined ? "" : line.slice(key.length + 1);
  };
  return {
    installed: sb.read("installed"),
    installedTwice: sb.read("installed-twice"),
    afterFiveCycles: sb.read("five-cycles"),
    uninstalled: sb.read("uninstalled"),
    addStatus: Number(sb.read("add-status").trim()),
    bashType: kv("probe-bash", "type"),
    bashVersion: kv("probe-bash", "version"),
    bashPath: kv("probe-bash", "path"),
    zshType: kv("probe-zsh", "type"),
    zshVersion: kv("probe-zsh", "version"),
    dedupCount: sb.read("dedup").trim(),
  };
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("sourced launcher is OFF by default in the shipped artifact", () => {
  it("the committed `install` bakes USE_RC_SOURCED_LAUNCHER=false", () => {
    const committed = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    expect(committed).toContain(
      `USE_RC_SOURCED_LAUNCHER="\${INSTALL_USE_RC_SOURCED_LAUNCHER:-false}"`,
    );
  });
});

describe("sourced rc laws (corpus sweep)", () => {
  for (const testCase of sourcedCorpus()) {
    it(`upholds the renderer laws: ${testCase.id}`, () => {
      const sb = makeSandbox();
      try {
        // MODEL — both directions.
        const installed = renderInBash(sb, testCase.content, 1);
        const uninstalled = renderInBash(sb, testCase.content, 0);
        expect(installed, "install render differs from model").toBe(
          render(testCase.content, true, MODEL_SRC),
        );
        expect(uninstalled, "uninstall render differs from model").toBe(
          render(testCase.content, false, MODEL_SRC),
        );

        // FIXPOINT + ROUNDTRIP.
        expect(renderInBash(sb, installed, 1), "render is not a fixpoint").toBe(installed);
        expect(
          renderInBash(sb, ensureFinalNewline(uninstalled), 0),
          "uninstall render is not a fixpoint",
        ).toBe(ensureFinalNewline(uninstalled));

        // Exactly one copy of our line; nothing of ours after uninstall.
        expect(occurrences(installed, SRC)).toBe(1);
        expect(uninstalled).not.toContain("/.ru-code/bin");

        // SURVIVE.
        for (const survivor of testCase.shape.mustSurvive) {
          expect(installed, `install destroyed user content: ${survivor}`).toContain(survivor);
          expect(uninstalled, `uninstall destroyed user content: ${survivor}`).toContain(survivor);
        }
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("cross-generation convergence — one pass, both directions", () => {
  for (const prior of CROSS_GEN_SHAPES) {
    it(`converges: ${prior.id}`, () => {
      const sb = makeSandbox();
      try {
        for (const [label, line, model] of [
          ["sourced", SRC, MODEL_SRC],
          ["classic", OUR, MODEL_OUR],
        ] as const) {
          const globals = { ...RC_GLOBALS_SRC, PATH_LINE: line };
          const rendered = renderInBash(sb, prior.content, 1, globals);
          expect(rendered, `${label}: bash renderer disagrees with the model`).toBe(
            render(prior.content, true, { pathLine: model.pathLine }),
          );
          expect(
            rendered,
            `${label}: upgrading differs from a fresh install on the same content`,
          ).toBe(renderInBash(sb, prior.freshEquivalent, 1, globals));
          expect(
            renderInBash(sb, rendered, 1, globals),
            `${label}: the converged shape is not a fixpoint`,
          ).toBe(rendered);
          // The other generation's line never survives a render to this generation.
          expect(rendered).not.toContain(label === "sourced" ? OUR : SRC);
        }
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("sourced launcher lifecycle (real env.sh, real shells)", () => {
  const LIFECYCLE_CONTENTS: ReadonlyArray<readonly [string, string]> = [
    ["empty file", ""],
    ["user content", `alias ll='ls -la'\n`],
    ["user content, no trailing newline", `alias ll='ls -la'`],
    ["stale classic line from a prior generation", `alias ll='ls -la'\n${OUR}\n`],
    ["stale sourced line", `alias ll='ls -la'\n\n${SRC}\n`],
    ["both stale generations", `alias ll='ls -la'\n${OUR}\n${SRC}\n`],
  ];

  for (const [label, content] of LIFECYCLE_CONTENTS) {
    it(`installs, launches AS A FUNCTION with the wrapper exec bit stripped, converges: ${label}`, () => {
      const sb = makeSandbox();
      try {
        const life = runSourcedLifecycle(sb, content);
        const binDir = sb.path("app/.ru-code/bin");
        const ourLine = `[ -f "${binDir}/env.sh" ] && . "${binDir}/env.sh"`;

        expect(life.addStatus).toBe(0);

        // env.sh: exists, 0644, carries the guard + the function with BAKED literal paths.
        const envStat = NodeFS.statSync(sb.path("app/.ru-code/bin/env.sh"));
        expect(envStat.mode & 0o777).toBe(0o644);
        const envSh = sb.read("app/.ru-code/bin/env.sh");
        expect(envSh).toContain(`case ":$PATH:" in`);
        expect(envSh).toContain(`*":${binDir}:"*`);
        expect(envSh).toContain(`export PATH="${binDir}:$PATH"`);
        expect(envSh).toContain("ru-code() {");
        expect(envSh).toContain(`'${process.execPath}'`);
        expect(envSh).toContain(`'${binDir}/cli.js'`);
        expect(envSh).toContain("command ");
        expect(envSh, "only $@ may be deferred — never $HOME").not.toContain("$HOME");

        // rc: exactly ONE guarded source line, no classic export of ours, old shapes scrubbed.
        expect(occurrences(life.installed, ourLine)).toBe(1);
        expect(life.installed).not.toContain('export PATH="');
        expect(occurrences(life.installed, "/.ru-code/bin")).toBe(2); // both inside the ONE line

        // FIXPOINT across cycles; ROUNDTRIP scrubs everything of ours.
        expect(life.installedTwice, "second install changed the bytes").toBe(life.installed);
        expect(life.afterFiveCycles, "bytes drifted across five cycles").toBe(life.installed);
        expect(life.uninstalled).not.toContain("/.ru-code/bin");

        // FUNCTION — the law this generation exists for: both shells resolve a FUNCTION and get
        // the version, while the wrapper FILE on PATH is not executable at all.
        expect(life.bashType, "bash must resolve ru-code as a function").toContain("function");
        expect(life.bashVersion).toContain("9.9.9");
        expect(life.bashPath, "the PATH guard must add the bin dir").toBe("YES");
        expect(life.zshType, "zsh must resolve ru-code as a function").toContain("function");
        expect(life.zshVersion).toContain("9.9.9");

        // DEDUP — repeated sourcing leaves exactly one PATH entry.
        expect(life.dedupCount).toBe("1");
      } finally {
        sb.cleanup();
      }
    });
  }

  it("bakes a single-quote-hostile node path correctly (rc_shq round-trip through a real launch)", () => {
    const sb = makeSandbox();
    try {
      const globals = seedRealBin(sb);
      sb.write(
        "home/we'rd/node",
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
        0o755,
      );
      globals.NODE_PATH = sb.path("home/we'rd/node");
      sb.write("home/.bashrc", "");
      const r = sourceEval(
        sb,
        [
          `add_path >/dev/null 2>&1; echo "add=$?"`,
          `env -i PATH="$PATH" HOME="$HOME" bash --norc --noprofile -c '. "$HOME/.bashrc"; ru-code --version'`,
        ].join("\n"),
        { globals },
      );
      expect(r.all).toContain("add=0");
      expect(r.all, "the quoted node path must survive baking").toContain("9.9.9");
      // The embedded quote is escaped as '\'' at its position INSIDE the path.
      expect(sb.read("app/.ru-code/bin/env.sh")).toContain(`we'\\''rd/node`);
    } finally {
      sb.cleanup();
    }
  });

  it("falls back to `node` from PATH when the baked node binary is gone", () => {
    const sb = makeSandbox();
    try {
      const globals = seedRealBin(sb);
      globals.NODE_PATH = sb.path("app/.ru-code/vanished-node"); // baked, then "moved away"
      sb.write("home/.bashrc", "");
      const r = sourceEval(
        sb,
        [
          `add_path >/dev/null 2>&1; echo "add=$?"`,
          `env -i PATH="$PATH" HOME="$HOME" bash --norc --noprofile -c '. "$HOME/.bashrc"; ru-code --version'`,
        ].join("\n"),
        { globals },
      );
      expect(r.all).toContain("add=0");
      expect(r.all, "the bare-node fallback must answer").toContain("9.9.9");
      // The degradation is journaled at install time — the (next-install) breadcrumb.
      expect(readLog(sb)).toContain("будет использовать node из PATH");
    } finally {
      sb.cleanup();
    }
  });
});

describe("sourced launcher degrades safely", () => {
  it("env.sh write failure → classic PATH line, install still succeeds", () => {
    const sb = makeSandbox();
    try {
      const globals = seedRealBin(sb);
      NodeFS.chmodSync(sb.path("app/.ru-code/bin"), 0o555); // bin dir suddenly unwritable
      sb.write("home/.bashrc", "# shell\n");
      const r = sourceEval(sb, `add_path >/dev/null 2>&1; echo "add=$?"`, { globals });
      NodeFS.chmodSync(sb.path("app/.ru-code/bin"), 0o755);
      expect(r.all).toContain("add=0");
      const rc = sb.read("home/.bashrc");
      expect(rc, "must fall back to the classic export").toContain(
        `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"`,
      );
      expect(rc).not.toContain("env.sh");
      expect(readLog(sb)).toContain("классическая строка PATH");
    } finally {
      sb.cleanup();
    }
  });

  it("a guarded line whose env.sh is missing is a silent no-op at shell startup", () => {
    const sb = makeSandbox();
    try {
      // The fixture SRC points into /foo — no env.sh exists there.
      sb.write("home/.bashrc", `${SRC}\nalias ll='ls -la'\n`);
      const r = sourceEval(
        sb,
        `env -i PATH="$PATH" HOME="$HOME" bash --norc --noprofile -c '. "$HOME/.bashrc"; echo "alive=$?"; type ru-code 2>/dev/null || echo "fn=absent"'`,
        { globals: RC_GLOBALS_SRC },
      );
      expect(r.status, r.all).toBe(0);
      expect(r.all).toContain("alive=0");
      expect(r.all).toContain("fn=absent");
      expect(r.all).not.toContain("No such file");
    } finally {
      sb.cleanup();
    }
  });
});

describe("sourced launcher on Git Bash (composition only — paths are MSYS-converted)", () => {
  it("composes the rc line and env.sh from the converted path", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(
        sb,
        [
          `BIN_DIR="C:/Users/dev/.ru-code/bin"`,
          `PATH_BIN="$(to_msys_path "$BIN_DIR")"`,
          `NODE_PATH="/c/Program Files/nodejs/node"`,
          `NODE_FLAGS="--experimental-sqlite"`,
          `rc_source_line "$PATH_BIN/env.sh"; echo`,
          `rc_env_content`,
        ].join("\n"),
        {
          globals: {
            OS: "windows",
            APP_DIR_NAME: ".ru-code",
            APP_BIN: "ru-code",
            APP_DISPLAY_NAME: "Ru Code",
            ENTRY_JS: "cli.js",
          },
        },
      );
      expect(r.status, r.all).toBe(0);
      expect(r.stdout).toContain(
        `[ -f "/c/Users/dev/.ru-code/bin/env.sh" ] && . "/c/Users/dev/.ru-code/bin/env.sh"`,
      );
      expect(r.stdout).toContain(`'/c/Program Files/nodejs/node' --experimental-sqlite`);
      // The cli.js path is a NODE argument → baked in node form (to_node_path), NOT MSYS form:
      // node.exe misreads "/c/..." as "<drive>:\c\..." when Git Bash path translation is off.
      // Shell-consumed lines (rc guard, node binary, PATH prepend) stay MSYS-form above/below.
      expect(r.stdout).toContain(`'C:/Users/dev/.ru-code/bin/cli.js'`);
      expect(r.stdout).not.toContain(`'/c/Users/dev/.ru-code/bin/cli.js'`);
      expect(r.stdout).toContain(`export PATH="/c/Users/dev/.ru-code/bin:$PATH"`);
    } finally {
      sb.cleanup();
    }
  });
});
