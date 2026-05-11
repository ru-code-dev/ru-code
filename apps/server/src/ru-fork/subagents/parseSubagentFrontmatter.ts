// ru-fork: subagent .md frontmatter parser — thin adapter over the
// shared scalar parser in `../common/scalarFrontmatter.ts`.
//
// Same approach as `../skills/parseSkillFrontmatter.ts`. Subagent files
// add a flow-array key (`tools`) that the shared parser supports via
// `arrayKeys`. `modelConfig`/`runConfig` (CLI's block scalars) are
// silently ignored — CLI reads them from the file directly at execution
// time; the picker doesn't need them.

import { parseScalarFrontmatter } from "../common/scalarFrontmatter.ts";

export interface SubagentFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly color?: string;
}

const SUBAGENT_KEY_ALIASES = new Map<string, keyof SubagentFrontmatter>([
  ["name", "name"],
  ["description", "description"],
  ["tools", "tools"],
  ["color", "color"],
]);

const SUBAGENT_ARRAY_KEYS = new Set<string>(["tools"]);

export const parseSubagentFrontmatter = (source: string): SubagentFrontmatter => {
  const raw = parseScalarFrontmatter(source, {
    keyAliases: SUBAGENT_KEY_ALIASES,
    arrayKeys: SUBAGENT_ARRAY_KEYS,
  });
  const result: { -readonly [K in keyof SubagentFrontmatter]: SubagentFrontmatter[K] } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "tools") {
      if (Array.isArray(value)) result.tools = value;
      continue;
    }
    if (typeof value === "string") {
      result[key as "name" | "description" | "color"] = value;
    }
  }
  return result;
};
