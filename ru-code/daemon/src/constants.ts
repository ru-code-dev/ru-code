// ru-code: daemon-mode constants. This package owns all daemon logic; the app
// only carries thin marked seams that call into it (see specs/daemon/seam-map.md).

/** Fixed loopback port the background daemon binds by default (overridable via --port). */
export const DEFAULT_DAEMON_PORT = 7777;

/** Loopback host the daemon always binds — never a wildcard (corporate no-open-bind rule). */
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

/**
 * Env marker the parent sets on the spawned child. Its presence tells the child's
 * `runServerCommand` "you are the server, do NOT re-daemonize" — so `start` inside
 * the detached process runs the real HTTP server instead of spawning again.
 */
export const DAEMON_CHILD_ENV = "RU_CODE_DAEMON_CHILD";

/** How long the launcher waits for the child to come up and publish its pairing URL. */
export const READY_TIMEOUT_MS = 30_000;
/** Interval between readiness polls of the runtime-state file. */
export const READY_POLL_INTERVAL_MS = 200;

/**
 * How long `stop` waits for a graceful exit before escalating to SIGKILL. Must
 * exceed the app's own teardown budget: on SIGTERM the server kills its ACP
 * children itself (adapter finalizer; active turns get ACP_CANCEL_GRACE_MS=1500
 * before the unconditional kill), so the drain gives that a 5s window. Polling
 * exits as soon as the pid dies — an idle server still stops in ~200ms.
 */
export const STOP_DRAIN_TIMEOUT_MS = 5_000;
/** Interval between liveness polls while draining a stopping daemon. */
export const STOP_POLL_INTERVAL_MS = 100;

// ── Child-process cleanup ───────────────────────────────────────────────────
// The server is always killed by pid (from server-runtime.json). These control
// how its CHILD processes (qwen --acp, etc.) that outlive a hard kill are swept.

/**
 * Primary cleanup backend: reap the exact pids the app journals for every ACP
 * child it spawns (`<stateDir>/qwen-pids.<instanceSlug>.json`, written by
 * QwenProcessJournal — {pid, kind: session|warm, spawnedAt}, entry removed on
 * observed teardown). Kills via `process.kill` — a pure syscall, so it works on
 * locked-down Windows where pkill doesn't exist and taskkill may be blocked.
 * When false, the signature sweep below (PROCESSES_SIGNATURES) is used instead.
 */
export const KILL_BY_JOURNAL_PIDS = true;
/**
 * Optional pid-reuse guard for the journal reaper: before killing a journaled
 * pid, verify its command line still looks like our ACP child (Linux:
 * /proc/<pid>/cmdline; macOS: `ps -p <pid> -o command=`; Windows: no check —
 * killed unverified). Off by default: entries are removed on observed teardown,
 * so a stale pid exists only after a hard crash, and the reuse window is short.
 */
export const VERIFY_JOURNAL_PIDS_CMDLINE = false;
/**
 * How long the journal reaper watches killed pids die before deciding the
 * file outcome (delete when all gone vs rewrite with survivors). NOT a graceful
 * wait — it only observes the quick deaths (a SIGTERM'd child normally exits in
 * milliseconds); polling exits early once everything is gone.
 */
export const JOURNAL_REAP_SETTLE_MS = 500;

/**
 * Command-line signatures of our child processes (posix `pkill -f <sig>`) — the
 * fallback backend when KILL_BY_JOURNAL_PIDS is off. Two entries because the
 * spawn is dual-mode (ru-code/qwen/src/spawn.ts buildCliSpawn): a JS bin runs as
 * `node …/cli.js --acp`, a stock/native bin runs directly as `qwen --acp`.
 */
export const PROCESSES_SIGNATURES = ["cli.js --acp", "qwen --acp"] as const;
/** Master switch: sweep child processes on stop/restart/start-fresh. */
export const KILL_CHILDREN = true;

/**
 * How the **child** processes (qwen --acp, …) are group-killed. The server itself is
 * ALWAYS killed definitively regardless of this — it governs only the children:
 * - `"SIGKILL"`            — uncatchable hard kill; guaranteed no survivors, no finalize.
 * - `"SIGTERM_WITH_GRACE"` — polite terminate, wait `SIGTERM_GRACE_MS`, then SIGKILL stragglers.
 * - `"SIGTERM_NO_WAIT"`    — polite terminate, fire-and-forget; children finalize themselves
 *                            (one that ignores SIGTERM survives — no guarantee of death).
 */
export type GroupKillMethod = "SIGKILL" | "SIGTERM_WITH_GRACE" | "SIGTERM_NO_WAIT";
export const GROUP_KILL_METHOD: GroupKillMethod = "SIGTERM_NO_WAIT";
/** Grace window (ms) before escalating to SIGKILL under `"SIGTERM_WITH_GRACE"`. */
export const SIGTERM_GRACE_MS = 1_500;
/**
 * Windows only: use `taskkill /F /T /PID <serverPid>` to kill the server + its
 * child tree in one shot (best-effort — if AppLocker blocks it, children orphan).
 * When false, only the server pid is killed via `process.kill`.
 */
export const USE_TASK_KILL_FOR_WINDOWS = true;

/** How far above the desired port we probe for a free one before giving up. */
export const PORT_PROBE_LIMIT = 64;
/** How many times we re-pick a port and re-spawn if the child dies during startup. */
export const MAX_LAUNCH_ATTEMPTS = 3;
