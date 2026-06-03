// Shared types for the preflight resolver. Leaf module — no imports.

export type PlatformKey = "darwin" | "linux" | "win32";

/** How `cli.js` was resolved. See resolve.ts / common-preflight.md §10. */
export type CliSource = "standard" | "install-dir" | "fallback";

export type ProbeResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: "missing" | "broken" | "timeout" };

export type CheckResult =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly line: string };

export type CliResolution =
  | {
      readonly ok: true;
      readonly configDir: string;
      readonly cliJs: string;
      readonly source: CliSource;
      readonly ourRoot: string;
      /** Linux only: orphaned {home}/.<app> to delete after relocation. */
      readonly legacyRoot?: string;
      /** Non-fatal report lines (e.g. which primary CLIs the backup bypassed). */
      readonly warnings?: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly details: ReadonlyArray<string>;
      readonly configDir?: string;
    };

export interface ResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Enables the CLI_BIN_PATHS fallback search (TRY_TO_FIND_CLI). */
  readonly tryFindCli?: boolean;
}
