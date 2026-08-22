// ru-code: record the environment the DAEMON CHILD actually booted with.
//
// Why this exists: the child inherits the launcher's full environment
// (spawnServerChild.ts — `env: { ...process.env }`), so in principle a daemon
// started from a terminal is identical to `--foreground`. When a user reports
// "works under --fg, fails as a daemon", the only way to tell an inheritance
// problem from an application one is to see what the child actually got. Without
// this, every such report is inference.
//
// It writes to stdout, which the launcher has redirected to `daemon.log`
// (spawn.ts opens it with "w", so the lines always describe the CURRENT daemon).
// Deliberately NOT behind a debug level: the machine that needs it is a user's,
// where debug logging is off, which is exactly when it would not exist.
//
// It is NOT in envFacts (a wire contract sent to the browser) and NOT in the
// runtime-state file (a small contract the installer and the e2e harness read).
// These values carry the username, so they stay in a local log the user chooses
// to send.

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { DAEMON_CHILD_ENV } from "./constants.ts";

/** Prefix on every line, so a support request can be reduced to one grep. */
export const BOOT_ENV_PREFIX = "[boot-env]";

/**
 * Variables that decide whether a spawned tool (git above all) can run at all:
 * where its binaries are found, where its per-user config lives, and where it may
 * write temporary files. HOME/USERPROFILE and TMP/TEMP are listed as pairs because
 * which one is populated is itself the diagnostic on Windows.
 */
const REPORTED_VARIABLES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "SHELL",
  "COMSPEC",
] as const;

export interface BootEnvironmentFacts {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly cwd: string;
}

/**
 * One line per fact, stable order, empty distinguished from absent — a variable
 * set to "" and a variable that was never set fail differently and the log has to
 * say which. Pure so the shape can be tested without spawning a daemon.
 */
export const formatBootEnvironment = (facts: BootEnvironmentFacts): string => {
  const header = `${BOOT_ENV_PREFIX} platform=${facts.platform} arch=${facts.arch} node=${facts.nodeVersion}`;
  const cwd = `${BOOT_ENV_PREFIX} cwd=${facts.cwd}`;
  const variables = REPORTED_VARIABLES.map((name) => {
    const value = facts.env[name];
    const rendered = value === undefined ? "(unset)" : value === "" ? "(empty)" : value;
    return `${BOOT_ENV_PREFIX} ${name}=${rendered}`;
  });
  return [header, cwd, ...variables].join("\n");
};

/**
 * Emit the report when this process IS the spawned daemon child, and only then.
 * Under `--foreground` the environment is the terminal's own and the user can read
 * it directly, so printing there would be noise in the one place it adds nothing.
 */
export const reportBootEnvironment = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (process.env[DAEMON_CHILD_ENV] !== "1") return;
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    yield* Console.log(
      formatBootEnvironment({
        env: process.env,
        platform,
        arch,
        nodeVersion: process.version,
        cwd: process.cwd(),
      }),
    );
  });
