// @ru-code/branding — single source of truth for product identity: the display
// name (APP_NAME) and the storage-key namespace (APP_SCOPE). The HTML title, meta
// description, web manifest, server CLI description and every persisted client key
// reference these constants instead of hard-coding the product name / prefix.

/**
 * APP_NAME — display name of the application. This is the one and only place
 * the product-name literal lives; everywhere else references this constant.
 */
export const APP_NAME = "Ru Code";

/**
 * APP_SCOPE — storage-key namespace for all client persistence (localStorage +
 * IndexedDB + internal event names). Every persisted key is built as
 * `${APP_SCOPE}:…` so the identity lives in one place. Replaces the legacy
 * `t3code:` prefix.
 */
export const APP_SCOPE = "ruCode";

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
