// ru-fork: shared constants for `.qwen/<thing>/` filesystem scanners.
// Skills today, subagents next.

import * as Duration from "effect/Duration";

/**
 * Per-cwd cache entry is considered "stale" after this much time —
 * a re-read returns the cached value immediately and forks a refresh.
 * Forced refreshes (the per-feature `/refresh-*` composer command)
 * bypass this. Identical value to the original `skills/constants.ts`.
 */
export const STALE_AFTER = Duration.minutes(5);

/**
 * Scope tag stored on each scanned item's `scope` field — matches
 * cli-code's level vocabulary. The original `SCOPE_GLOBAL = "user"`
 * in skills/constants.ts has the same value; we use `SCOPE_USER` to
 * avoid the "global" misnomer in the new shared code.
 */
export const SCOPE_USER = "user";
export const SCOPE_PROJECT = "project";
