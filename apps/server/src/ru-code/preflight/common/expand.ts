// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- standalone preflight bundle; self-contained node-builtin imports
// Preflight is deliberately Effect-free + node-builtins-only so it bundles into
// one standalone file (dist/preflight.mjs) that runs before any deps exist.
//
// Expand path tokens to a normalized absolute path. All tokens come from
// OS-populated values (os.homedir() / process.env) — no subprocess, no user-id
// reconstruction.

import * as os from "node:os";
import * as path from "node:path";

export const expand = (pattern: string, env: NodeJS.ProcessEnv = process.env): string => {
  const replaced = pattern
    .replace(/\{home\}/g, os.homedir())
    .replace(/\{appdata\}/g, env.APPDATA ?? "")
    .replace(/\{localappdata\}/g, env.LOCALAPPDATA ?? "");
  return path.normalize(replaced);
};
