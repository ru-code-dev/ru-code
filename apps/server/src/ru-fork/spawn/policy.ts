// ru-fork: per-process spawn policy. Resolved once at startup
// from CLI flags + env, before any spawn. Module-state because the
// data is process-global and immutable post-init — same shape as
// process.env. Not Effect-injected: would propagate a service
// requirement through every spawn-site's type, including
// processRunner.ts which is Promise-based and can't yield* a service.
//
// See ru-fork-instrumental/changes/startap-environment.md.

// @effect-diagnostics nodeBuiltinImport:off — sync init helper; threading
// effect/Path through every caller for one path.join call isn't worth it.
// Matches the precedent in daemonLauncher.ts and packages/shared/src/shell.ts.
import * as os from "node:os";
import * as path from "node:path";

import { CLI_FOLDER } from "../../config.ts";

const parseList = (raw: string | undefined): ReadonlyArray<string> =>
  raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

let bashRoutedBins: ReadonlySet<string> = new Set();

export const initSpawnPolicy = (input: {
  readonly injectExtraPaths: string | undefined;
  readonly windowsUseBashFor: string | undefined;
}): void => {
  bashRoutedBins = new Set(
    parseList(input.windowsUseBashFor ?? process.env.RU_FORK_WINDOWS_USE_BASH_FOR),
  );

  const isWin = process.platform === "win32";
  const prepend: string[] = [
    ...parseList(input.injectExtraPaths ?? process.env.RU_FORK_INJECT_EXTRA_PATHS),
  ];
  if (isWin) prepend.push(path.join(os.homedir(), CLI_FOLDER, "bin"));
  if (prepend.length === 0) return;

  process.env.PATH = [...prepend, process.env.PATH ?? ""].filter(Boolean).join(isWin ? ";" : ":");
};

export interface ResolvedSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

// Returns the spawn shape after applying the policy.
// - non-Windows: pass-through (shell:false always).
// - Windows + bin in `--windows-use-bash-for`: bash-route via
//   `bash -c '<bin> "$@"' bash ...args`. The "$@" positional trick
//   keeps argument boundaries intact under bash quoting/word-splitting:
//   the first "bash" becomes $0; ...args become $1..$N as separate
//   quoted words.
// - Windows otherwise: preserve the caller's `shell` choice unchanged
//   (e.g. git keeps `shell:false`, CLI keeps `shell:true`).
export const resolveSpawn = (
  bin: string,
  args: ReadonlyArray<string>,
  options: { readonly shell: boolean },
): ResolvedSpawn => {
  if (process.platform !== "win32") return { command: bin, args, shell: false };
  if (bashRoutedBins.has(bin)) {
    return { command: "bash", args: ["-c", `${bin} "$@"`, "bash", ...args], shell: false };
  }
  return { command: bin, args, shell: options.shell };
};
