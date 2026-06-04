/**
 * MCP Manager — seed data for the demo. No network, no probes: every value here is
 * hand-authored so the UI can be reviewed without any real MCP wiring.
 */

import type {
  McpProject,
  McpProjectBinding,
  McpRegistryServer,
} from "./types";

export const FAKE_PROJECTS: readonly McpProject[] = [
  { id: "proj-web", name: "ru-code · web", cwd: "/Users/user/WORKSPACE/Projects/ru-code/apps/web" },
  { id: "proj-server", name: "ru-code · server", cwd: "/Users/user/WORKSPACE/Projects/ru-code/apps/server" },
  { id: "proj-docs", name: "docs-site", cwd: "/Users/user/WORKSPACE/Projects/docs-site" },
];

export const FAKE_REGISTRY: readonly McpRegistryServer[] = [
  {
    id: "srv-filesystem",
    name: "filesystem",
    description:
      "Чтение и запись файлов в разрешённых каталогах. Базовый сервер для доступа к локальной файловой системе.",
    source: "builtin",
    tags: ["files", "local"],
    docsUrl: "https://modelcontextprotocol.io/servers/filesystem",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "${PROJECT_CWD}"],
      env: {},
    },
    tools: [
      {
        name: "read_file",
        description: "Прочитать содержимое файла.",
        params: [
          { name: "path", type: "string", required: true, description: "Путь к файлу." },
          {
            name: "encoding",
            type: "string",
            required: false,
            description: "Кодировка (по умолчанию utf-8).",
          },
        ],
      },
      {
        name: "write_file",
        description: "Создать или перезаписать файл.",
        params: [
          { name: "path", type: "string", required: true, description: "Путь к файлу." },
          { name: "content", type: "string", required: true, description: "Новое содержимое." },
        ],
      },
      {
        name: "list_directory",
        description: "Список файлов и папок в каталоге.",
        params: [{ name: "path", type: "string", required: true, description: "Путь к каталогу." }],
      },
      { name: "move_file", description: "Переместить или переименовать файл." },
    ],
  },
  {
    id: "srv-github",
    name: "github",
    description:
      "Доступ к репозиториям, issues и pull request'ам GitHub через официальный MCP-сервер.",
    source: "builtin",
    tags: ["git", "remote", "oauth"],
    docsUrl: "https://github.com/github/github-mcp-server",
    config: {
      transport: "http",
      httpUrl: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" },
    },
    tools: [
      {
        name: "search_repositories",
        description: "Поиск репозиториев.",
        params: [
          { name: "query", type: "string", required: true, description: "Поисковый запрос." },
          { name: "perPage", type: "number", required: false, description: "Результатов на страницу." },
        ],
      },
      {
        name: "get_issue",
        description: "Получить issue по номеру.",
        params: [
          { name: "owner", type: "string", required: true, description: "Владелец репозитория." },
          { name: "repo", type: "string", required: true, description: "Имя репозитория." },
          { name: "issue_number", type: "number", required: true, description: "Номер issue." },
        ],
      },
      { name: "create_pull_request", description: "Открыть pull request." },
      { name: "list_commits", description: "История коммитов ветки." },
      { name: "add_comment", description: "Добавить комментарий к issue или PR." },
    ],
  },
  {
    id: "srv-postgres",
    name: "postgres",
    description: "Только-чтение доступ к базе PostgreSQL: схемы, таблицы, безопасные SELECT-запросы.",
    source: "builtin",
    tags: ["database", "sql"],
    docsUrl: "https://modelcontextprotocol.io/servers/postgres",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      env: { DATABASE_URL: "${DATABASE_URL}" },
    },
    tools: [
      {
        name: "query",
        description: "Выполнить read-only SQL-запрос.",
        params: [
          { name: "sql", type: "string", required: true, description: "Текст SQL-запроса (только SELECT)." },
        ],
      },
      { name: "list_schemas", description: "Список схем базы данных." },
      {
        name: "describe_table",
        description: "Описание колонок таблицы.",
        params: [
          { name: "table", type: "string", required: true, description: "Имя таблицы." },
          { name: "schema", type: "string", required: false, description: "Схема (по умолчанию public)." },
        ],
      },
    ],
  },
  {
    id: "srv-context7",
    name: "context7",
    description: "Актуальная документация библиотек и фреймворков прямо в контексте модели.",
    source: "custom",
    tags: ["docs", "http"],
    docsUrl: "https://context7.com",
    config: {
      transport: "http",
      httpUrl: "https://mcp.context7.com/mcp",
      headers: {},
    },
    tools: [
      {
        name: "resolve_library",
        description: "Найти библиотеку по названию.",
        params: [{ name: "name", type: "string", required: true, description: "Название библиотеки." }],
      },
      {
        name: "get_docs",
        description: "Получить документацию по теме.",
        params: [
          { name: "libraryId", type: "string", required: true, description: "ID библиотеки из resolve_library." },
          { name: "topic", type: "string", required: false, description: "Конкретная тема или раздел." },
        ],
      },
    ],
  },
  {
    id: "srv-playwright",
    name: "playwright",
    description: "Управление браузером: навигация, клики, скриншоты, извлечение DOM для e2e-сценариев.",
    source: "custom",
    tags: ["browser", "testing"],
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: {},
    },
    tools: [
      {
        name: "browser_navigate",
        description: "Перейти по URL.",
        params: [{ name: "url", type: "string", required: true, description: "Адрес страницы." }],
      },
      {
        name: "browser_click",
        description: "Кликнуть по элементу.",
        params: [
          { name: "selector", type: "string", required: true, description: "CSS-селектор или ref элемента." },
        ],
      },
      { name: "browser_snapshot", description: "Снимок дерева доступности страницы." },
      {
        name: "browser_screenshot",
        description: "Сделать скриншот.",
        params: [
          { name: "fullPage", type: "boolean", required: false, description: "Снять всю страницу целиком." },
        ],
      },
    ],
  },
];

/**
 * Initial bindings. Note `srv-github` is bound to two projects to demonstrate that the
 * same registry server can live in multiple projects with different per-project state.
 */
export const FAKE_BINDINGS: readonly McpProjectBinding[] = [
  {
    projectId: "proj-web",
    serverId: "srv-filesystem",
    enabled: true,
    status: "connected",
    health: { latencyMs: 8, detail: "Стабильно · последняя проверка 12с назад" },
    toolOverrides: { move_file: false },
  },
  {
    projectId: "proj-web",
    serverId: "srv-github",
    enabled: true,
    status: "connected",
    health: { latencyMs: 142, detail: "Стабильно · 5 инструментов" },
    toolOverrides: {},
  },
  {
    projectId: "proj-web",
    serverId: "srv-context7",
    enabled: true,
    status: "connecting",
    health: { detail: "Подключение…" },
    toolOverrides: {},
  },
  {
    projectId: "proj-server",
    serverId: "srv-postgres",
    enabled: true,
    status: "error",
    health: { detail: "Не удалось подключиться: DATABASE_URL не задан" },
    toolOverrides: {},
  },
  {
    projectId: "proj-server",
    serverId: "srv-github",
    enabled: false,
    status: "disabled",
    health: { detail: "Отключён в этом проекте" },
    toolOverrides: {},
  },
  {
    projectId: "proj-server",
    serverId: "srv-playwright",
    enabled: true,
    status: "degraded",
    health: { latencyMs: 870, detail: "Медленные ответы · 0.9с" },
    toolOverrides: { browser_screenshot: false },
  },
];
