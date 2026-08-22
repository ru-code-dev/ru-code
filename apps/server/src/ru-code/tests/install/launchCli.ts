// ru-code: the FAST FAKE CLI that stands in for the daemon launcher in the launch-after-install
// tests. The installer launches NODE-DIRECT — `"$NODE_PATH" $NODE_FLAGS <bin>/cli.js --json`
// (never the `ru-code` sh wrapper, which is exactly the file execve-denying machines block) —
// and waits for exactly ONE line on stdout, so a faithful fake needs nothing but that line: no
// sockets, no ports, no daemon, milliseconds per case.
//
// It is installed the way the real thing is: as the version payload's `cli.js` inside the fake
// release (`writeFakeRelease({ cliScript })`), so every run goes through the REAL frozen JS
// wrapper (`<bin>/cli.js` → pointer → `versions/<v>/cli.js`) before reaching it.
//
// Behaviour is picked by env, one variant per launch state:
//   (default)                     → {"ok":true,…}  exit 0        → banner 1 «Запущено»
//   RU_CODE_TEST_LAUNCH_FAIL=1    → {"ok":false,…} exit 1        → banner 2 «Ошибка»
//   RU_CODE_TEST_LAUNCH_SIGINT=<f>→ SIGINT the installer, exit 0 → banner 3 «Прервано»
// and `RU_CODE_TEST_LAUNCH_PROBE` records, from INSIDE the launch, the argv it was given and whether
// the clone dir still exists — that is the only place the "clone is gone BEFORE the launch" invariant
// can honestly be observed.

/** The pairing url the ok-variant reports; the started banner must print it verbatim. */
export const FAKE_LAUNCH_URL = "http://127.0.0.1:7317/pair?token=abc123";

/**
 * The `error` text of the failure variant. It deliberately carries a double quote, a backslash and
 * a newline — every character a shell-side JSON parser would break on. The installer must never
 * read this field, and none of it may ever reach the screen.
 */
export const FAKE_LAUNCH_ERROR = 'boom: "port 7317" busy\\\nlisten EADDRINUSE';

/** What the fake writes to `RU_CODE_TEST_LAUNCH_PROBE`, one JSON object. */
export interface LaunchProbe {
  /** argv the launcher was invoked with — `--json` must be there, `--no-browser` must not. */
  readonly args: ReadonlyArray<string>;
  /** Did the installer's clone dir still exist at the moment the launch ran? */
  readonly cloneExists: boolean;
  /** Was stdin a TTY? Must be false — the launch redirects from /dev/null. */
  readonly stdinTty: boolean;
}

/**
 * Source for the version payload's `cli.js`. Answers `--version` (verify_app,
 * read_installed_version) and `stop` (confirmed_stop) exactly like the default fake, then branches
 * on the launch env. CommonJS `require` on purpose: node's syntax detection keeps this file CJS, and
 * the frozen wrapper `await import()`s it happily either way.
 */
export const makeLaunchFakeCli = (version: string): string =>
  [
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    // The field-repro seam: verify_app runs `--version` (node-direct) BEFORE launch_app, so
    // breaking the sh wrapper here models the machine where <bin> scripts cannot be executed —
    // the node-direct launch that follows must still succeed.
    `if (args[0] === "--version") {`,
    `  const breakWrapper = process.env.RU_CODE_TEST_BREAK_WRAPPER;`,
    `  if (breakWrapper) fs.chmodSync(breakWrapper, 0o000);`,
    `  process.stdout.write("ru-code v${version}\\n");`,
    `  process.exit(0);`,
    `}`,
    `if (args[0] === "stop") { process.exit(0); }`,
    `const probe = process.env.RU_CODE_TEST_LAUNCH_PROBE;`,
    `if (probe) {`,
    `  fs.writeFileSync(probe, JSON.stringify({`,
    `    args,`,
    `    cloneExists: fs.existsSync(process.env.RU_CODE_TEST_CLONE_DIR || "/nonexistent"),`,
    `    stdinTty: Boolean(process.stdin.isTTY),`,
    `  }) + "\\n");`,
    `}`,
    // The SIGINT variant reads the installer's OWN pid out of its lock dir (written by acquire_lock,
    // released only in on_exit — so it is still there while we run) and signals it directly. No
    // guesswork about process groups, and no sleep: bash is already blocked waiting on us, it queues
    // the signal, our exit closes the capture, and the queued INT trap then renders banner 3.
    `const sigintPidFile = process.env.RU_CODE_TEST_LAUNCH_SIGINT;`,
    `if (sigintPidFile) {`,
    `  process.kill(Number(fs.readFileSync(sigintPidFile, "utf8").trim()), "SIGINT");`,
    `  process.exit(0);`,
    `}`,
    `if (process.env.RU_CODE_TEST_LAUNCH_FAIL) {`,
    `  process.stdout.write(JSON.stringify({`,
    `    ok: false,`,
    `    error: ${JSON.stringify(FAKE_LAUNCH_ERROR)},`,
    `    log: "/nonexistent/userdata/daemon.log",`,
    `  }) + "\\n");`,
    `  process.exit(1);`,
    `}`,
    `process.stdout.write(JSON.stringify({`,
    `  ok: true,`,
    `  url: ${JSON.stringify(FAKE_LAUNCH_URL)},`,
    `  version: ${JSON.stringify(version)},`,
    `  pid: process.pid,`,
    `}) + "\\n");`,
    `process.exit(0);`,
    ``,
  ].join("\n");

/** The installer's lock pid file inside a sandbox HOME — the SIGINT variant's target. */
export const lockPidFile = (home: string): string => `${home}/.ru-code-install.lock/pid`;
