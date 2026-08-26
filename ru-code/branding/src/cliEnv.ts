// @ru-code/branding — THE registry of environment variables and shared CLI flags that every
// qwen-kind CLI invocation carries. CONFIG ONLY: the tables below are the entire contents of this
// file's decision-making; the processing that turns them into spawn arguments lives next door in
// cliEnvBuild.ts, and nothing else in the codebase writes these names by hand.
//
// FIVE call sites draw from here — ACP sessions and warm slots, one-shot `-p` text generation, the
// app's `--version` provider probe, the install-time preflight's `--version` probe, and the bash
// installer's warm-up (whose env prefix and flags are generated INTO the shipped `install` script
// from these very tables by scripts/build-installer.ts). Before this registry each site hand-rolled
// its own env, and they drifted: some spawns had no profile dir, others no relaunch guard, and the
// warm-up connected every MCP server the user had configured.
//
// ── HOW TO EXTEND (each case is a ONE-line edit here, and nothing else) ───────────────────────
//
//   Add an ALIAS (a fork renames the CLI's prefix, or ships a transition period supporting both):
//     append the new name to that row's `names`. Every spawn then writes the SAME value under
//     every name in the row, so old and new builds are both satisfied and nothing else changes.
//
//   Add a FIXED row (a flag the CLI should always get, with a constant value):
//     add `KEY: { names: ["THE_NAME"], value: "the-value" }`. It is injected on EVERY spawn,
//     including both probes and the bash warm-up, from the next build onward.
//
//   Add a RUNTIME row (a value only known per spawn, like a path):
//     add `KEY: { names: ["THE_NAME"], value: null }`, then supply it through the runtime argument
//     of `cliEnvAssignments`. A runtime row with no value supplied that spawn is simply omitted —
//     which is how SYSTEM_SETTINGS_PATH stays absent everywhere except an ACP spawn with an
//     overlay, rather than being written as an empty variable.

/**
 * IDENTITY_KEY — the ONE name of the package-identity variable: it is both the key hunted inside
 * the identity file (preflight/common/identity.ts parser) and the env var name injected on every
 * spawn (the PACKAGE_IDENTITY row below references it). Filled per deployment, like the probe
 * paths; changing it here retargets the parser and the injection together.
 */
export const IDENTITY_KEY = "QWEN_PACKAGE_IDENTITY";

export const CLI_ENV = {
  /**
   * The CLI re-spawns itself as a child unless this is set (its relaunch wrapper). One process
   * means half the boot cost and memory, and our teardown signals hit the real agent instead of a
   * wrapper that ignores them.
   */
  NO_RELAUNCH: { names: ["QWEN_CODE_NO_RELAUNCH"], value: "true" },
  /**
   * The CLI's profile (home) directory — runtime-supplied because it is per provider instance:
   * the UI's `homePath` override, else the brand profile's `dirDefault`, else the dir the boot
   * preflight detected. MANDATORY on every spawn: without it the CLI reads the wrong profile (or
   * none) and reports a phantom version/auth state.
   */
  HOME: { names: ["QWEN_HOME"], value: null },
  /**
   * A highest-precedence settings file overlaid onto the CLI's own config. Runtime-supplied AND
   * genuinely optional: only an ACP spawn carrying an MCP overlay sets it, so every other spawn
   * omits the variable entirely.
   */
  SYSTEM_SETTINGS_PATH: { names: ["QWEN_CODE_SYSTEM_SETTINGS_PATH"], value: null },
  /**
   * The package identity extracted from the deployment's identity file (CLI_PASS_IDENTITY
   * feature). Runtime-supplied AND genuinely optional: supplied only when resolveCliIdentity
   * (preflight/common/identity.ts) actually produced a value — every other spawn omits the
   * variable entirely. The name is IDENTITY_KEY so the file parser and the injection can never
   * disagree.
   */
  PACKAGE_IDENTITY: { names: [IDENTITY_KEY], value: null },
} as const satisfies Record<string, CliEnvVar>;

export const CLI_ARGS = {
  /**
   * The MCP allowlist. The CLI decides by the PRESENCE of this flag, not its content: with it, it
   * keeps only servers named in the list; WITHOUT it there is no filter at all and it connects —
   * and awaits — every MCP server the user configured, which on a machine with a slow or
   * unreachable server costs minutes of startup. So "connect nothing" is expressed as an allowlist
   * no server name can match, never by omitting the flag. Any non-colliding token works; this one
   * is legible in a process list. A spawn that DOES want servers passes the joined list as the
   * runtime override.
   */
  ALLOWED_MCP_SERVERS: { flag: "--allowed-mcp-server-names", value: "__none__" },
} as const satisfies Record<string, CliArgVar>;

/**
 * One environment variable the CLI reads.
 *
 * `names` lists ALL concrete names it is known by — a fork prefix rename adds a name rather than
 * replacing one, and every spawn writes the same value under each. A string `value` is FIXED and
 * injected on every spawn; `null` means the value is supplied per spawn at runtime.
 */
export interface CliEnvVar {
  readonly names: ReadonlyArray<string>;
  readonly value: string | null;
}

/**
 * One command-line flag every spawn carries.
 *
 * `value` is the default emitted with the flag; a spawn may replace the value at runtime, but the
 * flag itself is never dropped (for ALLOWED_MCP_SERVERS, dropping it inverts its meaning).
 */
export interface CliArgVar {
  readonly flag: string;
  readonly value: string;
}
