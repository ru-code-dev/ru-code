// ru-code pin harness: the CLI the pinned server spawns instead of qwen.
//
// A thin wrapper over the REAL fake-acp server (node 24 runs its TypeScript natively) that adds
// the fault knobs the pins turn. All knobs are env vars, so each pinned boot dials its own faults:
//
//   RU_CODE_PIN_VERSION_DELAY_MS   `--version` answers this late (CLI cold start on a slow machine)
//   RU_CODE_PIN_VERSION_FAIL=1     `--version` fails: error text on stderr, exit 1
//   RU_CODE_PIN_ACP_READY_DELAY_MS every other invocation stalls this long before doing anything
//   RU_CODE_PIN_ACP_FAIL=1         the invocation then FAILS (stderr + exit 1) instead of serving —
//                                  a crashing/broken CLI, as seen by the warm pool and one-shots
//   RU_CODE_PIN_SPAWN_LOG          append one line per invocation (`<iso> <argv>`) — the pins count
//                                  these lines to tell a bounded retry from a respawn storm
//   RU_CODE_PIN_SPAWN_LOG_ENV      comma-separated env-var NAMES to record alongside the argv, as a
//                                  tab-separated JSON object at the end of the line. The names come
//                                  from the caller (the spawn-env pin derives them from the branding
//                                  CLI registry), so this file stays registry-free and the older
//                                  pins' `<iso> <argv>` prefix is untouched.
//
// No knob set → behaves exactly like pointing RU_CODE_CLI_JS at the fake directly. Test-support
// only; nothing under apps/ changes.

import * as NodeFS from "node:fs";

const ms = (name) => {
  const parsed = Number(process.env[name] ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const flag = (name) => process.env[name] === "1";
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

const spawnLog = process.env.RU_CODE_PIN_SPAWN_LOG;
if (spawnLog) {
  try {
    const names = (process.env.RU_CODE_PIN_SPAWN_LOG_ENV ?? "").split(",").filter((n) => n !== "");
    const recorded = {};
    for (const name of names) recorded[name] = process.env[name];
    const suffix = names.length > 0 ? `\t${JSON.stringify(recorded)}` : "";
    // ONE record per line, always: a `-p` prompt is multi-line, and a raw newline (or a tab,
    // which separates the env payload) would split one spawn across several physical lines and
    // make every reader miscount and misattribute. Single-line argv is byte-identical to before.
    const argv = process.argv
      .slice(2)
      .join(" ")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    NodeFS.appendFileSync(spawnLog, `${new Date().toISOString()} ${argv}${suffix}\n`);
  } catch {
    /* the log is evidence, never a failure source */
  }
}

if (process.argv.includes("--version")) {
  await sleep(ms("RU_CODE_PIN_VERSION_DELAY_MS"));
  if (flag("RU_CODE_PIN_VERSION_FAIL")) {
    process.stderr.write("Error: pin-injected version failure (requires Node 20.11.1)\n");
    process.exit(1);
  }
  // yargs shape: the version alone on stdout, exit 0.
  process.stdout.write("0.13.1\n");
  process.exit(0);
}

await sleep(ms("RU_CODE_PIN_ACP_READY_DELAY_MS"));
if (flag("RU_CODE_PIN_ACP_FAIL")) {
  process.stderr.write("Error: pin-injected CLI failure before ACP handshake\n");
  process.exit(1);
}
const realFake = process.env.RU_CODE_PIN_REAL_FAKE;
if (!realFake) {
  process.stderr.write("pinFakeCli: RU_CODE_PIN_REAL_FAKE is not set\n");
  process.exit(1);
}
await import(realFake);
