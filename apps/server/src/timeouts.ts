// SINGLE SOURCE OF TRUTH for every server-side timeout. All values in ms.
// ru-fork: no hardcoded timeout literal anywhere else in apps/server/src
// (intervals/TTLs are a different concept and stay where they are).
// Preflight keeps its own ru-fork/preflight/common/constants.ts (standalone bundle).

// subprocess collect (the exit-gated-collect fix)
export const EXIT_DRAIN_GRACE_MS = 250;

export const PROCESS_RUNNER_DEFAULT_TIMEOUT_MS = 60_000;

// CLI provider / text-gen / provider maintenance
// ru-fork: KEEP IN SYNC with ru-fork/preflight/common/constants.ts →
// CLI_PROBE_TIMEOUT_MS. Same `<cli> --version` probe; preflight is a standalone
// import-free bundle, so the value is duplicated there, not shared.
export const CLI_VERSION_PROBE_TIMEOUT_MS = 3_000;

export const CLI_TEXT_GENERATION_TIMEOUT_MS = 180_000;
export const PROVIDER_UPDATE_TIMEOUT_MS = 300_000;
export const PROVIDER_LATEST_VERSION_TIMEOUT_MS = 4_000; // npm-registry "latest" fetch

// git (by current value — behavior-preserving tiers)
export const GIT_TIMEOUT_FAST_MS = 5_000;
export const GIT_TIMEOUT_STANDARD_MS = 10_000;
export const GIT_TIMEOUT_FETCH_MS = 15_000;
export const GIT_TIMEOUT_NETWORK_MS = 20_000;
export const GIT_TIMEOUT_DEFAULT_MS = 30_000;
export const GIT_COMMIT_TIMEOUT_MS = 600_000;
export const GIT_STATUS_UPSTREAM_REFRESH_TIMEOUT_MS = 15_000;

// source control
export const SOURCE_CONTROL_DEFAULT_TIMEOUT_MS = 30_000;
// ru-fork: SOURCE_CONTROL_VERSION_PROBE_TIMEOUT_MS — KEEP IN SYNC with
// ru-fork/preflight/common/constants.ts → GIT_PROBE_TIMEOUT_MS. Same `<tool>
// --version` probe; preflight duplicates the value (can't import this file).
export const SOURCE_CONTROL_VERSION_PROBE_TIMEOUT_MS = 2_000; // `<tool> --version` (git/gh/…), local
export const SOURCE_CONTROL_AUTH_PROBE_TIMEOUT_MS = 5_000; // `<provider> auth status`, network
export const SOURCE_CONTROL_REPO_OP_TIMEOUT_MS = 120_000;

// terminal
export const TERMINAL_BUSY_CHECK_TIMEOUT_MS = 1_500;
export const TERMINAL_SUBPROCESS_CHECK_TIMEOUT_MS = 1_000;
export const TERMINAL_KILL_GRACE_MS = 1_000;

// daemon / CLI live-server probe
export const DAEMON_HEALTH_PROBE_TIMEOUT_MS = 1_000;
export const DAEMON_SPAWN_TIMEOUT_MS = 5_000;
export const PROJECT_CLI_LIVE_SERVER_TIMEOUT_MS = 1_000;

// ACP wire-stall / post-answer resume (moved verbatim from config.ts).
/**
 * ACP_WIRE_STALL_WARN_MS — soft threshold for "CLI seems stuck"
 * detection. While a turn is active, the adapter watches incoming
 * JSON-RPC frames on the ACP wire (every notification, response, or
 * frame from CLI). If no frame arrives for this many milliseconds,
 * a WARN log is emitted once per stall. No teardown — just visibility.
 */
export const ACP_WIRE_STALL_WARN_MS = 3_600_000;

/**
 * ACP_WIRE_STALL_KILL_MS — hard threshold. After this much wire
 * silence during an active turn the adapter declares the session
 * stuck and runs `abortSession(ctx, "end-force")`. The next user
 * message starts a fresh CLI child and `session/load`s the prior
 * transcript via the persisted resumeCursor. Backstop so a stuck
 * agent can never strand the chat indefinitely.
 */
export const ACP_WIRE_STALL_KILL_MS = 7_200_000;

/**
 * POST_ANSWER_RESUME_TIMEOUT_MS — one-shot timeout used by the
 * post-answer resume probe (`armPostAnswerResumeProbe` in
 * `AcpPendingRequests.ts`). After the adapter resolves a pending
 * user-input / approval / plan-approval Deferred, a fiber sleeps this
 * long and then checks `ctx.wireActivity.lastIncomingAt`. If CLI has
 * not produced a single inbound frame in that window, the session is
 * declared wedged and `abortSession(ctx, MAINTENANCE_METHOD)` is
 * called. Probe measurement showed the typical resume latency is
 * ~4 ms, so 10 s is ~2500× margin — generous but tight enough to
 * recover snappily.
 */
export const POST_ANSWER_RESUME_TIMEOUT_MS = 3_600_000;

/**
 * ACP_SESSION_START_TIMEOUT_MS — hard ceiling on the ACP start handshake
 * (`initialize` + `authenticate` + `session/new`|`session/load`). Unlike the
 * wire-stall thresholds above (which only apply DURING an active turn), nothing
 * else bounds the start: if a freshly-spawned `cli --acp` child hangs at boot
 * and never answers `initialize`, `startSession` would otherwise hang forever.
 * On timeout the adapter fails the start with a typed ProviderAdapterProcessError
 * (the session scope then closes and SIGKILLs the child). 60s is generous for a
 * cold node boot + qwen init (typically <10s) yet short enough to surface a wedge
 * and — for ru-fork MCP — release the ephemeral overlay promptly. Tunable.
 */
export const ACP_SESSION_START_TIMEOUT_MS = 60_000;
