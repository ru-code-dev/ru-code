/**
 * ru-fork: Analytics — the dimension catalog the fake generator samples from.
 * Weights/labels are lifted from the real `projects/` scan so the demo reads
 * like genuine usage (model, project mix, tool histogram, error types, branches).
 *
 * Each catalog is typed as a non-empty tuple so the weighted picker can return a
 * definite element without any cast.
 *
 * @module ru-fork/stats/model/catalog
 */
import type { ProjectKind, ToolGroup } from "./types";

/** Anything the weighted random picker can choose between. */
export interface Weighted {
  readonly weight: number;
}

export interface ProjectDefinition extends Weighted {
  readonly projectId: string;
  readonly label: string;
  readonly path: string;
  readonly kind: ProjectKind;
}

/** Real projects (+ a folded "sandbox" group for the many temp dirs). */
export const PROJECTS: readonly [ProjectDefinition, ...ProjectDefinition[]] = [
  { projectId: "ai-playground", label: "ai-playground", path: "~/WORKSPACE/Projects/ai-playground", kind: "real", weight: 38 },
  { projectId: "atomic-code", label: "atomic-code", path: "~/WORKSPACE/Projects/experements/atomic-code", kind: "real", weight: 24 },
  { projectId: "t3code", label: "t3code", path: "~/WORKSPACE/Projects/experements/t3code", kind: "real", weight: 20 },
  { projectId: "test1", label: "test1", path: "~/WORKSPACE/test1", kind: "real", weight: 6 },
  { projectId: "server", label: "t3code-apps-server", path: "~/WORKSPACE/Projects/experements/t3code-apps-server", kind: "real", weight: 3 },
  { projectId: "test3", label: "test3", path: "~/WORKSPACE/test3", kind: "real", weight: 2 },
  { projectId: "sandbox", label: "Песочница / temp", path: "/var/folders/…/acp-test-*", kind: "temp", weight: 14 },
];

export interface ModelDefinition extends Weighted {
  readonly modelId: string;
  readonly label: string;
  readonly contextWindow: number;
}

/** qwen3.6-35b dominates the real data; the others give the model widget life. */
export const MODELS: readonly [ModelDefinition, ...ModelDefinition[]] = [
  { modelId: "qwen/qwen3.6-35b-a3b", label: "qwen3.6-35b-a3b", contextWindow: 60_000, weight: 72 },
  { modelId: "qwen/qwen3.6-coder-7b", label: "qwen3.6-coder-7b", contextWindow: 32_000, weight: 16 },
  { modelId: "qwen/qwen3.6-72b-a14b", label: "qwen3.6-72b-a14b", contextWindow: 128_000, weight: 12 },
];

export interface BranchDefinition extends Weighted {
  readonly name: string;
}

export const BRANCHES: readonly [BranchDefinition, ...BranchDefinition[]] = [
  { name: "ru-code", weight: 30 },
  { name: "feat/qwen", weight: 26 },
  { name: "main", weight: 20 },
  { name: "feat/public", weight: 14 }
];

export interface ToolDefinition extends Weighted {
  readonly name: string;
  readonly group: ToolGroup;
  /** Baseline success probability (mirrors the real per-tool ok-rate). */
  readonly successRate: number;
}

export const TOOLS: readonly [ToolDefinition, ...ToolDefinition[]] = [
  { name: "ask_user_question", group: "flow", weight: 159, successRate: 0.61 },
  { name: "run_shell_command", group: "shell", weight: 132, successRate: 0.91 },
  { name: "write_file", group: "fs", weight: 115, successRate: 0.85 },
  { name: "read_file", group: "fs", weight: 115, successRate: 1.0 },
  { name: "todo_write", group: "flow", weight: 80, successRate: 0.99 },
  { name: "skill", group: "agent", weight: 69, successRate: 0.65 },
  { name: "exit_plan_mode", group: "flow", weight: 67, successRate: 0.18 },
  { name: "grep_search", group: "search", weight: 53, successRate: 1.0 },
  { name: "glob", group: "search", weight: 53, successRate: 0.85 },
  { name: "agent", group: "agent", weight: 49, successRate: 0.96 },
  { name: "list_directory", group: "fs", weight: 30, successRate: 0.87 },
  { name: "web_fetch", group: "web", weight: 22, successRate: 0.73 },
  { name: "edit", group: "fs", weight: 22, successRate: 0.95 },
  { name: "mcp__context7__query-docs", group: "mcp", weight: 6, successRate: 1.0 },
  { name: "mcp__context7__resolve-library-id", group: "mcp", weight: 6, successRate: 1.0 },
];

export interface ErrorTypeDefinition extends Weighted {
  readonly type: string;
}

export const ERROR_TYPES: readonly [ErrorTypeDefinition, ...ErrorTypeDefinition[]] = [
  { type: "APIUserAbortError", weight: 28 },
  { type: "APIError", weight: 12 },
  { type: "BadRequestError", weight: 8 },
  { type: "APIConnectionError", weight: 2 },
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
