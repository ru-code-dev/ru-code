// User-facing Russian strings. `{x}` placeholders are filled via render.ts.

import { CLI_PROFILES, DEFAULT_CLI_PROFILE_ID } from "@ru-code/branding";
import { CLI_MIN_VERSION, NODE_ENGINE_RANGE } from "./constants.ts";

// ru-code: preflight runs at boot (profile-agnostic) — label with the default profile.
const CLI_LABEL = CLI_PROFILES[DEFAULT_CLI_PROFILE_ID].name;

export const MESSAGES = {
  CONFIG_NOT_FOUND: `Каталог конфигурации ${CLI_LABEL} не найден. Проверены пути:`,
  SOURCES_DISAGREE:
    "Два источника расположения cli.js не совпадают (bin и .install-dir указывают на разное).",
  INSTALL_DIR_NOWHERE: "Файл .install-dir указывает на несуществующий cli.js.",
  CLI_NOT_FOUND: "cli.js не найден. Проверены пути:",
  NODE_OK: "Node.js {found} ✓",
  NODE_LOW: `Node.js {found} установлен, требуется ${NODE_ENGINE_RANGE}. Обновите: https://nodejs.org/`,
  GIT_OK: "Git {found} ✓",
  GIT_MISSING: "Git не найден на PATH. Установите Git: https://git-scm.com/downloads",
  GIT_BROKEN: "Git установлен, но `git --version` завершилась с ошибкой или превысила тайм-аут.",
  CLI_OK: `${CLI_LABEL} {found} ✓`,
  CLI_BROKEN: `${CLI_LABEL} установлен, но \`cli.js --version\` завершилась с ошибкой или превысила тайм-аут.`,
  CLI_LOW: `${CLI_LABEL} {found} установлен, требуется ≥ ${CLI_MIN_VERSION}. Обновите: установите ${CLI_LABEL}.`,
  CLI_TOO_SLOW: `${CLI_LABEL} работает слишком медленно на данном оборудовании, приложение будет работать не стабильно.`,
  FOOTER_FAIL: "Устраните указанные выше проблемы и перезапустите.",
  USING_BACKUP_PRIORITY:
    "Используется резервный CLI (TRY_TO_FIND_CLI имеет приоритет над основным).",
} as const;
