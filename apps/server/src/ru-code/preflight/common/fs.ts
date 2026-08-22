// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- standalone preflight bundle; self-contained node-builtin imports
// Preflight is deliberately Effect-free + node-builtins-only so it bundles into
// one standalone file (dist/preflight.mjs) that runs before any deps exist.
//
// Filesystem predicates. No subprocess.

import * as fs from "node:fs";

export const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
