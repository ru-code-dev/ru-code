// The per-platform candidate paths for qwen's `cli.js`. This is the ONE file edited per deployment —
// filling in the real bin locations is what adapts the resolver to a given environment; the resolver
// itself has zero environment-specific awareness and probes these in order (first existing wins).
//
// Tokens (expanded by node in expand.ts, no subprocess):
//   {home}         os.homedir()                 ($HOME / %USERPROFILE%)
//   {appdata}      process.env.APPDATA
//   {localappdata} process.env.LOCALAPPDATA

import { PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

import type { PlatformKey } from "./common/types.ts";

/**
 * WHERE qwen's `cli.js` lives — the ONE and only source the resolver consults. The `<cli>` segments
 * are placeholders: fill them with the real per-deployment layout. With them unfilled nothing
 * resolves, so dev/test stay isolated via the throwaway `$HOME` each test owns. First `isFile()`
 * match wins; `cliDetected` is simply "a match was found".
 */
export const CLI_BIN_PATHS: Record<PlatformKey, ReadonlyArray<string>> = {
  darwin: [
    // 0.21.1
    "{home}/Library/pnpm/store/v11/links/@qwen-code/qwen-code/0.21.1/64f994170921f602b4471bd3a255a819da4d8a607f8dd59385a9bbe97c033c10/node_modules/@qwen-code/qwen-code/cli.js",
    // 0.13.1
    // "{home}/Library/pnpm/global/5/node_modules/@qwen-code/qwen-code/cli.js",
    `{home}/${PREFLIGHT_CLI_PROBE_DIRNAME}/bin/cli.js`,
  ],
  linux: [`{home}/${PREFLIGHT_CLI_PROBE_DIRNAME}/bin/cli.js`],
  win32: [`{home}/${PREFLIGHT_CLI_PROBE_DIRNAME}/bin/cli.js`],
};

/**
 * WHERE the deployment's identity file lives (CLI_PASS_IDENTITY feature) — ONE path per platform,
 * `""` = not configured (the feature is then inert on that platform). The file is READ, never
 * executed: preflight/common/identity.ts extracts IDENTITY_KEY's value from its text and every CLI
 * spawn injects it as that env var. Same tokens as above; filled per deployment.
 */
export const CLI_IDENTITY_PATHS: Record<PlatformKey, string> = {
  darwin: "",
  linux: "",
  win32: "",
};
