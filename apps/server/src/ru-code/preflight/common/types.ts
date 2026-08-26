// Shared types for the preflight resolver. Leaf module — no imports.

export type PlatformKey = "darwin" | "linux" | "win32";

/** How `cli.js` was resolved: found at a per-platform config path, or not installed. */
export type CliSource = "config-path" | "none";

/**
 * CLI generation the resolver detected. `"v2"` ⇔ the CLI-SHIPPED node runtime exists at its fixed
 * per-platform path (NODE_BIN_PATHS) — the ng CLI marker. `"v1"` = legacy CLI (no shipped node):
 * every dispatch behavior stays exactly as before.
 */
export type CliCompatibility = "v1" | "v2";

export type ProbeResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: "missing" | "broken" | "timeout" };

export type CheckResult =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly line: string };

/**
 * The single resolver result — used by BOTH the installer preflight and the running app. It NEVER
 * fails: `ourRoot` (our app home) and `configDir` (the CLI/qwen profile dir) ALWAYS resolve from the
 * parent rules (home, or on Linux the user-profile dir). `cliJs` is the resolved qwen bin, or `""`
 * when qwen isn't installed (`cliDetected` false). The CLI profile dir need not exist — qwen creates
 * it on first chat. Field names are STABLE so the two consumers can't drift.
 */
export interface CliResolution {
  readonly ourRoot: string;
  readonly configDir: string;
  /**
   * The OTHER Linux CLI-profile candidate: the relocated `/home/<safe>/<user>/<CLI_DIR>` when the app
   * root relocated there, else `""`. Only the installer's warm-up consults it (to log where qwen's
   * profile actually landed); `configDir` remains the primary. Always `""` off Linux / off relocation.
   */
  readonly configDirAlt: string;
  readonly cliJs: string;
  readonly cliDetected: boolean;
  readonly source: CliSource;
  /** The CLI-shipped node runtime (NODE_BIN_PATHS probe); `""` when not present. */
  readonly nodeBin: string;
  /** `"v2"` ⇔ `nodeBin` was found (ng CLI); `"v1"` = legacy behavior everywhere. */
  readonly compatibility: CliCompatibility;
  /** Linux only: orphaned {home}/.<app> to delete after a user-profile relocation. */
  readonly legacyRoot?: string;
}

export interface ResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}
