// Single source of truth for preflight constants. The bash installer no longer
// mirrors any of this — it delegates to this module via node.

import { APP_COMMAND, APP_HOME_DIRNAME, PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

/** CLI config dir name, e.g. ".qwen". */
export const CLI_DIR = PREFLIGHT_CLI_PROBE_DIRNAME;
/** Our app home dir name, e.g. ".ru-code". */
export const APP_DIR = APP_HOME_DIRNAME;
/** Our app command / wrapper name, e.g. "ru-code". */
export const APP_BIN = APP_COMMAND;
/** Linux-only path segment under /home. When /home/<LINUX_SAFE_DIR>/<user> exists,
 *  OUR_ROOT is placed there; otherwise it stays in the home dir. */
export const LINUX_SAFE_DIR = "work";
/**
 * Whether the CLI (qwen) profile dir co-locates with a relocated OUR_ROOT on Linux. Default `false`:
 * even when the app root relocates to `/home/<LINUX_SAFE_DIR>/<user>`, the CLI profile dir stays under
 * the home dir (`<home>/<CLI_DIR>`) — the pre-existing behavior. `true` moves it alongside the app root.
 */
export const LINUX_USE_SAFE_DIR_FOR_CLI = false;

export const NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";
/** Minimum CLI version; "" disables the version check (presence only). */
export const CLI_MIN_VERSION = "0.13.1";

// ru-code: this is a standalone, import-free preflight bundle — it CANNOT import
// apps/server/src/timeouts.ts, so these probe budgets are DUPLICATED there and
// must be kept in sync by hand:
//   CLI_PROBE_TIMEOUT_MS ↔ timeouts.ts CLI_VERSION_PROBE_TIMEOUT_MS
//   GIT_PROBE_TIMEOUT_MS ↔ timeouts.ts SOURCE_CONTROL_VERSION_PROBE_TIMEOUT_MS
export const CLI_PROBE_TIMEOUT_MS = 3_000;
export const GIT_PROBE_TIMEOUT_MS = 2_000;
