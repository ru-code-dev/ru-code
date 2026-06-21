/**
 * ru-fork: Analytics — static tool→group reference (names + groups + labels).
 * Used to colour/label tools and to bucket unknown tools. All *data* now comes
 * from the server; this is presentation reference only.
 *
 * @module ru-fork/stats/model/catalog
 */
import type { ToolGroup } from "./types";

export interface ToolGroupEntry {
  readonly name: string;
  readonly group: ToolGroup;
}

/** Known native/MCP tools → their group. Unknown tools fall back in selectors. */
export const TOOLS: readonly ToolGroupEntry[] = [
  { name: "ask_user_question", group: "flow" },
  { name: "run_shell_command", group: "shell" },
  { name: "write_file", group: "fs" },
  { name: "read_file", group: "fs" },
  { name: "todo_write", group: "flow" },
  { name: "skill", group: "agent" },
  { name: "exit_plan_mode", group: "flow" },
  { name: "grep_search", group: "search" },
  { name: "glob", group: "search" },
  { name: "agent", group: "agent" },
  { name: "list_directory", group: "fs" },
  { name: "web_fetch", group: "web" },
  { name: "edit", group: "fs" },
];

export const TOOL_GROUP_LABEL: Record<ToolGroup, string> = {
  fs: "Файлы",
  shell: "Shell",
  search: "Поиск",
  flow: "Поток",
  agent: "Агенты",
  mcp: "MCP",
  web: "Веб",
};
