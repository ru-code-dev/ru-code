// @ru-code/branding — what a CLI RELOAD removes from the CLI's profile dir, and whether an
// idle expiry removes it too. CONFIG ONLY: the reload engine
// (apps/server/src/ru-code/cli-reload) reads these two constants and nothing else decides
// what gets deleted.
//
// Why branding owns them: the entries name files INSIDE the CLI's own profile dir, i.e. CLI
// identity data — the same thing cliProfiles.ts (`dirDefault`) and cliEnv.ts (the HOME row)
// own. A fork that re-skins the CLI changes the list here and nowhere else.

/**
 * DELETE_ON_CLI_RESTART — profile-dir entries removed after every CLI reload, once every
 * CLI process is dead. Each entry is a RELATIVE path spelled with posix `/` separators; the
 * engine joins it onto each live instance's resolved profile dir with the native separator
 * (`path.join(dir, ...entry.split("/"))`) and removes it recursively, force, missing ignored.
 * A trailing `/` is allowed and ignored — files and directories are removed the same way.
 *
 * SHIPS EMPTY (owner ruling R10): a reload restarts the CLI and refreshes authorization; it
 * does not throw anything away until a specific file is proven to need it. Adding an entry is
 * a data-loss decision — `<profileDir>` also holds the user's globally installed
 * skills/agents/commands (qwen-cli-catalog-core engine.ts writes `<cliConfigDir>/<subdir>`)
 * and the transcripts the extended chat reads (`<cliConfigDir>/projects/**`).
 */
export const DELETE_ON_CLI_RESTART: readonly string[] = [];

/**
 * REMOVE_SESSION_FILES_ON_EXPIRY — whether {@link DELETE_ON_CLI_RESTART} is also applied when
 * the warm pool's idle window expires (RESET_ACP_SESSIONS_AFTER_HOURS) and once at server
 * boot, not only on a manual reload.
 *
 * SHIPS FALSE (owner ruling R10): the manual reload is the only sanctioned deleter until the
 * list itself is non-empty.
 */
export const REMOVE_SESSION_FILES_ON_EXPIRY = false;
