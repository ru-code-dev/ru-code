// ru-fork: filesystem skill scanner — feature-local constants.
//
// Cadence (`STALE_AFTER`) and scope vocabulary (`SCOPE_USER`/`SCOPE_PROJECT`)
// moved to `../common/constants.ts` so subagents reuse them. What's
// left here is genuinely skill-specific: the subdir name + manifest
// filename consumed by `scanCliSkillsDir.ts`.

export const SKILLS_SUBDIR = "skills";
export const SKILL_MANIFEST = "SKILL.md";
