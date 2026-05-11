/**
 * APP_NAME — single source of truth for the application's short name.
 *
 * Used to derive every user-visible identifier that should be branded with
 * the app: the home directory (`~/.${APP_NAME}`), env var prefixes, temp
 * file prefixes, etc. Change here to rebrand everywhere.
 */
export const APP_NAME = "ru-fork";

/** `~/.${APP_NAME}` directory name (without leading `/`). */
export const APP_HOME_DIRNAME = `.${APP_NAME}`;
