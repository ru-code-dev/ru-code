// @ru-code/branding — the PROCESSING half of the CLI registry: it turns the tables in cliEnv.ts
// into the concrete env pairs and argv fragments a spawn needs. It holds no configuration at all,
// so re-skinning the product touches cliEnv.ts and nothing here.
//
// Every qwen spawn site calls these instead of writing variable names by hand, which is what makes
// "add a row, every spawn carries it" true. Both assignment helpers take their table as a defaulted
// FINAL parameter so the rules can be tested against fixture tables, independently of the rows the
// product happens to ship today.

import { CLI_ARGS, CLI_ENV, type CliArgVar, type CliEnvVar } from "./cliEnv.ts";

/** The per-spawn values for the runtime (`value: null`) rows of {@link CLI_ENV}. */
export interface CliEnvRuntime {
  /** The CLI profile dir. Supplied on EVERY spawn — see the row's doc in cliEnv.ts. */
  readonly HOME?: string;
  /** The settings overlay path. Only an ACP spawn carrying an MCP overlay supplies it. */
  readonly SYSTEM_SETTINGS_PATH?: string;
  /** The package identity value. Supplied only when resolveCliIdentity produced one. */
  readonly PACKAGE_IDENTITY?: string;
}

/** The per-spawn overrides for the flag values of {@link CLI_ARGS}. */
export interface CliArgRuntime {
  /** The joined MCP allowlist. Absent ⇒ the row's "connect nothing" default. */
  readonly ALLOWED_MCP_SERVERS?: string;
}

/**
 * The `[name, value]` pairs a spawn must write into its environment, across every alias of every
 * applicable row, in table order.
 *
 * A fixed row always contributes its own value — the runtime cannot talk it down, because a fixed
 * row is policy rather than a default. A runtime row contributes only when a non-empty value is
 * supplied for it; otherwise the variable is omitted entirely rather than written blank, which is
 * the difference between "the CLI has no overlay" and "the CLI has an empty overlay path".
 */
export const cliEnvAssignments = (
  runtime: CliEnvRuntime = {},
  table: Readonly<Record<string, CliEnvVar>> = CLI_ENV,
): ReadonlyArray<readonly [string, string]> => {
  const supplied = runtime as Readonly<Record<string, string | undefined>>;
  const pairs: Array<readonly [string, string]> = [];
  for (const [key, row] of Object.entries(table)) {
    const value = row.value ?? supplied[key] ?? "";
    if (value.length === 0) continue;
    for (const name of row.names) pairs.push([name, value] as const);
  }
  return pairs;
};

/**
 * The flag/value tokens a spawn must append to its argv, flattened in table order.
 *
 * A runtime override replaces a row's value; an absent or empty override falls back to the row
 * default. The flag itself is emitted either way — for the MCP allowlist, omitting it would invert
 * its meaning from "connect nothing" to "connect everything".
 */
export const cliArgAssignments = (
  runtime: CliArgRuntime = {},
  table: Readonly<Record<string, CliArgVar>> = CLI_ARGS,
): ReadonlyArray<string> => {
  const supplied = runtime as Readonly<Record<string, string | undefined>>;
  const args: Array<string> = [];
  for (const [key, row] of Object.entries(table)) {
    const override = supplied[key];
    args.push(row.flag, override !== undefined && override.length > 0 ? override : row.value);
  }
  return args;
};

/**
 * The argv fragment for an MCP allowlist: the supplied server names when there are any, else the
 * registry's "connect nothing" default. Blank entries are dropped, so a list of only whitespace is
 * the same as no list at all.
 */
export const allowedMcpServerArgs = (
  allowedMcpServers?: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const names = (allowedMcpServers ?? []).filter((name) => name.trim().length > 0);
  return names.length > 0
    ? cliArgAssignments({ ALLOWED_MCP_SERVERS: names.join(",") })
    : cliArgAssignments();
};
