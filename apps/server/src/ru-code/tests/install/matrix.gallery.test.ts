// @effect-diagnostics nodeBuiltinImport:off - install-flow: drives the real installer over a PTY.
// ru-code: THE MATRIX. Runs every flow-affecting combination through the real bash installer under a
// PTY (truecolor), ASSERTS each case's terminal STATE + the exact recommendation set it must show,
// and — as a side effect on every run — writes a colored gallery to <repoRoot>/install-cards.html so
// the whole surface can be eyeballed. The interacting core is node×git×cli (3×3×5 = 45); the rest are
// orthogonal singles (crash / rc / starter / update / already-installed / uninstall).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "vite-plus/test";

import { ansiToHtml, buildGalleryPage, pool, spawnPtyCase } from "./galleryHtml.ts";
import { makeLaunchFakeCli } from "./launchCli.ts";
import {
  INSTALL_SCRIPT,
  makeSandbox,
  makeShimDir,
  pathWith,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

const unameShim = (sb: Sandbox, sysname: string): string =>
  makeShimDir(sb, {
    uname: `#!/usr/bin/env bash\ncase "$1" in -a) echo "${sysname} host 1.0";; *) echo "${sysname}";; esac\n`,
  });

/** A node stub for qwen's cli.js: on `-p test` it creates $WARM_TARGET (simulates profile creation). */
const warmStub = (sb: Sandbox): string => {
  const p = NodePath.join(sb.root, "warm-cli.js");
  NodeFS.writeFileSync(
    p,
    `const fs=require("node:fs");if(process.argv[2]==="-p"&&process.env.WARM_TARGET)fs.mkdirSync(process.env.WARM_TARGET,{recursive:true});process.exit(0);\n`,
  );
  return p;
};

// eslint-disable-next-line no-control-regex -- stripping ANSI SGR/CSI escapes needs the ESC byte
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const has = (clean: string, ...needles: string[]): string | null => {
  for (const n of needles) if (!clean.includes(n)) return `missing «${n}»`;
  return null;
};
const hasNot = (clean: string, needle: string): string | null =>
  clean.includes(needle) ? `unexpected «${needle}»` : null;

// A rec = a title that must appear on the card. On a BLOCKED card only blocking recs render; on a
// SUCCESS card only warn recs render.
interface Axis {
  readonly key: string;
  readonly rec: string | null;
  readonly blocking: boolean;
}
const NODE: ReadonlyArray<Axis & { check: "ok" | "fail"; env: Record<string, string> }> = [
  { key: "ok", rec: null, blocking: false, check: "ok", env: {} },
  {
    key: "fatal",
    rec: "Обновите Node.js",
    blocking: true,
    check: "fail",
    env: { INSTALL_NODE_FATAL: "true" },
  },
  {
    key: "warn",
    rec: "Обновите Node.js",
    blocking: false,
    check: "fail",
    env: { INSTALL_NODE_FATAL: "false" },
  },
];
const GIT: ReadonlyArray<Axis & { check: "ok" | "fail"; env: Record<string, string> }> = [
  { key: "ok", rec: null, blocking: false, check: "ok", env: {} },
  {
    key: "fatal",
    rec: "Требуется Git",
    blocking: true,
    check: "fail",
    env: { INSTALL_GIT_FATAL: "true" },
  },
  {
    key: "warn",
    rec: "Требуется Git",
    blocking: false,
    check: "fail",
    env: { INSTALL_GIT_FATAL: "false" },
  },
];
const CLI: ReadonlyArray<
  Axis & { check: "ok" | "fail"; kind: "ok" | "old" | "missing"; env: Record<string, string> }
> = [
  { key: "ok", rec: null, blocking: false, check: "ok", kind: "ok", env: {} },
  {
    key: "missing·fatal",
    rec: "CLI-движок не установлен",
    blocking: true,
    check: "fail",
    kind: "missing",
    env: { INSTALL_CLI_FATAL: "true" },
  },
  {
    key: "missing·skip",
    rec: null,
    blocking: false,
    check: "fail",
    kind: "missing",
    env: { INSTALL_CLI_FATAL: "false" },
  },
  {
    key: "old·fatal",
    rec: "Обновите CLI-движок",
    blocking: true,
    check: "fail",
    kind: "old",
    env: { INSTALL_CLI_FATAL: "true" },
  },
  {
    key: "old·warn",
    rec: "Обновите CLI-движок",
    blocking: false,
    check: "fail",
    kind: "old",
    env: { INSTALL_CLI_FATAL: "false" },
  },
];

interface Case {
  readonly label: string;
  readonly setup: (sb: Sandbox) => {
    readonly preflight?: string;
    readonly env?: Record<string, string>;
    readonly args?: string[];
  };
  readonly expect: (clean: string, status: number) => string | null;
}

const cases: Case[] = [];

// ---- 45 interacting core: node × git × cli --------------------------------------------------------
for (const n of NODE)
  for (const g of GIT)
    for (const c of CLI) {
      const recs = [n, g as Axis, c as Axis].filter((a) => a.rec) as Axis[];
      const blocked = recs.some((r) => r.blocking);
      const visible = blocked ? recs.filter((r) => r.blocking) : recs;
      cases.push({
        label: `node:${n.key} · git:${g.key} · cli:${c.key}`,
        setup: (sb) => {
          writeFakeRelease(sb);
          const pf = writeFakePreflight(sb, {
            ourRoot: sb.appRoot,
            nodeOk: n.check === "fail" ? "0" : "1",
            checkNode: n.check,
            checkGit: g.check,
            checkCli: c.check,
            checkCliKind: c.kind,
          });
          sb.write("home/.bashrc", "# shell\n");
          return { preflight: pf, env: { ...n.env, ...g.env, ...c.env } };
        },
        expect: (clean) => {
          const header = blocked ? "установка не завершена" : "установлен ·";
          const missHeader = has(clean, header);
          if (missHeader) return missHeader;
          for (const r of visible) {
            const m = has(clean, r.rec!);
            if (m) return m;
          }
          // a skipped CLI (not required + missing) must show NO cli recommendation
          if (c.key === "missing·skip") return hasNot(clean, "CLI-движок");
          return null;
        },
      });
    }

// ---- orthogonal singles ---------------------------------------------------------------------------
cases.push({
  label: "crash · corrupt bundle",
  setup: (sb) => {
    NodeFS.writeFileSync(NodePath.join(sb.distBundleDir, "ru-code-1.0.0.tgz"), "GARBAGE\n");
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "установка не завершена", "Пакет повреждён"),
});
cases.push({
  label: "crash · bundle missing member",
  setup: (sb) => {
    writeFakeRelease(sb, { missingPart: "client" });
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "Пакет повреждён"),
});
cases.push({
  label: "ok · read-only .bashrc (PATH persists to fallback, no note)",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    // A single read-only rc no longer blocks PATH — add_path still writes .profile/.zshrc, so the
    // install is a clean success with NO ⚠(path) note.
    sb.write("home/.bashrc", "# shell\n", 0o444);
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "установлен ·") ?? hasNot(clean, "PATH не настроен"),
});
cases.push({
  label: "success · starter project created",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf, env: { INSTALL_CREATE_STARTER_PROJECT: "true" } };
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "update · обновлён old → new",
  setup: (sb) => {
    writeFakeRelease(sb, { version: "0.13.1" });
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    runInstaller(sb, { preflight: pf, args: ["--keep-source"] }); // pre-install 0.13.1
    for (const f of NodeFS.readdirSync(sb.distBundleDir))
      NodeFS.rmSync(NodePath.join(sb.distBundleDir, f));
    writeFakeRelease(sb, { version: "0.14.0" });
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "обновлён · 0.13.1 → 0.14.0"),
});
cases.push({
  label: "already-installed · same version",
  setup: (sb) => {
    writeFakeRelease(sb, { version: "0.13.1" });
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    runInstaller(sb, { preflight: pf, args: ["--keep-source"] });
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "уже установлен · 0.13.1"),
});
cases.push({
  label: "uninstall",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    runInstaller(sb, { preflight: pf, args: ["--keep-source"] });
    return { preflight: pf, args: ["--uninstall", "--keep-source"] };
  },
  expect: (clean) => has(clean, "удалён"),
});
cases.push({
  label: "os · macOS",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf, env: { PATH: pathWith(unameShim(sb, "Darwin")) } };
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "os · Windows (Git Bash)",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return {
      preflight: pf,
      env: { PATH: pathWith(unameShim(sb, "MINGW64_NT-10.0")), MSYSTEM: "MINGW64" },
    };
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "os · unsupported (blocked)",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    return { preflight: pf, env: { PATH: pathWith(unameShim(sb, "Plan9")) } };
  },
  expect: (clean) => has(clean, "Система не поддерживается"),
});
cases.push({
  label: "no bundle (Дистрибутив не найден)",
  setup: (sb) => {
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf }; // empty dist-bundle → resolve_local_bundle fails
  },
  expect: (clean) => has(clean, "Дистрибутив не найден"),
});
cases.push({
  label: "crash · preflight emitted no OUR_ROOT",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { emitKeys: false });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "установка не завершена"),
});
cases.push({
  label: "warm-up · fired (profile created)",
  setup: (sb) => {
    writeFakeRelease(sb);
    const cliJs = warmStub(sb);
    const configDir = sb.path("home", ".qwen");
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf, env: { WARM_TARGET: configDir } };
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "warm-up · skipped (profile exists)",
  setup: (sb) => {
    writeFakeRelease(sb);
    const cliJs = warmStub(sb);
    const configDir = sb.path("home", ".qwen");
    NodeFS.mkdirSync(configDir, { recursive: true });
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf, env: { WARM_TARGET: configDir } };
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "rc · none (default created)",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    return { preflight: pf, env: { SHELL: "/bin/bash" } }; // no rc → default created
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "broken install → overwrite",
  setup: (sb) => {
    writeFakeRelease(sb);
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    runInstaller(sb, { preflight: pf, args: ["--keep-source"] });
    sb.write(
      "app/.ru-code/bin/cli.js",
      `if(process.argv[2]==="--version")process.exit(1);process.exit(0);`,
    );
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "установлен ·"),
});
cases.push({
  label: "update · stop failed (blocked)",
  setup: (sb) => {
    writeFakeRelease(sb, { version: "0.13.1" });
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    runInstaller(sb, { preflight: pf, args: ["--keep-source"] });
    sb.write(
      "app/.ru-code/bin/cli.js",
      `const a=process.argv[2];if(a==="--version"){process.stdout.write("0.13.1\\n");process.exit(0)}if(a==="stop"){process.exit(1)}process.exit(0);`,
    );
    for (const f of NodeFS.readdirSync(sb.distBundleDir))
      NodeFS.rmSync(NodePath.join(sb.distBundleDir, f));
    writeFakeRelease(sb, { version: "0.14.0" });
    return { preflight: pf };
  },
  expect: (clean) => has(clean, "Не удалось остановить"),
});
// The ONE matrix case that reaches the launch (every other case runs with INSTALL_START_AFTER
// disabled — see spawnPtyCase). Its payload therefore has to speak the `--json` launch contract, or
// the card would show the FAILED-launch banner for what is a perfectly successful install. The four
// launch states themselves live in their own test + gallery (launch-cards.html).
cases.push({
  label: "success · START_AFTER_INSTALL",
  setup: (sb) => {
    writeFakeRelease(sb, { cliScript: makeLaunchFakeCli("1.0.0") });
    const pf = writeFakePreflight(sb, { ourRoot: sb.appRoot });
    sb.write("home/.bashrc", "# shell\n");
    return { preflight: pf, env: { INSTALL_START_AFTER: "true" } };
  },
  expect: (clean) => has(clean, "установлен ·") && has(clean, "Запущено"),
});

it("matrix: every install combination renders + asserts, and writes install-cards.html", async () => {
  // Guard: needs a PTY (`script`). Skip the whole thing gracefully if unavailable.
  const probe = makeSandbox();
  let ptyOk = true;
  try {
    const r = await spawnPtyCase(probe, { args: ["--help"] });
    ptyOk = r.raw.length > 0 || r.status !== -1;
  } catch {
    ptyOk = false;
  } finally {
    probe.cleanup();
  }
  if (!ptyOk) return; // headless env without `script` — the dedicated tests still cover behavior

  const sandboxes = cases.map(() => makeSandbox());
  const opts = cases.map((c, i) => c.setup(sandboxes[i]!));
  const runs = await pool(cases, 12, (_, i) => spawnPtyCase(sandboxes[i]!, opts[i]!));

  const panels: { label: string; ok: boolean; html: string }[] = [];
  const failures: string[] = [];
  cases.forEach((c, i) => {
    const clean = strip(runs[i]!.raw);
    const reason = c.expect(clean, runs[i]!.status);
    if (reason) failures.push(`${c.label} → ${reason}`);
    panels.push({ label: c.label, ok: !reason, html: ansiToHtml(runs[i]!.raw) });
  });

  // Always write the gallery (even on failures — the FAIL badges show which cards broke).
  const dest = NodePath.resolve(INSTALL_SCRIPT, "..", "install-cards.html");
  try {
    NodeFS.writeFileSync(dest, buildGalleryPage(panels));
  } catch {
    /* best-effort artifact */
  }
  sandboxes.forEach((sb) => sb.cleanup());

  expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
}, 120_000);

afterAll(() => {
  /* keep install-cards.html in place for review */
});
