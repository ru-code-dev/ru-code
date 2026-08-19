// ru-code: spawn shape for the qwen CLI. Pure. Two modes, chosen by the bin:
//   • a JS entry (`…cli.js` / `.mjs` / `.cjs`) → `node <cli.js> <args…>`, reusing
//     the app's own interpreter (`process.execPath`). This is the preflight-detected
//     path (ServerConfig.cliJs) and the default for the "custom" fork profile.
//   • anything else (a bare command like `qwen`, or a path to a native binary) →
//     run it directly, `<bin> <args…>`. Lets the "qwen" profile default to the
//     `qwen` command on PATH, or a user point `binaryPath` at any executable.
// Always `shell:false`: no bash / cmd / PowerShell, never `shell:true` — kills the
// Windows shell:true / DEP0190 path. A bare command is resolved by the OS spawn
// (execvp-style PATH search on POSIX); pass an absolute path for full portability.

export interface ResolvedSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

/** True when `bin` is a JavaScript entry (`.js`/`.cjs`/`.mjs`) that must be run via `node`. */
export const isJsEntry = (bin: string): boolean => /\.(c|m)?js$/i.test(bin.trim());

// ru-code: a TypeScript entry (`.ts`/`.cts`/`.mts`) is also run via the app's own
// node, using type-stripping — the DEV-ONLY fake ACP server (RU_CODE_CLI_JS →
// fake-acp-server.ts) is spawned straight from source with no build step, exactly
// how the server itself runs `node src/bin.ts`. `--experimental-strip-types` is
// added so it works on Node 22.16-22.17 too (a harmless no-op from 22.18 / 23.6,
// where stripping is on by default). Real qwen is a `.js` bin, so this never fires
// for it.
export const isTsEntry = (bin: string): boolean => /\.(c|m)?ts$/i.test(bin.trim());

export const buildCliSpawn = (bin: string, args: ReadonlyArray<string>): ResolvedSpawn => {
  // ru-code: trim once so classification (isJsEntry/isTsEntry) and the spawned
  // command agree — a bin read from a file / env with surrounding whitespace can't
  // slip through as a node arg or a bare command with an ENOENT-inducing space.
  const command = bin.trim();
  if (isTsEntry(command)) {
    return {
      command: process.execPath,
      args: ["--experimental-strip-types", command, ...args],
      shell: false,
    };
  }
  return isJsEntry(command)
    ? { command: process.execPath, args: [command, ...args], shell: false }
    : { command, args: [...args], shell: false };
};
