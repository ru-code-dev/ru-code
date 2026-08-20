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

/**
 * ACP_WARM_ENGINE — single kill-switch for the warm-session engine (warm CLI
 * pool + instant-settle cancel-then-kill stop + starting feedback + coordinated
 * shutdown). false ⇒ spawn/stop behavior byte-identical to the classic path.
 * `QWEN_CODE_NO_RELAUNCH` is deliberately NOT behind this gate.
 */
export const ACP_WARM_ENGINE = true;

/**
 * ACP_CANCEL_GRACE_MS — grace between `session/cancel` and the unconditional
 * SIGKILL on a stop with an active turn. The cancel is what lets qwen reap
 * detached shell process-groups and finish its synchronous session-file
 * appends; the kill is the unmaskable backstop. Runs in a detached background
 * fiber — never on the stop path the user waits on.
 */
export const ACP_CANCEL_GRACE_MS = 1_500;

/**
 * PREWARM_GENERIC_INSTANCES — spares held in the GENERIC pool (empty MCP
 * allowlist — serves every project without enabled MCP tools, any cwd/chat).
 * Prewarmed at adapter start (first/default qwen instance only) and topped
 * back up on every take.
 */
export const PREWARM_GENERIC_INSTANCES = 2;

/**
 * MCP_PREWARM_INSTANCES — spares held PER MCP PROJECT (a project with enabled
 * tools has its own spares baked with its server allowlist). The project's
 * pool is created after its first successful start and topped up per take.
 */
export const MCP_PREWARM_INSTANCES = 2;

/**
 * MCP_PREWARM_MAX_PROJECTS — how many MCP projects hold spares simultaneously
 * (total MCP spares = this × MCP_PREWARM_INSTANCES). When a new MCP project
 * starts a chat at capacity, the least-recently-used project's spares are
 * discarded and the budget reallocates to the new project.
 */
export const MCP_PREWARM_MAX_PROJECTS = 2;

/**
 * WARM_REFILL_BREAKER_FAILS — consecutive spawn/warmup failures on one pool
 * after which the pool STOPS refilling (a broken CLI/config must never loop
 * respawns). Cold starts still surface the classified error as always; the
 * breaker resets on the next successful bind or an instance-settings change.
 */
export const WARM_REFILL_BREAKER_FAILS = 2;

/**
 * WARM_SLOT_MAX_AGE_ENABLED / WARM_SLOT_MAX_AGE_MS — RAM guard: an MCP
 * project whose pool saw NO activity (take/refill) for longer than the age
 * loses its spares WITHOUT respawn (its next start is cold-once, then the
 * pool re-fills). Idle-based per project — an actively used project's spares
 * never age out, however old the processes are. The generic pool is exempt
 * (it is the always-on fast path). Disable via the flag to keep spares forever.
 */
export const WARM_SLOT_MAX_AGE_ENABLED = true;
export const WARM_SLOT_MAX_AGE_MS = 30 * 60_000;

/** ACP_SESSION_START_TIMEOUT_MS — hard ceiling on the ACP start handshake. */
export const ACP_SESSION_START_TIMEOUT_MS = 60_000;

/**
 * WARM_SLOT_WARMUP_TIMEOUT_MS — hard ceiling on a warm slot's `initialize`
 * warmup. A prewarmed child can wedge without ever exiting (boot stalled
 * before qwen's ACP loop, or boot-window stdout garbage that poisons the
 * ndjson parser — the transport dies but the process lives), which the
 * idle-watcher (exit-based) cannot see. Past this ceiling the pool discards
 * the slot (child killed) and counts the breaker — otherwise the poisoned
 * slot sits in the pool and every take of it costs the full start timeout.
 */
export const WARM_SLOT_WARMUP_TIMEOUT_MS = 60_000;

/** CLI_VERSION_PROBE_TIMEOUT_MS — budget for `node cli.js --version`. */
export const CLI_VERSION_PROBE_TIMEOUT_MS = 3_000;

/** CLI_TEXT_GENERATION_TIMEOUT_MS — budget for one-shot `-p` text generation. */
export const CLI_TEXT_GENERATION_TIMEOUT_MS = 180_000;

/** EXIT_DRAIN_GRACE_MS — short drain after child exit before ending its stdio. */
export const EXIT_DRAIN_GRACE_MS = 250;
