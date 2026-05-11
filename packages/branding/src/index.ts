// @ru-fork/branding — single source of truth for all product/vendor branding.
//
// The whole codebase is brand-neutral: app and CLI names live ONLY here. To
// re-skin the product (new app name, different underlying CLI) edit the values
// in this file and nothing else. Everywhere else references these constants.


export const APP_SHORT_NAME = "Ru";
/**
 * APP_NAME — display name of the application. This is the one and only place
 * the product name literal lives; UI, window titles, git author, status and
 * error messages all reference this constant.
 */
export const APP_NAME = "Ru Code";

/**
 * CLI_NAME — name of the underlying CLI binary / ACP provider. This is the one
 * and only place the CLI name literal lives. Used for the spawned binary, the
 * provider kind id, user-facing labels and config-directory derivation.
 */
export const CLI_NAME = "qwen";

/**
 * CLI_BINARY_NAME — the binary spawned for ACP sessions, status probes and
 * text generation. Derived from {@link CLI_NAME}; kept as a distinct export so
 * call sites read intentionally (spawn vs. label).
 */
export const CLI_BINARY_NAME = CLI_NAME;

/**
 * CLI_DISPLAY_NAME — human-readable label for the CLI in user-facing status,
 * error messages and settings descriptions.
 */
export const CLI_DISPLAY_NAME = CLI_NAME;

/**
 * CLI_CONFIG_DIRNAME — per-user dot-directory the CLI reads its skills,
 * subagents and config from (e.g. `~/.qwen/`). Derived from {@link CLI_NAME}.
 */
export const CLI_CONFIG_DIRNAME = `.${CLI_NAME}`;

/**
 * CLI_NPM_PACKAGE — npm package that provides the CLI binary, shown in the
 * "not installed / update" preflight messages.
 */
export const CLI_NPM_PACKAGE = "@qwen-code/qwen-code";

/**
 * CLI_DEFAULT_MODEL — default model id advertised by the CLI, used as a
 * fallback when no explicit model selection is present.
 */
export const CLI_DEFAULT_MODEL = "qwen3-coder-plus";

/**
 * SLASH_COMMAND_NOTIFICATION_METHODS — ACP vendor-extension notification
 * methods that carry slash-command progress/result text (compress, summary,
 * etc.). Different CLI builds advertise the same payload under different
 * vendor namespaces; the adapter accepts any of them so the user sees the same
 * bubble regardless of which binary is on PATH. These are external wire-protocol
 * identifiers emitted by the binaries, so they are centralized here rather than
 * inlined in adapter code.
 */
export const SLASH_COMMAND_NOTIFICATION_METHODS: readonly string[] = [
  `_${CLI_NAME}code/slash_command`,
  "_gigacode/slash_command",
];
