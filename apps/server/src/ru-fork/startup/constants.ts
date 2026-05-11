/**
 * Startup-gate constants. Mirrored by hand in:
 *   - `install` (bash, top-of-file constants block)
 *   - `apps/server/package.json` engines.node (NODE_ENGINE_RANGE only)
 *   - `package.json` (repo root) engines.node (NODE_ENGINE_RANGE only)
 *
 * Change procedure: update this file and every mirror site in the same
 * commit. Reviewer cross-checks all four.
 */
import { APP_NAME, CLI_NPM_PACKAGE } from "@ru-fork/branding";
import { CLI_BINARY_NAME, CLI_NAME } from "../../config.ts";

export const NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

/**
 * Minimum required CLI version (compared with `isAtLeast`).
 * Set to "" (empty string) to disable the version check and only
 * verify presence.
 */
export const CLI_MIN_VERSION = "0.13.1";

/**
 * Russian message strings. `{found}` is the only placeholder rendered
 * at use time. `NODE_ENGINE_RANGE`, `CLI_MIN_VERSION`, `CLI_NAME`, and
 * `CLI_BINARY_NAME` are baked in via template literals at module load
 * — same pattern as the bash mirror in `install`, which uses `${VAR}`
 * interpolation at definition time.
 *
 * Note: NODE_MISSING intentionally has no TS counterpart — node cannot
 * be missing in a running node process. The install script's
 * MSG_NODE_MISSING covers the pre-install case.
 */
export const MESSAGES = {
  HEADER: `${APP_NAME}: проверка зависимостей...`,
  NODE_OK: "  Node.js {found} ✓",
  NODE_LOW: `  Node.js {found} установлен, требуется ${NODE_ENGINE_RANGE}. Обновите: https://nodejs.org/`,
  GIT_OK: "  Git {found} ✓",
  GIT_MISSING: "  Git не найден на PATH. Установите Git: https://git-scm.com/downloads",
  GIT_BASH_REQUIRED: `  ${APP_NAME} должен запускаться из Git Bash. Установите Git for Windows: https://git-scm.com/downloads`,
  GIT_BROKEN:
    "  Git установлен, но команда `git --version` завершилась с ошибкой или превысила тайм-аут.",
  CLI_OK: `  ${CLI_NAME} {found} ✓`,
  CLI_MISSING: `  ${CLI_NAME} не найден. Установите: npm install -g ${CLI_NPM_PACKAGE}`,
  CLI_LOW: `  ${CLI_NAME} {found} установлен, требуется ≥ ${CLI_MIN_VERSION}. Обновите: npm install -g ${CLI_NPM_PACKAGE}@latest`,
  CLI_BROKEN: `  ${CLI_NAME} установлен, но команда \`${CLI_BINARY_NAME} --version\` завершилась с ошибкой или превысила тайм-аут.`,
  FOOTER_FAIL: "Установите недостающие компоненты и перезапустите.",
} as const;
