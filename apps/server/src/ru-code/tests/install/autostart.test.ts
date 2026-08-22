// ru-code: START_AFTER_INSTALL — the shipped installer LAUNCHES the app when it is done (this is
// what production ships; the repo default had drifted to off, which is why a locally built
// installer started nothing). The fake cli.js records the invocation — its args and whether stdin
// was a TTY — via RU_CODE_TEST_MARKER.
//
// The launch is the installer's FINAL, ISOLATED step: it runs in the FOREGROUND and waits for the
// launcher's one JSON line (no `setsid`, no `&` — those forked, broke the wait, and painted the
// banner after the shell prompt). What outlives the installer is the server child the launcher
// spawns detached, which is why the app-side assertions still poll (`waitForFile`).
//
// This file also carries the two ROLLBACK-BOUNDARY units (R3): a crash after COMMIT but before
// INSTALL_FINAL must still tear the install down, and a non-zero exit after that flag must leave a
// finished install completely alone.

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  runInstaller,
  shq,
  sourceEval,
  waitForFile,
  writeFakePreflight,
  writeFakeRelease,
} from "./harness.ts";
import { FAKE_LAUNCH_URL, makeLaunchFakeCli } from "./launchCli.ts";

describe("install START_AFTER_INSTALL", () => {
  it("launches the app after a fresh install — the shipped default, no env override", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");
      const marker = sb.path("started.marker");

      const r = runInstaller(sb, { preflight, env: { RU_CODE_TEST_MARKER: marker } });

      expect(r.status).toBe(0);
      expect(waitForFile(sb, "started.marker")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("a fresh install opens the browser — no --no-browser on the launch", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");
      const marker = sb.path("started.marker");

      runInstaller(sb, { preflight, env: { RU_CODE_TEST_MARKER: marker } });

      expect(waitForFile(sb, "started.marker")).toBe(true);
      expect(sb.read("started.marker")).not.toContain("--no-browser");
    } finally {
      sb.cleanup();
    }
  });

  // The documented install is `cat ru-code/install | bash`, so the installer's own stdin is the
  // script pipe. Handing that pipe to the app is how a launched app died the moment the installer
  // finished — the launch redirects stdin from /dev/null instead.
  it("the launched app does not inherit the installer's stdin", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");
      const marker = sb.path("started.marker");

      runInstaller(sb, { preflight, env: { RU_CODE_TEST_MARKER: marker } });

      expect(waitForFile(sb, "started.marker")).toBe(true);
      expect(sb.read("started.marker")).toContain("tty=false");
    } finally {
      sb.cleanup();
    }
  });

  it("INSTALL_START_AFTER=false suppresses the launch", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");
      const marker = sb.path("started.marker");

      const r = runInstaller(sb, {
        preflight,
        env: { INSTALL_START_AFTER: "false", RU_CODE_TEST_MARKER: marker },
      });

      expect(r.status).toBe(0);
      // Give a launch that should NOT happen the same window a real one would have used.
      expect(waitForFile(sb, "started.marker", 1_000)).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install launch — the JSON contract", () => {
  /** A fake release whose payload answers `--json` with the one-line launch contract. */
  const withJsonLauncher = (sb: ReturnType<typeof makeSandbox>): string => {
    writeFakeRelease(sb, { version: "1.0.0", cliScript: makeLaunchFakeCli("1.0.0") });
    sb.write("home/.bashrc", "# shell\n");
    return writeFakePreflight(sb, { ourRoot: sb.appRoot });
  };

  it("RAN: the launcher is invoked with --json and its url reaches the started banner", () => {
    const sb = makeSandbox();
    try {
      const preflight = withJsonLauncher(sb);

      const r = runInstaller(sb, {
        preflight,
        env: {
          RU_CODE_TEST_LAUNCH_PROBE: sb.path("launch-probe.json"),
          RU_CODE_TEST_CLONE_DIR: sb.cloneDir,
        },
      });

      expect(r.status).toBe(0);
      expect(JSON.parse(sb.read("launch-probe.json")).args).toEqual(["--json"]);
      expect(r.all).toContain("Запущено");
      expect(r.all).toContain(FAKE_LAUNCH_URL);
    } finally {
      sb.cleanup();
    }
  });

  it("DID NOT RUN: the launcher is never invoked and the classic card is shown instead", () => {
    const sb = makeSandbox();
    try {
      const preflight = withJsonLauncher(sb);

      const r = runInstaller(sb, {
        preflight,
        env: {
          INSTALL_START_AFTER: "false",
          RU_CODE_TEST_LAUNCH_PROBE: sb.path("launch-probe.json"),
          RU_CODE_TEST_CLONE_DIR: sb.cloneDir,
        },
      });

      expect(r.status).toBe(0);
      expect(sb.exists("launch-probe.json")).toBe(false);
      expect(r.all).toContain("Перезапустите терминал и выполните команду:");
      expect(r.all).not.toContain("Запускаю приложение");
    } finally {
      sb.cleanup();
    }
  });

  // The field case the node-direct launch exists for: a machine where executing sh scripts from
  // <bin> is denied. The fake breaks the wrapper (chmod 000) during verify_app's `--version` —
  // i.e. AFTER create_wrapper, BEFORE launch_app — and the launch must still succeed, because
  // the installer never executes the wrapper.
  it("launches even when the sh wrapper cannot be executed (node-direct, the blocked-<bin> machine)", () => {
    const sb = makeSandbox();
    try {
      const preflight = withJsonLauncher(sb);

      const r = runInstaller(sb, {
        preflight,
        env: {
          RU_CODE_TEST_LAUNCH_PROBE: sb.path("launch-probe.json"),
          RU_CODE_TEST_CLONE_DIR: sb.cloneDir,
          RU_CODE_TEST_BREAK_WRAPPER: sb.path("app/.ru-code/bin/ru-code"),
        },
      });

      expect(r.status).toBe(0);
      expect(JSON.parse(sb.read("launch-probe.json")).args).toEqual(["--json"]);
      expect(r.all).toContain("Запущено");
      expect(r.all).toContain(FAKE_LAUNCH_URL);
    } finally {
      sb.cleanup();
    }
  });

  it("a failed launch shows the failure banner, the daemon log and NOT the launcher's error text", () => {
    const sb = makeSandbox();
    try {
      const preflight = withJsonLauncher(sb);

      const r = runInstaller(sb, {
        preflight,
        env: {
          RU_CODE_TEST_LAUNCH_FAIL: "1",
          RU_CODE_TEST_LAUNCH_PROBE: sb.path("launch-probe.json"),
          RU_CODE_TEST_CLONE_DIR: sb.cloneDir,
        },
      });

      // A launch that failed does NOT fail the install — the app is on disk either way.
      expect(r.status).toBe(0);
      expect(r.all).toContain("Ошибка");
      expect(r.all).toContain("userdata/daemon.log");
      expect(r.all).not.toContain(FAKE_LAUNCH_URL);
      expect(r.all).not.toContain("EADDRINUSE"); // the launcher's `error` field is never parsed
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

// A "successful" install that starts nothing and says nothing is the worst possible outcome — the
// user concludes the app is broken. Both skip conditions must be LOUD on screen and in the journal.
// (The launch itself is node-direct; the wrapper matters only as the last-resort fallback, so the
// skip fires when BOTH the entry and the wrapper are unusable.)
describe("install launch — loud skip when the shim is unusable", () => {
  const runLaunchApp = (
    sb: ReturnType<typeof makeSandbox>,
    globals: Record<string, string> = {},
  ): ReturnType<typeof sourceEval> =>
    sourceEval(sb, `launch_app`, {
      globals: {
        BIN_DIR: sb.path("app/.ru-code/bin"),
        APP_ROOT: sb.appRoot,
        APP_BIN: "ru-code",
        LOGFILE: sb.path("launch.log"),
        TTY: "0",
        TRUECOLOR: "0",
        ...globals,
      },
    });

  it("entry + node present ⇒ node-direct launch, the wrapper is never executed", () => {
    const sb = makeSandbox();
    try {
      sb.write(
        "app/.ru-code/bin/cli.js",
        `process.stdout.write(JSON.stringify({ ok: true, url: "http://127.0.0.1:7317/pair" }) + "\\n");\n`,
      );
      // A booby-trapped wrapper: executing it would poison the JSON line and fail the banner.
      sb.write("app/.ru-code/bin/ru-code", "#!/bin/sh\necho WRAPPER_EXECUTED\nexit 1\n", 0o755);

      const r = runLaunchApp(sb, { NODE_PATH: process.execPath, NODE_FLAGS: "" });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Запущено");
      expect(r.stdout).not.toContain("WRAPPER_EXECUTED");
      expect(sb.read("launch.log")).toContain(`launch: ${process.execPath}`);
    } finally {
      sb.cleanup();
    }
  });

  it("the shim is MISSING → says so, names the path, and falls back to the classic card", () => {
    const sb = makeSandbox();
    try {
      const r = runLaunchApp(sb);

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Не удалось запустить приложение автоматически");
      expect(r.stdout).toContain(sb.path("app/.ru-code/bin/ru-code"));
      expect(r.stdout).toContain("Перезапустите терминал и выполните команду:");
      expect(sb.read("launch.log")).toContain("launch skipped");
    } finally {
      sb.cleanup();
    }
  });

  it("the shim is present but NOT EXECUTABLE → the same loud skip, never a silent success", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/ru-code", "#!/bin/sh\nexit 0\n", 0o644);

      const r = runLaunchApp(sb);

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Не удалось запустить приложение автоматически");
      expect(r.stdout).toContain("Запустите вручную: ru-code");
      expect(sb.read("launch.log")).toContain("launch skipped");
    } finally {
      sb.cleanup();
    }
  });
});

// R3 — INSTALL_FINAL draws the line between "an interrupted install must be undone" and "a finished
// install must never be touched again". Both sides are asserted, because setting the flag one call
// too early (inside render_outcome) would silently disable rollback for blocked and crashed runs.
describe("install rollback boundary (INSTALL_FINAL)", () => {
  it("BEFORE the flag: a crash after COMMIT still rolls back bin/ and the rc line", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb, { cliVersionExit: 1 }); // verify_app dies AFTER install_files + add_path
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).not.toBe(0);
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("AFTER the flag: a non-zero exit leaves bin/ and the rc line intact", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/cli.js", "process.exit(0);\n");
      sb.write("home/.bashrc", `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"\n# keep\n`);

      // Drive the exit trap directly with a failing status — the one thing a black-box run cannot
      // stage, since the installer's own exit code after the flag is the card's (0).
      const r = sourceEval(sb, `( exit 7 ); on_exit`, {
        globals: {
          BIN_DIR: sb.path("app/.ru-code/bin"),
          APP_DIR_NAME: ".ru-code",
          APP_BIN: "ru-code",
          LOGFILE: sb.path("trap.log"),
          COMMITTED: "1",
          INSTALL_FINAL: "1",
          CARD_SHOWN: "1",
          LOCK_ACQUIRED: "0",
          TTY: "0",
        },
      });

      expect(r.status).toBe(7); // on_exit passes the inherited status through untouched
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(sb.read("home/.bashrc")).toContain(".ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("the SAME exit with the flag DOWN does roll back — the flag is what makes the difference", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/cli.js", "process.exit(0);\n");
      sb.write("home/.bashrc", `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"\n# keep\n`);

      const r = sourceEval(sb, `( exit 7 ); on_exit`, {
        globals: {
          BIN_DIR: sb.path("app/.ru-code/bin"),
          APP_DIR_NAME: ".ru-code",
          APP_BIN: "ru-code",
          LOGFILE: sb.path("trap.log"),
          COMMITTED: "1",
          INSTALL_FINAL: "0",
          CARD_SHOWN: "1",
          LOCK_ACQUIRED: "0",
          TTY: "0",
        },
      });

      expect(r.status).toBe(7);
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin");
      expect(sb.read("home/.bashrc")).toContain("# keep");
    } finally {
      sb.cleanup();
    }
  });

  it("launch_interrupted renders the interrupted banner and exits 0 (never a crash card)", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `launch_interrupted; echo UNREACHABLE`, {
        globals: { APP_BIN: "ru-code", TTY: "0", TRUECOLOR: "0", LOGFILE: sb.path("x.log") },
      });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Прервано");
      expect(r.stdout).toContain("возможно, приложение уже запущено");
      expect(r.stdout).not.toContain("UNREACHABLE");
      expect(r.stdout).not.toContain("Что-то пошло не так");
    } finally {
      sb.cleanup();
    }
  });
});

// The parser is deliberately narrow: `ok` and `url` only, by bash pattern matching — never `error`,
// whose free-form English text is exactly where a shell parser breaks. Exercised through the REAL
// `launch_app` (a stand-in launcher prints the line), so what is asserted is the shipped decision,
// not a copy of it.
describe("install launch — the JSON line the installer parses", () => {
  const launchPrinting = (
    sb: ReturnType<typeof makeSandbox>,
    line: string,
    exitCode = 0,
  ): ReturnType<typeof sourceEval> => {
    sb.write(
      "app/.ru-code/bin/ru-code",
      `#!/bin/sh\nprintf '%s\\n' ${shq(line)}\nexit ${exitCode}\n`,
      0o755,
    );
    return sourceEval(sb, `launch_app`, {
      globals: {
        BIN_DIR: sb.path("app/.ru-code/bin"),
        APP_ROOT: sb.appRoot,
        APP_BIN: "ru-code",
        LOGFILE: sb.path("launch.log"),
        TTY: "0",
        TRUECOLOR: "0",
      },
    });
  };

  it("a success line lights the started banner and prints its url", () => {
    const sb = makeSandbox();
    try {
      const r = launchPrinting(
        sb,
        JSON.stringify({ ok: true, url: FAKE_LAUNCH_URL, version: "1.0.0", pid: 42 }),
      );

      expect(r.stdout).toContain("Запущено");
      expect(r.stdout).toContain(FAKE_LAUNCH_URL);
    } finally {
      sb.cleanup();
    }
  });

  it("a failure line is a failure whatever its error text says — and nothing in it is executed", () => {
    const sb = makeSandbox();
    try {
      const r = launchPrinting(
        sb,
        JSON.stringify({
          ok: false,
          error: `"url":"http://evil/" ' \\ $(touch pwned) ; rm -rf . `,
          log: "/x/userdata/daemon.log",
        }),
        1,
      );

      expect(r.stdout).toContain("Ошибка");
      expect(r.stdout).not.toContain("evil");
      expect(r.stdout).not.toContain("rm -rf");
      expect(sb.exists("pwned")).toBe(false); // no eval, no re-expansion of the captured line
    } finally {
      sb.cleanup();
    }
  });

  it("a launcher that printed nothing is a failure, not a silent success", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/ru-code", `#!/bin/sh\nexit 1\n`, 0o755);

      const r = sourceEval(sb, `launch_app`, {
        globals: {
          BIN_DIR: sb.path("app/.ru-code/bin"),
          APP_ROOT: sb.appRoot,
          APP_BIN: "ru-code",
          LOGFILE: sb.path("launch.log"),
          TTY: "0",
          TRUECOLOR: "0",
        },
      });

      expect(r.stdout).toContain("Ошибка");
      expect(r.stdout).toContain("userdata/daemon.log");
    } finally {
      sb.cleanup();
    }
  });
});
