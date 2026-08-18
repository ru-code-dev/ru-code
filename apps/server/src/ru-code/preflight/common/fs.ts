// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- standalone preflight bundle; self-contained node-builtin imports
// Preflight is deliberately Effect-free + node-builtins-only so it bundles into
// one standalone file (dist/preflight.mjs) that runs before any deps exist.
//
// Filesystem predicates + the .install-dir reader. No subprocess.

import * as fs from "node:fs";
import * as path from "node:path";

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

/** Read the bin path recorded in `<configDir>/.install-dir`, or "" if absent. */
export const readInstallRecord = (configDir: string): string => {
  const file = path.join(configDir, ".install-dir");
  try {
    return fs.readFileSync(file, "utf8").replace(/\r/g, "").trim();
  } catch {
    return "";
  }
};
