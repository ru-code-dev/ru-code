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

/**
 * APP_REPO_NAME — the git repository / clone-directory name the installer `cd`s into for the
 * co-located flow (`git clone <repo> && bash <repo>/install`). That directory is named by `git
 * clone` after the REPO, which is independent of {@link APP_HOME_SLUG} — a fork may host the code
 * under any repo name. ONLY the installer's clone-dir lookup + usage help use this; the on-disk
 * identity (install log / lock filenames, starter git email) stays on {@link APP_HOME_SLUG}.
 * Defaults to the slug; set it to your actual repo name when they differ.
 */
export const APP_REPO_NAME = "ru-code";

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
 * releaseTarballName — the ONE place the release tarball's filename shape is defined.
 * `prepare-release` writes `<dir>/<this>`, and both update channels derive the same
 * name from the manifest's `version` instead of reading it from the manifest: the
 * tarball is always the manifest's sibling, so the producer and the two consumers
 * cannot drift and the manifest carries no address at all.
 */
export const releaseTarballName = (version: string): string => `${APP_COMMAND}-${version}.tgz`;

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
 * CREATE_STARTER_PROJECT — when `true`, the server registers the pre-made
 * `<baseDir>/Project` starter folder on startup (serverRuntimeStartup.ts), so the first
 * launch has a workspace without adopting the launch cwd. `false` → no auto-project; the
 * user opens their own folder. This gates ONLY the app-start registration; the installer
 * has its own independent install-time starter-creation switch (the `install` script's
 * `CREATE_STARTER_PROJECT` constant). Default off.
 */
export const CREATE_STARTER_PROJECT = false;

/**
 * USE_RC_SOURCED_LAUNCHER — how the installer persists the launch command into shell rc files.
 *
 * `false` (default): the classic `export PATH="<bin>:$PATH"` line, and the command resolves to the
 * `<bin>/<APP_COMMAND>` sh wrapper. `true`: the installer writes `<bin>/env.sh` — a guarded PATH
 * prepend plus a shell FUNCTION named `<APP_COMMAND>` that runs `node <bin>/cli.js` directly (all
 * paths resolved and baked at install time) — and each rc file gets ONE guarded line
 * `[ -f "<bin>/env.sh" ] && . "<bin>/env.sh"`. A function is resolved by the shell before any PATH
 * lookup and never executes the wrapper FILE, so launching works in environments where running a
 * user-writable script file is not permitted while `node <file>` is.
 *
 * The rc scrub recognises BOTH line shapes regardless of this switch, so flipping it either way
 * converges every rc file in one install and uninstall always cleans up completely. `env.sh` and
 * the rc line change only on a manual (re)install — the in-app updater never touches them.
 */
export const USE_RC_SOURCED_LAUNCHER: boolean = false;

/**
 * BRAND_GRADIENT_FROM / _TO — the cyan→violet wordmark gradient endpoints (`[r, g, b]`), the ONE
 * source of the brand sweep. Used by the daemon launcher banner (`ru-code/daemon/src/paint.ts`) and
 * injected into the `install` script by `scripts/build-installer.ts` (as `"r;g;b"`), so the two can
 * never drift. Change the look here and nowhere else.
 */
export const BRAND_GRADIENT_FROM = [56, 217, 238] as const; // cyan
export const BRAND_GRADIENT_TO = [167, 139, 250] as const; // violet

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
 * Env-var prefix the CLI reads for its system-settings path + no-relaunch flag.
 * A qwen fork edits this to its own prefix, same as the dot-dir above.
 */
export const CLI_ENV_VAR_PREFIX = "QWEN_CODE";

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

/**
 * UPDATE_WEB_URL — the https(s) release-manifest address of the auto-update WEB
 * source (`<base>/manifest.json` + tarballs beside it). Baked at build time; the
 * ONLY way to change it on an install is a reinstall with a new bundle — there is
 * deliberately no URL field anywhere in the UI (credentials are the only
 * user-configurable part of a source). Empty string = source not offered.
 */
export const UPDATE_WEB_URL: string = "http://127.0.0.1:8080/dist-bundle/";

/**
 * UPDATE_GIT_HTTPS_URL — the git release repo over https, used when the user
 * configures username/password credentials for the git source. Same baked-only
 * rule as {@link UPDATE_WEB_URL}.
 */
export const UPDATE_GIT_HTTPS_URL: string = "";

/**
 * UPDATE_GIT_SSH_URL — the git release repo over ssh, used with a stored ssh key
 * or ambient `~/.ssh` keys (the zero-config default). Same baked-only rule as
 * {@link UPDATE_WEB_URL}.
 */
export const UPDATE_GIT_SSH_URL: string = "git@github.ru-code-dev:ru-code-dev/ru-code.git";

/**
 * UPDATE_GIT_BRANCH — which branch of the release repo carries `manifest.json`.
 * Empty string = whatever the remote's HEAD points at (git's own default), which is
 * exactly the pre-branch behaviour. Set it and BOTH git operations narrow to that
 * branch: the probe asks for `refs/heads/<branch>` — so a reachable repo with a
 * MISSING release branch now fails the probe instead of reporting a healthy source —
 * and the fetch clones with `--branch`. Baked at build time, like the URLs.
 */
export const UPDATE_GIT_BRANCH: string = "update-test";

/**
 * SUPPORT_CHANNEL_URL — where a user is sent when something they cannot fix went
 * wrong. Three consumers, all of them terminal/offline surfaces: the frozen
 * wrapper's «установка повреждена» banner, the installer (injected into the
 * generated `install` as `SUPPORT_CHAT_URL` — credits box, crash block and the
 * launch banners) and the service-worker fallback pages. The update-settings UI
 * does NOT use it. An EMPTY string is honoured everywhere: the support line is
 * omitted entirely rather than rendered blank.
 *
 * PLACEHOLDER — replace with the real support channel before shipping.
 */
export const SUPPORT_CHANNEL_URL: string = "https://support.ru-code.local/chat";

// ru-code: the five constants above are annotated `: string` on purpose. They are ADDRESSES a
// deployment edits, and every consumer decides at runtime whether one is empty ("source not
// offered" / "omit the support line"). Left as literal types, editing one to a non-empty value
// turns each of those `=== ""` guards into a compile error and the emptiness contract would rot.
//
// ru-code: every auto-update TUNABLE (budgets, cadences, caps, windows) lives in
// its own module so the engine and its UI hold zero magic numbers. The auto-update
// ADDRESSES stay above, beside the other identity constants.
export * from "./auto-update.ts";
/**
 * USE_NON_BLOCKIN_EDITORS_SCAN — how the server answers "which editors are installed?"
 * (`ServerConfig.availableEditors`, served by `server.getConfig` — the RPC the client's
 * connection gate waits for, and again by the `server.subscribeServerConfig` first frame).
 *
 * - `true` (default): the editor list is scanned ONCE in the background at server start and
 *   served from an in-memory cache, so no RPC ever runs a filesystem scan. The scan itself is
 *   also cheaper: one directory listing per PATH entry decides which entries can possibly hold
 *   a command, and only those candidates are confirmed — instead of probing every
 *   command × PATH-entry × PATHEXT combination. Same result, far fewer filesystem calls.
 *   Until the first scan completes the list is empty (a legal, already-supported value); it
 *   fills in and reaches clients through the normal config-update stream.
 * - `false`: upstream behaviour — every `server.getConfig` walks PATH inline. On Windows that
 *   is thousands of sequential filesystem probes (PATH entries × PATHEXT × upper/lower case),
 *   which on a slow machine can outlast the client's connection timeout, so the client tears
 *   the socket down and retries forever while the scan restarts from zero.
 *
 * Kept as a switch so the previous behaviour stays reachable for comparison.
 */
export const USE_NON_BLOCKIN_EDITORS_SCAN = true;
