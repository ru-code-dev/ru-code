// @ru-code/branding — single source of truth for all product/vendor branding.
//
// The whole codebase is brand-neutral: app and CLI identity live ONLY here. To
// re-skin the product edit the values in this file (+ cliProfiles.ts) and nothing
// else. Everywhere else references these constants.

export * from "./cliProfiles.ts";
export * from "./hiddenModels.ts";
export * from "./modelNameWords.ts";

/**
 * APP_NAME — display name of the application. This is the one and only place
 * the product-name literal lives; the HTML title, meta description, web
 * manifest, the server CLI description, UI, status and error messages all
 * reference this constant instead of hard-coding the product name.
 */
export const APP_NAME = "Ru Code";

/**
 * APP_HOME_SLUG — kebab-case slug used to derive on-disk identifiers: the
 * per-user home dot-directory (`~/.ru-code`), env-var prefixes and temp-file
 * prefixes. Distinct from {@link APP_NAME} (the display name) because these
 * paths must be filesystem- and shell-safe and stable across re-skins.
 */
export const APP_HOME_SLUG = "ru-code";

/** `~/.${APP_HOME_SLUG}` directory name (without leading `/`), e.g. `.ru-code`. */
export const APP_HOME_DIRNAME = `.ru-code`;

/**
 * APP_SCOPE — storage-key namespace for all client persistence (localStorage +
 * IndexedDB + internal event names). Every persisted key is built as
 * `${APP_SCOPE}:…` so the identity lives in one place. Replaces the legacy
 * `t3code:` prefix.
 */
export const APP_SCOPE = "ruCode";

/**
 * APP_COMMAND — the installed app's CLI program name, branded into the effect-CLI
 * program identity (--help/--version). The default base dir under $HOME is
 * {@link APP_HOME_DIRNAME}.
 */
export const APP_COMMAND = "ru-code";

/**
 * FAIL_ON_LOCALIZATION_ERROR — when `true`, the localization BUILD gate hard-fails
 * the build if any dictionary translation of a shipped file did not apply (see
 * ru-code/localization/build/vitePlugin.mjs + verifyBuild.mjs). Keep it `true` while the
 * dictionary is authored/maintained on the finished fork, so nothing silently ships English.
 *
 * It lives here — in branding, a LATE patch in the fork series — on purpose: during an
 * upstream re-sync the commits are replayed onto fresh t3, and at intermediate commits the
 * accumulated dictionary intentionally overshoots the still-partial source. Because this file
 * only exists once branding is applied, the gate reads it via `fs` and treats "file absent /
 * not `true`" as LENIENT — so mid-replay builds don't false-fail, while the completed fork
 * (branding present, constant `true`) is strict. Flip to `false` if you ever need to build the
 * finished tree without the gate.
 */
// ru-code: FALSE for the whole patch series. The dictionary is the FINISHED fork's
// dictionary, so until every patch has landed it necessarily overshoots the partial
// source tree and the gate would fail on translations that are merely early, not wrong.
// Flip to `true` only once the series is complete.
export const FAIL_ON_LOCALIZATION_ERROR = false;

/**
 * QWEN_KIND — the single ProviderDriverKind id for the qwen provider. Universal
 * and persisted: every instance (any profile — see cliProfiles.ts) is this kind,
 * so models/continuation/checkpoints are shared. Never user-facing. Supports
 * qwen custom forks by keeping one kind underneath multiple brand profiles.
 * The `"qwen"` literal lives ONLY here; contracts derives its branded
 * `ProviderDriverKind` from this constant.
 */
export const QWEN_KIND = "qwen";

/**
 * PREFLIGHT_CLI_PROBE_DIRNAME — dot-directory the boot preflight probes to
 * detect the CUSTOM-profile CLI fork install (`~/<this>/bin/cli.js`), and the
 * fallback CLI home when detection finds nothing (resolveStartupQwenCli). Only the
 * custom profile consumes the detected path (its `dirDefault` is `null` — "use
 * what preflight found"); stock qwen's dir comes from its own profile literal
 * (`~/.qwen`, cliProfiles.ts), never from here. A real fork edits this to its
 * own dot-folder; it is `.qwen` while the dev fork is stock qwen.
 */
export const PREFLIGHT_CLI_PROBE_DIRNAME = `.qwen`;

/**
 * DEFAULT_PROVIDER_INSTANCE_ID — the single source of the app's default provider. This is a
 * provider INSTANCE id (not a kind); it carries the instance's kind + brand profile + config +
 * per-model auth. Must be a BUILT-IN instance id (its string equals its driver kind). Change this
 * one value to re-home the default to any provider (opencode / claudeAgent / qwen / …). Plain string
 * so this leaf package stays contracts-free; consumers brand via `ProviderInstanceId.make(...)`.
 */
export const DEFAULT_PROVIDER_INSTANCE_ID = "qwen";

/**
 * CLI_DISPLAY_NAME — user-facing name of the CLI, woven into Russian error text so
 * no literal "Cli" leaks into the UI. Distinct from {@link QWEN_KIND} (the persisted
 * routing slug) and per-instance brand labels (profile displayName). Re-skin here.
 */
// ru-code: NEUTRAL, indeclinable token woven into Russian error text — never the
// per-profile brand. Hardcoding a profile name ("Qwen") would show the wrong CLI for
// a custom profile, and pre-session error sites can't resolve the active profile, so a
// profile-driven name can't guarantee correctness. "CLI" is grammatically clean in every
// case (Сессия CLI прервана / авторизация CLI / с CLI), mirroring skills-agents' use of an
// indeclinable token. Per-profile brand lives in the profile displayName (cliProfiles.ts).
export const CLI_DISPLAY_NAME = "CLI";

/**
 * HIDE_USELESS_LOGS — when true, suppress high-frequency / no-signal DEBUG lines
 * (e.g. "agent activity snapshot skipped; publication disabled") that flood the
 * server debug stream when a subsystem is simply disabled. Flip to false to see
 * everything again.
 */
export const HIDE_USELESS_LOGS = true;

/**
 * CONTEXT_COMPACTION_TASK_PREFIX — RuntimeTaskId prefix of the hidden
 * context-compaction lifecycle (`task.progress`/`task.completed`). The server
 * adapter emits under it; the web derives its "compaction in progress" state
 * (send/compress blocking) from the same prefix. One wire identifier, both sides.
 */
export const CONTEXT_COMPACTION_TASK_PREFIX = "context-compaction:";
