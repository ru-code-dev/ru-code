// Single source of truth for preflight constants. The bash installer no longer
// mirrors any of this — it delegates to this module via node.

import { APP_HOME_DIRNAME, APP_HOME_SLUG, CLI_CONFIG_DIRNAME } from "@ru-fork/branding";

/** CLI config dir name, e.g. ".qwen". */
export const CLI_DIR = CLI_CONFIG_DIRNAME;
/** Our app home dir name, e.g. ".ru-fork". */
export const APP_DIR = APP_HOME_DIRNAME;
/** Our app command / wrapper name, e.g. "ru-fork". */
export const APP_BIN = APP_HOME_SLUG;

export const NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";
/** Minimum CLI version; "" disables the version check (presence only). */
export const CLI_MIN_VERSION = "0.13.1";

export const NODE_PROBE_TIMEOUT_MS = 5_000;
export const CLI_PROBE_TIMEOUT_MS = 15_000;
export const GIT_PROBE_TIMEOUT_MS = 5_000;
