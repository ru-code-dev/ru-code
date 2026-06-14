// ru-fork: the SHIPPED built-in MCP catalog — DATA ONLY. This is the single edit point for
// built-ins: add / remove / change entries here freely (any number, per-platform configs, shipped
// vars). No logic lives here — the type + helpers + the migrator (McpReactor) all operate off
// `McpBuiltinDefinition`, so editing this list never requires touching other code. Ship
// DECLARATIONS only — never real secret values (secret vars carry value:null).

import type { McpBuiltinDefinition } from "./McpBuiltins.ts";

export const MCP_BUILTINS: ReadonlyArray<McpBuiltinDefinition> = [
  {
    builtinId: "filesystem",
    name: "filesystem",
    description:
      "Чтение и запись файлов в каталоге проекта. Запускается локально через npx, без секретов.",
    websiteUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    config: {
      default: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "${PROJECT_CWD}"],
      },
    },
    vars: [],
  },
  {
    builtinId: "context7",
    name: "context7",
    description: "Актуальная документация библиотек и фреймворков. Публичный HTTP-эндпоинт.",
    websiteUrl: "https://context7.com",
    config: { default: { transport: "http", httpUrl: "https://mcp.context7.com/mcp", headers: {} } },
    vars: [],
  },
  {
    builtinId: "atlassian",
    name: "atlassian",
    description:
      "Доступ к Jira и Confluence: задачи, страницы, поиск. Укажите логины и API-токены в каталоге.",
    websiteUrl: "https://github.com/sooperset/mcp-atlassian",
    config: {
      default: {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-atlassian"],
      },
    },
    // All catalog-level (perProject:false), all required. The two URLs ship a placeholder value (the
    // user edits them); the logins are unfilled; the API tokens are secrets (value:null — never ship a
    // real secret). Until the unfilled ones are set, the catalog server shows «требует настройки».
    vars: [
      {
        name: "JIRA_URL",
        secret: false,
        perProject: false,
        required: true,
        value: "https://your-company.atlassian.net/wiki",
      },
      { name: "JIRA_USERNAME", secret: false, perProject: false, required: true, value: null },
      { name: "JIRA_API_TOKEN", secret: true, perProject: false, required: true, value: null },
      {
        name: "CONFLUENCE_URL",
        secret: false,
        perProject: false,
        required: true,
        value: "https://your-company.atlassian.net/wiki",
      },
      { name: "CONFLUENCE_USERNAME", secret: false, perProject: false, required: true, value: null },
      { name: "CONFLUENCE_API_TOKEN", secret: true, perProject: false, required: true, value: null },
    ],
  },
];
