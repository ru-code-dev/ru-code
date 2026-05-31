// @effect-diagnostics nodeBuiltinImport:off
// System diagnostics for debugging install / path-resolution issues across
// platforms. Printed at the top of the report so any support output carries the
// full environment (OS build, arch, node, home, the profile/path env vars).

import * as os from "node:os";

// Env vars that drive resolution. The Windows-specific profile vars are only
// shown on Windows — elsewhere they're always unset and just add noise.
const POSIX_ENV_KEYS = ["HOME", "NODE_PATH", "TRY_TO_FIND_CLI"] as const;
const WINDOWS_ENV_KEYS = [
  "MSYSTEM",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_PATH",
  "TRY_TO_FIND_CLI",
] as const;

const envKeys = (): ReadonlyArray<string> =>
  process.platform === "win32" ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS;

const envValue = (name: string): string => process.env[name] ?? "(unset)";

export const collectDiagnostics = (): ReadonlyArray<string> => {
  let username = "?";
  try {
    username = os.userInfo().username;
  } catch {
    // No passwd entry (rare); leave "?".
  }
  return [
    `platform : ${process.platform} ${os.release()}`,
    `version  : ${os.version()}`,
    `arch     : ${process.arch}`,
    `node     : v${process.versions.node}  (${process.execPath})`,
    `home     : ${os.homedir()}`,
    `user     : ${username}`,
    `cwd      : ${process.cwd()}`,
    ...envKeys().map((name) => `env ${name} = ${envValue(name)}`),
    `PATH     : ${envValue("PATH")}`,
  ];
};
