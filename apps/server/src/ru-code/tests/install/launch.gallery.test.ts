// @effect-diagnostics nodeBuiltinImport:off - install-flow: drives the real installer over a PTY.
// ru-code: THE LAUNCH GALLERY. The installer's FINAL step — starting the app it just installed — has
// exactly four outcomes (§3.5), and this file runs all four through the real bash installer under a
// PTY, asserts each banner, and writes <repoRoot>/SPECS/e2e-runs/terminal-cards/launch-cards.html so they can be eyeballed side by
// side. Deliberately SEPARATE from matrix.gallery.test.ts: `install-cards.html` stays a pure
// installer-output matrix (its base env turns the launch off), this one is only about the launch.
//
// Everything is driven by the fast fake CLI in ./launchCli.ts — it prints the one JSON line the
// launch contract promises and exits. No sockets, no daemon, no timers: milliseconds per case.
//
// It also carries the CLONE-CLEANUP invariant (C10). The clone dir is removed BEFORE the launch, and
// the only honest place to observe "before" is inside the launch itself — so the fake records
// `cloneExists` from within, and the test asserts the dir is gone at that moment AND afterwards.
// The `--keep-source` case is the counterexample: kept at both points, deliberately.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { ansiToHtml, buildGalleryPage, pool, spawnPtyCase } from "./galleryHtml.ts";
import { FAKE_LAUNCH_URL, lockPidFile, makeLaunchFakeCli, type LaunchProbe } from "./launchCli.ts";
import {
  INSTALL_SCRIPT,
  makeSandbox,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

const VERSION = "1.0.0";

// eslint-disable-next-line no-control-regex -- stripping ANSI SGR/CSI escapes needs the ESC byte
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** Case setup shared by every launch state: a fake release whose payload speaks `--json`. */
const prepare = (
  sb: Sandbox,
): { readonly preflight: string; readonly env: Record<string, string> } => {
  writeFakeRelease(sb, { version: VERSION, cliScript: makeLaunchFakeCli(VERSION) });
  const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
  sb.write("home/.bashrc", "# shell\n");
  return {
    preflight,
    env: {
      INSTALL_START_AFTER: "true",
      RU_CODE_TEST_LAUNCH_PROBE: sb.path("launch-probe.json"),
      RU_CODE_TEST_CLONE_DIR: sb.cloneDir,
    },
  };
};

/** The record the fake wrote from inside the launch, or null when the launch never ran. */
const readProbe = (sb: Sandbox): LaunchProbe | null =>
  sb.exists("launch-probe.json") ? (JSON.parse(sb.read("launch-probe.json")) as LaunchProbe) : null;

interface LaunchCase {
  readonly label: string;
  readonly setup: (sb: Sandbox) => {
    readonly preflight: string;
    readonly env: Record<string, string>;
    readonly args: ReadonlyArray<string>;
  };
  readonly check: (out: string, sb: Sandbox, status: number) => void;
}

const cases: LaunchCase[] = [
  {
    label: "1 · запущено — the launcher answered ok",
    setup: (sb) => ({ ...prepare(sb), args: [] }),
    check: (out, sb) => {
      expect(out).toContain("Запущено");
      expect(out).toContain(FAKE_LAUNCH_URL);
      expect(out).toContain("Если браузер не открылся");
      expect(out).toContain("Запускаю приложение");
      // the classic «перезапустите терминал» card belongs to state 4 only
      expect(out).not.toContain("Перезапустите терминал");

      const probe = readProbe(sb);
      expect(probe?.args).toContain("--json");
      // §3.4: the installer ALWAYS launches with the browser
      expect(probe?.args).not.toContain("--no-browser");
      expect(probe?.stdinTty).toBe(false);
      // C10 — gone BEFORE the launch (observed from inside it) and gone after
      expect(probe?.cloneExists).toBe(false);
      expect(sb.exists("ru-code")).toBe(false);
    },
  },
  {
    label: "2 · ошибка — the launcher answered ok:false",
    setup: (sb) => {
      const base = prepare(sb);
      return { ...base, env: { ...base.env, RU_CODE_TEST_LAUNCH_FAIL: "1" }, args: [] };
    },
    check: (out, sb) => {
      expect(out).toContain("Ошибка");
      expect(out).toContain("не удалось его запустить");
      expect(out).toContain(NodePath.join("userdata", "daemon.log"));
      // NO link, and not one character of the launcher's English `error` text
      expect(out).not.toContain(FAKE_LAUNCH_URL);
      expect(out).not.toContain("EADDRINUSE");
      expect(out).not.toContain("port 7317");
      expect(readProbe(sb)?.cloneExists).toBe(false);
      expect(sb.exists("ru-code")).toBe(false);
    },
  },
  {
    label: "3 · прервано — Ctrl+C while waiting",
    setup: (sb) => {
      const base = prepare(sb);
      return {
        ...base,
        env: { ...base.env, RU_CODE_TEST_LAUNCH_SIGINT: lockPidFile(sb.home) },
        args: [],
      };
    },
    check: (out, sb, status) => {
      expect(out).toContain("Прервано");
      expect(out).toContain("возможно, приложение уже запущено");
      // an interrupt AFTER the install is complete is not a failure — and never a rollback
      expect(status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(sb.read("home/.bashrc")).toContain(".ru-code/bin");
      expect(readProbe(sb)?.cloneExists).toBe(false);
      expect(sb.exists("ru-code")).toBe(false);
    },
  },
  {
    label: "4 · запуск не выполнялся — INSTALL_START_AFTER=false (classic card)",
    setup: (sb) => {
      const base = prepare(sb);
      return { ...base, env: { ...base.env, INSTALL_START_AFTER: "false" }, args: [] };
    },
    check: (out, sb) => {
      expect(out).toContain("Перезапустите терминал и выполните команду:");
      expect(out).not.toContain("Запускаю приложение");
      expect(out).not.toContain("Запущено");
      // §3.5: the classic card MOVED below the credits on the success path
      expect(out.indexOf("MIT License")).toBeLessThan(out.indexOf("Перезапустите терминал"));
      expect(readProbe(sb)).toBe(null);
      expect(sb.exists("ru-code")).toBe(false);
    },
  },
  {
    label: "5 · --keep-source — the clone is deliberately kept",
    setup: (sb) => ({ ...prepare(sb), args: ["--keep-source"] }),
    check: (out, sb) => {
      expect(out).toContain("Запущено");
      // kept at BOTH points: during the launch and after the installer exits
      expect(readProbe(sb)?.cloneExists).toBe(true);
      expect(sb.exists("ru-code")).toBe(true);
    },
  },
];

it("launch: the four launch states render + assert, and write launch-cards.html", async () => {
  // Guard: needs a PTY (`script`). Skip gracefully where it is unavailable — autostart.test.ts
  // still covers the behaviour without colour.
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
  if (!ptyOk) return;

  const sandboxes = cases.map(() => makeSandbox());
  const opts = cases.map((c, i) => c.setup(sandboxes[i]!));
  const runs = await pool(cases, 5, (_, i) =>
    spawnPtyCase(sandboxes[i]!, {
      preflight: opts[i]!.preflight,
      env: opts[i]!.env,
      args: opts[i]!.args,
    }),
  );

  const panels: { label: string; ok: boolean; html: string }[] = [];
  const failures: string[] = [];
  cases.forEach((c, i) => {
    let reason: string | null = null;
    try {
      c.check(strip(runs[i]!.raw), sandboxes[i]!, runs[i]!.status);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      failures.push(`${c.label} → ${reason}`);
    }
    panels.push({ label: c.label, ok: reason === null, html: ansiToHtml(runs[i]!.raw) });
  });

  const dest = NodePath.resolve(
    INSTALL_SCRIPT,
    "..",
    "SPECS/e2e-runs/terminal-cards",
    "launch-cards.html",
  );
  try {
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.writeFileSync(dest, buildGalleryPage(panels, "Launch cards"));
  } catch {
    /* best-effort artifact */
  }
  sandboxes.forEach((sb) => sb.cleanup());

  expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
}, 120_000);
