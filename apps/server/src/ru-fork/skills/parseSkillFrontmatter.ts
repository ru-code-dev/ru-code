// ru-fork: SKILL.md frontmatter parser — thin adapter over the
// shared scalar parser in `../common/scalarFrontmatter.ts`.
//
// Behavior is identical to the previous standalone implementation: the
// fence + colon scalar logic lives in common; this file only supplies
// the skill-specific alias map and narrows the result to `SkillFrontmatter`.

import { parseScalarFrontmatter } from "../common/scalarFrontmatter.ts";

export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly whenToUse?: string;
}

// Same key spellings the previous `aliasKey` switch handled — both the
// hyphenated/underscored YAML form and the squashed form.
const SKILL_KEY_ALIASES = new Map<string, keyof SkillFrontmatter>([
  ["name", "name"],
  ["description", "description"],
  ["argument-hint", "argumentHint"],
  ["argumenthint", "argumentHint"],
  ["when_to_use", "whenToUse"],
  ["whentouse", "whenToUse"],
]);

/**
 * Extract the frontmatter block of a SKILL.md file. Returns an empty
 * object if no leading `---` fence is present. Never throws.
 */
export const parseSkillFrontmatter = (source: string): SkillFrontmatter => {
  const raw = parseScalarFrontmatter(source, { keyAliases: SKILL_KEY_ALIASES });
  // Skills have no flow-array keys — every value is a string. The
  // `typeof v === "string"` guard is defensive; it would only filter if
  // a future caller registered an arrayKey under one of our aliases.
  const result: { -readonly [K in keyof SkillFrontmatter]: SkillFrontmatter[K] } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      result[key as keyof SkillFrontmatter] = value;
    }
  }
  return result;
};
