// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- reuses the standalone preflight resolver; keeps its node-builtin imports
//
// ru-code: default base dir for the installed app.
//
// Skills-agents parity (its cli/config.ts): the base dir defaults to the
// resolver's ourRoot — the installed app folder, bin/Linux-relocation aware —
// while `--base-dir` / `T3CODE_HOME` / desktop bootstrap still override it. We
// reuse the already-ported install-time resolver instead of hardcoding
// `~/.<app>`, so the running app and the installer agree on where state lives.

import * as os from "node:os";
import * as path from "node:path";

import { APP_HOME_DIRNAME } from "@ru-code/branding";

import { resolveCli } from "../preflight/common/resolve.ts";
import type { ResolveOptions } from "../preflight/common/types.ts";

/**
 * The default base directory: the resolver's `ourRoot` when the CLI can be
 * located (the normal installed state), otherwise the conventional home app dir
 * (dev / pre-install, when the CLI config dir does not yet exist). Accepts the
 * same resolve options as {@link resolveCli} so it stays injectable for tests.
 */
export const resolveDefaultBaseDir = (options: ResolveOptions = {}): string => {
  const resolution = resolveCli(options);
  if (resolution.ok) return resolution.ourRoot;
  const home = options.env?.HOME ?? options.env?.USERPROFILE;
  return path.join(home ?? os.homedir(), APP_HOME_DIRNAME);
};
