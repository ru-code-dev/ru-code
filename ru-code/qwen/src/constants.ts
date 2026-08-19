// ru-code: qwen adapter constants. Self-contained so the module owns its own
// budgets/methods without editing the port's shared config.ts / timeouts.ts.

/**
 * AbortMethod — strategy used to tear down an ACP session. qwen-internal:
 * the adapter's `abortSession` branches on it. Not a wire/contract type.
 *   "cancel-turn"    — ACP session/cancel, keep the session alive (future).
 *   "end-graceful"   — ACP cancel then close the scope.
 *   "end-force"      — SIGKILL the child (unmaskable; cannot hang).
 */
export type AbortMethod = "cancel-turn" | "end-graceful" | "end-force";

/**
 * ACP_SERVER_NO_SSL — when true, the spawned ACP child runs with
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling TLS cert validation for HTTPS
 * inside that Node process (self-signed CA chains break WebFetch from the CLI).
 */
export const ACP_SERVER_NO_SSL = true;

/**
 * MCP_ENGINE_USE_OVERLAY — kill-switch for the MCP overlay engine. When true,
 * starting an ACP session injects the per-project settings overlay
 * (`QWEN_CODE_SYSTEM_SETTINGS_PATH`) + server allowlist. The overlay itself is
 * supplied by a separate feature; this adapter passes it through when present.
 */
export const MCP_ENGINE_USE_OVERLAY = true;

/**
 * STOP_BUTTON_METHOD — what the Stop button does. "end-force" because CLI builds
 * can ignore both `acp.cancel` and SIGTERM, hanging `Scope.close`. SIGKILL is
 * kernel-unmaskable and cannot hang. Context is preserved via session/load.
 */
export const STOP_BUTTON_METHOD: AbortMethod = "end-force";

/** MODE_CHANGE_METHOD — teardown on implicit session restart (mode/cwd change). */
export const MODE_CHANGE_METHOD: AbortMethod = "end-force";

/** MAINTENANCE_METHOD — teardown for non-user reasons (stopSession/stopAll/shutdown). */
export const MAINTENANCE_METHOD: AbortMethod = "end-force";

/**
 * COMPACTION_RESTART_METHOD — teardown after a CONFIRMED successful `/compress`.
 * qwen 0.13.1's ACP session captures its chat object once (acpAgent.ts:487) while
 * `tryCompressChat` replaces `client.chat` underneath it (client.ts:236), so the
 * live session keeps sending the FULL pre-compress history to the model — the
 * compression is recorded to the session file but never applied to the running
 * chat. Ending the session makes the next action resume via `session/load`
 * (same sessionId), which rebuilds the chat from the recorded COMPRESSED
 * history. "end-force" for the same hang-resistance reasons as the Stop button.
 */
export const COMPACTION_RESTART_METHOD: AbortMethod = "end-force";

/**
 * CONTEXT_WINDOW_TOKENS — FALLBACK context window advertised to the UI when
 * the model's own window is unknown (no profile value, no discovered
 * `contextLimit`, no `-256k` size suffix in the slug). Per-model resolution
 * lives in `resolveQwenModelContextWindow`.
 */
export const CONTEXT_WINDOW_TOKENS = 252_000;

/**
 * AUTO_COMPACT_USED_FRACTION — when a turn ends with usedTokens/window at or
 * above this fraction (and the `autoCompactContext` server setting is on), the
 * adapter runs a hidden `/compress`. qwen NEVER self-compacts over ACP (its
 * auto-compression is wired only into GeminiClient.sendMessageStream, which
 * the ACP session bypasses — qwen-code Session.ts drives GeminiChat directly),
 * so without this the context silently overflows.
 */
export const AUTO_COMPACT_USED_FRACTION = 0.75;

/**
 * AUTO_COMPACT_DISARM_FRACTION — circuit breaker: a compression that leaves
 * usage at/above this fraction of the window disarms auto-compact for the
 * thread (qwen re-summarizing its own summary yields ~0 gain, so re-firing
 * would loop). Re-arms once usage drops back below the line; manual
 * "Compact context" stays available regardless.
 */
export const AUTO_COMPACT_DISARM_FRACTION = 0.6;

/**
 * COMPACT_MIN_GAIN_PRE_FRACTION — a compression that frees less than this
 * share of the PRE-compaction usage counts as ineffective (qwen
 * re-summarizing its own summary): the row warns and advises, but
 * auto-compact stays armed — only the disarm gate above trips the breaker.
 * Deliberately relative to the dialog, not the model window: on a 1M-window
 * model a 60k dialog can never free 5% of the window, yet halving it is a
 * perfectly effective compression.
 */
export const COMPACT_MIN_GAIN_PRE_FRACTION = 0.1;

/**
 * QWEN_MODELS_AUTO_DISCOVERY — kill-switch for model auto-discovery. When
 * false, session advertisements are not persisted, model-error corrections
 * are not applied, and serving ignores the discovered store (profile +
 * custom models only).
 */
export const QWEN_MODELS_AUTO_DISCOVERY = true;

/** ACP_SESSION_START_TIMEOUT_MS — hard ceiling on the ACP start handshake. */
export const ACP_SESSION_START_TIMEOUT_MS = 60_000;

/** CLI_VERSION_PROBE_TIMEOUT_MS — budget for `node cli.js --version`. */
export const CLI_VERSION_PROBE_TIMEOUT_MS = 3_000;

/** CLI_TEXT_GENERATION_TIMEOUT_MS — budget for one-shot `-p` text generation. */
export const CLI_TEXT_GENERATION_TIMEOUT_MS = 180_000;

/** EXIT_DRAIN_GRACE_MS — short drain after child exit before ending its stdio. */
export const EXIT_DRAIN_GRACE_MS = 250;
