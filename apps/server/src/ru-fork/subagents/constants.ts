// ru-fork: filesystem subagent scanner — feature-local constants.
//
// Cadence (`STALE_AFTER`) and scope vocabulary (`SCOPE_USER`/`SCOPE_PROJECT`)
// live in `../common/constants.ts`. What's left here is genuinely
// subagent-specific: the subdir name + the third "builtin" scope tag
// that has no skills analogue.

export const AGENTS_SUBDIR = "agents";

// Skills only know user/project; subagents add a static built-in bucket
// snapshotted from cli-code's BuiltinAgentRegistry.
export const SCOPE_BUILTIN = "builtin";
