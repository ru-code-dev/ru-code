// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- standalone preflight bundle; self-contained node-builtin imports
// oxlint-disable t3code/no-global-process-runtime -- standalone install-time preflight runs before node_modules exist; no Effect runtime to inject
// Preflight is deliberately Effect-free + node-builtins-only so it bundles into
// one standalone file (dist/preflight.mjs) that runs before any deps exist.
//
// The CLI_PASS_IDENTITY feature: locate the deployment's identity file (CLI_IDENTITY_PATHS — one
// per platform), READ it as text (it is never executed), and extract the value assigned to
// IDENTITY_KEY inside it. The value is then injected as that very env var on every CLI spawn via
// the registry's PACKAGE_IDENTITY row. This module is the ONE place the flag is read; every miss
// (flag off / path unconfigured / file absent / key absent / value rejected) yields "no value",
// which the registry turns into "variable omitted" — i.e. exactly today's behaviour.
//
// Extraction runs at every spawn's env assembly (no caching): a CLI update that rewrites the
// identity file is picked up by the very next spawn, and a transient miss degrades only that one
// spawn. A capped read of a tiny file is noise next to a process spawn.

import * as fs from "node:fs";

import { CLI_PASS_IDENTITY, IDENTITY_KEY } from "@ru-code/branding";

import { CLI_IDENTITY_PATHS } from "../paths.ts";
import { expand } from "./expand.ts";
import { isFile } from "./fs.ts";
import { toPlatformKey } from "./resolve.ts";
import type { PlatformKey } from "./types.ts";

/** Safety cap: an identity file is a few lines; never slurp more than this from a mispointed path. */
const IDENTITY_READ_CAP = 64 * 1024;

/**
 * The value must be a plain token: it travels through the generated installer's warm-up line
 * (unescaped RAW fragment) and into process envs, so shell-active characters are rejected rather
 * than quoted. Deployment identity values are ids, not prose.
 */
const IDENTITY_VALUE_PATTERN = /^[A-Za-z0-9._:@+-]+$/;

/** Everything a caller may want to journal about the identity lookup. */
export type CliIdentityProbe =
  | { readonly state: "disabled" }
  | { readonly state: "unconfigured" }
  | { readonly state: "file-missing"; readonly path: string }
  | { readonly state: "key-missing"; readonly path: string }
  | { readonly state: "ok"; readonly path: string; readonly value: string };

/** Options exist for tests and the dev override; production callers pass nothing. */
export interface IdentityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly paths?: Readonly<Record<PlatformKey, string>>;
  readonly key?: string;
  readonly enabled?: boolean;
}

/**
 * The identity file path for this platform: the RU_CODE_CLI_IDENTITY_PATH override (tests/dev,
 * same precedent as RU_CODE_PREFLIGHT / RU_CODE_CLI_JS), else the per-platform table entry with
 * the usual tokens expanded. `""` = not configured.
 */
export const resolveIdentityPath = (options: IdentityOptions = {}): string => {
  const env = options.env ?? process.env;
  const override = env["RU_CODE_CLI_IDENTITY_PATH"]?.trim() ?? "";
  if (override.length > 0) return override;
  const table = options.paths ?? CLI_IDENTITY_PATHS;
  const pattern = table[toPlatformKey(options.platform ?? process.platform)] ?? "";
  return pattern.length === 0 ? "" : expand(pattern, env);
};

/**
 * Extract IDENTITY_KEY's value from identity-file text. Tolerant by design — one rule set covers
 * both real-world shapes (`KEY='VALUE'` on POSIX, `set "KEY=VALUE"` in a .cmd):
 *   • line-based; a leading UTF-8 BOM and per-line `\r` (CRLF files) are stripped first;
 *   • ONE pattern per line: `(?:^|[\s"])KEY=(?:(['"])(?<quoted>[^'"]*)|(?<bare>\S+))` — the
 *     leading class is the boundary that rejects the tail of a longer name (`MY_<KEY>=`); a
 *     QUOTED value runs to its closing quote, so code sharing the line (`KEY='v' exec cli "$@"`)
 *     never bleeds in; an UNQUOTED value runs to the first whitespace. Residual quotes are then
 *     stripped (covers `set "KEY=v"`, whose trailing `"` lands in the `bare` branch);
 *   • first non-empty hit wins; no `$VAR`/`%VAR%` expansion ever.
 */
export const extractIdentityValue = (
  content: string,
  key: string = IDENTITY_KEY,
): string | undefined => {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[\\s"])${escapedKey}=(?:(['"])(?<quoted>[^'"]*)|(?<bare>\\S+))`);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = pattern.exec(line);
    if (!match) continue;
    const value = (match.groups?.["quoted"] ?? match.groups?.["bare"] ?? "").replace(/['"\s]/g, "");
    if (value.length > 0) return value;
  }
  return undefined;
};

/** The full lookup with its outcome spelled out — the preflight journals from this. */
export const probeCliIdentity = (options: IdentityOptions = {}): CliIdentityProbe => {
  if (!(options.enabled ?? CLI_PASS_IDENTITY)) return { state: "disabled" };
  const path = resolveIdentityPath(options);
  if (path.length === 0) return { state: "unconfigured" };
  if (!isFile(path)) return { state: "file-missing", path };
  let content: string;
  try {
    const fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(IDENTITY_READ_CAP);
    const bytes = fs.readSync(fd, buffer, 0, IDENTITY_READ_CAP, 0);
    fs.closeSync(fd);
    content = buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return { state: "file-missing", path };
  }
  const value = extractIdentityValue(content, options.key ?? IDENTITY_KEY);
  if (value === undefined || !IDENTITY_VALUE_PATTERN.test(value))
    return { state: "key-missing", path };
  return { state: "ok", path, value };
};

/** The one-liner spawn sites use: the identity value, or nothing. Never throws, never blocks. */
export const resolveCliIdentity = (options: IdentityOptions = {}): string | undefined => {
  const probe = probeCliIdentity(options);
  return probe.state === "ok" ? probe.value : undefined;
};

/**
 * The registry-runtime fragment for the identity — `{ PACKAGE_IDENTITY: value }` on a hit, `{}` on
 * any miss — so an env composer folds the whole feature into one spread:
 * `cliEnvAssignments({ HOME: …, ...identityEnvRuntime() })`.
 */
export const identityEnvRuntime = (
  options: IdentityOptions = {},
): { readonly PACKAGE_IDENTITY?: string } => {
  const value = resolveCliIdentity(options);
  return value ? { PACKAGE_IDENTITY: value } : {};
};
