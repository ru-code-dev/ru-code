// @ru-code/branding — every TUNABLE of the auto-update feature, in one file.
//
// The auto-update engine (apps/server/src/ru-code/auto-update/**) and its UI
// (apps/web/src/ru-code/auto-update-ui/**) must contain ZERO magic numbers: each
// budget, cadence, cap and window lives here so a fork can retune the whole
// feature by editing this one module. Several of these values are MIRRORED across
// the server/web/service-worker boundary (the 2h re-raise, the 2-minute manual
// window) — importing the single constant is what makes the two sides unable to
// drift.
//
// Addresses (URLs) are NOT here: they are identity, not tuning, and live beside
// the other branding constants in index.ts (UPDATE_WEB_URL / UPDATE_GIT_*_URL).

/**
 * UPDATE_NOTIFY_RERAISE_MS — the re-raise window of every dismissed/quiet update
 * notice: the "release available" and "sources need attention" surfaces come back
 * this long after the user waved them away. 2h is one working half-day: long
 * enough not to nag, short enough that a release is not missed for a whole day.
 *
 * MIRRORED by design across two clocks that must agree:
 * BOTH clocks are server-owned stamps (`notified.release` / `notified.problems`),
 * written when a notice is raised AND when the user waves it away — so every tab
 * agrees, a restart does not re-nag, and no browser storage is involved.
 * The server state machine (transitions.ts) and the client decision core
 * (notifyDecision.ts) both read THIS constant, so the two can never disagree.
 */
export const UPDATE_NOTIFY_RERAISE_MS = 2 * 60 * 60 * 1000;

/**
 * UPDATE_WORK_HOURS — the LOCAL-time hour window (inclusive) in which scheduled
 * checks fire: HH:jitter for HH in 08..17. Outside it the app never reaches for
 * the release host, so an idle overnight machine generates no traffic and the
 * user is never notified about a release they cannot act on.
 */
export const UPDATE_WORK_HOURS = { first: 8, last: 17 } as const;

/**
 * UPDATE_SCHEDULER_BEAT_MS — how often the engine's scheduler fiber wakes up to
 * ask "is `nextCheckAt` due yet?". It is NOT the check cadence (that is
 * {@link UPDATE_WORK_HOURS} + the per-install jitter); it is only the resolution
 * at which a due time is noticed. A 10-minute beat is deliberately coarse: the
 * wakeup does nothing but compare two numbers, and the value is the accepted
 * lateness — a scheduled check may start up to 10 minutes after its displayed
 * time.
 */
export const UPDATE_SCHEDULER_BEAT_MS = 10 * 60 * 1000;

/**
 * UPDATE_JITTER_MINUTES — the EXCLUSIVE upper bound of the per-install jitter
 * minute, i.e. the jitter is a whole minute in [0, UPDATE_JITTER_MINUTES - 1].
 * Generated once and persisted by configStore, it smears thousands of installs
 * across the hour so the release host never sees a thundering herd on the top of
 * each working hour. 60 = the full hour.
 */
export const UPDATE_JITTER_MINUTES = 60;

/**
 * UPDATE_PIN_ATTEMPTS — how many times the `update-relaunch` process probes the
 * pinned port before giving up. The relaunched child must bind EXACTLY the old
 * port (the SW updating page polls that origin; a drifted port is invisible to
 * the browser), so a still-busy port is retried, never worked around. After the
 * last attempt the relaunch STOPS and journals `port-busy` — an environmental
 * failure, never a version failure.
 */
export const UPDATE_PIN_ATTEMPTS = 3;

/**
 * UPDATE_PIN_RETRY_DELAY_MS — the gap between pinned-port probes. 30 s × 3
 * attempts ≈ 65 s of patience, which comfortably covers a dying server draining
 * its sockets while staying well inside the SW page's
 * {@link UPDATE_MANUAL_WINDOW_MS}, so a genuinely stuck port still lands the user
 * on the manual-restart screen rather than an endless spinner.
 */
export const UPDATE_PIN_RETRY_DELAY_MS = 30_000;

/**
 * UPDATE_INAPP_WAIT_MS — how long the APP itself rides out the restart before
 * handing the screen to the service worker.
 *
 * A restart is 3–10 s (same pinned port, payload already on disk), so the tab can
 * simply stay where it is, poll /healthz and reload itself on the new version —
 * no full-screen takeover, nothing lost, and the user watches it finish on the
 * card they pressed. Past this deadline the app is no longer "restarting", it is
 * DOWN, and the SW-served page — which is built for a dead server — takes over.
 */
export const UPDATE_INAPP_WAIT_MS = 5_000;

/**
 * UPDATE_RESTART_CEILING_MS — the hard ceiling on the in-app restart wait, whatever /healthz says.
 *
 * {@link UPDATE_INAPP_WAIT_MS} measures how long the server has been UNREACHABLE, and resets every
 * time it answers — which is what stops a slow-but-healthy restart from being escalated. That alone
 * would wait for ever against a server that stays up on the OLD version (a relaunch that never
 * replaced the process), so this bounds the whole wait. Generous: by the time it fires the tab has
 * watched a restart go nowhere for a minute, and the SW page can do better.
 */
export const UPDATE_RESTART_CEILING_MS = 60_000;

/**
 * UPDATE_INAPP_POLL_MS — how often the APP polls /healthz while it rides out the
 * restart. Faster than the SW page's cadence because the whole in-app window is
 * only {@link UPDATE_INAPP_WAIT_MS}: the return has to feel immediate, and a few
 * extra same-origin GETs against a tiny endpoint cost nothing.
 */
export const UPDATE_INAPP_POLL_MS = 750;

/**
 * UPDATE_MANUAL_WINDOW_MS — how long the SW-served restart screen waits for the
 * new server before revealing the manual-restart instructions. Polling CONTINUES
 * afterwards (a late server still auto-returns); this only decides when the user
 * is offered a way out. Sized against the real restart budget (see
 * {@link UPDATE_INAPP_WAIT_MS}): by the time this page is on screen the app has
 * already waited, so minutes of «ждём…» would be dishonest.
 */
export const UPDATE_MANUAL_WINDOW_MS = 45_000;

/**
 * UPDATE_HEALTHZ_POLL_MS — the in-app /updating page's poll cadence against the
 * tiny same-origin /healthz endpoint while it waits for the new server. Fast
 * enough that the return feels instant, cheap enough to run for minutes.
 */
export const UPDATE_HEALTHZ_POLL_MS = 2_000;

/** UPDATE_WEB_TIMEOUT_MS — GET budget for the web source's manifest / changelog / probe. */
export const UPDATE_WEB_TIMEOUT_MS = 10_000;

/**
 * UPDATE_WEB_BODY_CAP_BYTES — hard cap on a manifest / changelog body; the reader
 * never buffers more than this. These files are tiny, so anything larger is a
 * wrong endpoint (or a hostile one) and is rejected rather than read.
 */
export const UPDATE_WEB_BODY_CAP_BYTES = 1_048_576;

/**
 * UPDATE_GIT_PROBE_TIMEOUT_MS — reachability budget for a short-lived git-family
 * probe (`git ls-remote`, `ssh-keyscan`), then kill.
 */
export const UPDATE_GIT_PROBE_TIMEOUT_MS = 15_000;

/**
 * UPDATE_GIT_CLONE_TIMEOUT_MS — budget for fetching the release TARBALL out of git
 * (`git archive` of one blob, or materialising it in a metadata clone). This is a
 * real download of tens of megabytes over a link we know nothing about, so it keeps
 * the generous ceiling; the metadata steps have their own, far shorter budgets
 * ({@link UPDATE_GIT_ARCHIVE_TIMEOUT_MS} / {@link UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS}).
 */
export const UPDATE_GIT_CLONE_TIMEOUT_MS = 180_000;

/**
 * UPDATE_DOWNLOAD_TIMEOUT_MS — the total budget for ACQUIRING the release archive
 * during a user-pressed install: from the first byte requested to the last byte in
 * memory. Deliberately the same 180 s as {@link UPDATE_GIT_CLONE_TIMEOUT_MS}, which
 * is the budget for pulling the very same tarball out of git — one transfer, one
 * ceiling, whichever channel carries it.
 *
 * Why a total rather than an idle timeout: node's `http.get` has NO default timeout
 * of any kind, and a peer that completes the handshake, sends headers and then stops
 * sending body bytes emits no `error`, no `close` and no `aborted` — so without this
 * the run sits in `download` forever, holding the single apply permit and (because
 * the run object never becomes null) silently killing scheduled checks too. Recovery
 * was a server restart.
 *
 * The ceiling implies a floor on throughput: a ~34 MB release needs ≈ 190 KB/s to
 * finish in time, which any working link clears. On expiry the transfer is
 * INTERRUPTED (the socket is destroyed by the download's own cleanup, so nothing
 * keeps buffering) and the run fails visibly as `download-timeout`, releasing the
 * apply permit like any other failure.
 */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * UPDATE_CHECK_DEADLINE_MS — the wall-clock ceiling on ONE check round, start to settle.
 *
 * Every step inside a round already has its own budget ({@link UPDATE_GIT_PROBE_TIMEOUT_MS} +
 * {@link UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS} + {@link UPDATE_WEB_TIMEOUT_MS} ≈ 55 s worst case),
 * so this never fires on honest work. It exists because the check now REPLIES BEFORE IT SETTLES:
 * nothing is awaiting the round, so a step added later without a budget of its own would leave the
 * hero on «Проверяю…» with no way back. The deadline is what makes "the UI cannot show work that
 * is not happening" a property of the design rather than of every future edit.
 *
 * On expiry the round is interrupted and `checkAborted` returns the cards and the hero to their last
 * known state — no invented results, no spinner.
 */
export const UPDATE_CHECK_DEADLINE_MS = 3 * 60 * 1000;

/**
 * UPDATE_RUN_DEADLINE_MS — the wall-clock ceiling on ONE install run, press to hand-off.
 *
 * Same reasoning as {@link UPDATE_CHECK_DEADLINE_MS}, with one concrete hole it closes: the archive
 * extraction (in-process node-tar) has no timeout of its own, so a wedged extract — a disk that
 * stops answering — hangs the run forever and NO finalizer ever runs; a finalizer only helps if
 * the fiber ends. This guarantees it ends.
 *
 * Sized far above the honest worst case (a source round, then {@link UPDATE_DOWNLOAD_TIMEOUT_MS} or
 * {@link UPDATE_GIT_CLONE_TIMEOUT_MS} of transfer, then extract + verify, then the supersede round —
 * roughly 6-7 minutes together) because its job is to guarantee termination, not to police speed. A
 * slow machine on a slow link must still finish.
 *
 * The pointer flip and its journal write are `uninterruptible`, so this can never tear an install in
 * half: it either fires before the flip, or waits for the flip to finish.
 */
export const UPDATE_RUN_DEADLINE_MS = 15 * 60 * 1000;

/**
 * UPDATE_UI_TICK_ACTIVE_MS / UPDATE_UI_TICK_IDLE_MS — the cadence of the ONE shared
 * clock the auto-update UI derives its relative times from.
 *
 * It is adaptive because its two consumers want wildly different things and used to
 * share the faster one's cadence:
 *   · a LIVE run needs a real second hand — download percentage and «Перезапуск… N с»
 *     are watched while they move;
 *   · everything else is «последняя проверка 5 минут назад» and the two 2-hour
 *     re-raise windows ({@link UPDATE_NOTIFY_RERAISE_MS}). A one-second clock for a
 *     7 200-second window re-derives the whole UI state 7 200 times per window to
 *     notice one boundary.
 *
 * At 1 Hz the idle app re-ran `wireToUi` over the entire wire state, produced a fresh
 * object, and re-rendered every subscriber — once per second, forever, whether or not
 * an update existed anywhere. The idle cadence cuts that by 60× and costs only this:
 * a quiet window that expires may be noticed up to a minute late, which is inside the
 * noise of a two-hour timer.
 */
export const UPDATE_UI_TICK_ACTIVE_MS = 1_000;
export const UPDATE_UI_TICK_IDLE_MS = 60_000;

/** UPDATE_GIT_OUTPUT_CAP_BYTES — cap on captured git-family stdout/stderr. */
export const UPDATE_GIT_OUTPUT_CAP_BYTES = 200_000;

/**
 * UPDATE_HISTORY_ROWS — the newest-first check history is capped at this many
 * rows (the settings UI shows the recent tail). Bounded so the persisted state
 * can never grow without limit.
 */
export const UPDATE_HISTORY_ROWS = 8;

/**
 * DISABLE_SSL — turn OFF certificate verification for EVERY request the auto-update
 * path makes, and for those requests only: the web manifest / changelog / probe, the
 * tarball download, and the git operations (`ls-remote`, `archive`, `clone`).
 *
 * It exists because release hosts in this deployment are served by an internal CA
 * whose root is not installed on user machines, so a verifying client cannot reach
 * them at all. The switch is deliberately NOT exposed in the UI — it is a property
 * of the environment the build ships into, not a per-user preference.
 *
 * Scope is the point. The permissive setting is carried by an engine-scoped HTTP
 * agent, a per-request flag on the download, and one git env var — never by
 * `NODE_TLS_REJECT_UNAUTHORIZED`, which would silently disable verification for
 * provider calls, auth and every other outbound request in the process.
 *
 * Stated once, for the record: with verification off, the manifest and the tarball
 * arrive over the same unauthenticated connection, so the manifest's sha256 cannot
 * compensate for a tampered download — it only proves the two agree. Flip to
 * `false` in any deployment whose release host presents a trusted certificate.
 */
export const DISABLE_SSL = true;

/**
 * UPDATE_GIT_RELEASE_DIR — the directory INSIDE the release repository that carries
 * the release assets on {@link UPDATE_GIT_BRANCH}:
 * `<dir>/manifest.json`, `<dir>/changelog.json`, `<dir>/<tarball>`. It mirrors the
 * folder `prepare-release` emits, so the same tree can be published to a static web
 * host and committed to git without rearranging anything.
 */
export const UPDATE_GIT_RELEASE_DIR = "dist-bundle";

/**
 * RELEASE_SIGNING_PUBLIC_KEY — ed25519 public key for manifest signature verification.
 * The private key lives at `ru-code/keys/release-signing-private.pem` (gitignored).
 * `prepare-release` signs `sha256|version` with the private key; the client verifies
 * with this key after the sha256 step.
 */
export const RELEASE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+ypKgjizbTptlmA3vsK7iE3PbAajzwwe3zDXNos4QMQ=
-----END PUBLIC KEY-----`;

/**
 * UPDATE_GIT_ARCHIVE_TIMEOUT_MS — budget for a `git archive --remote` metadata read.
 * It transfers two small JSON files with no repository on disk, so a slow answer
 * means a wedged network rather than a big payload; the ladder falls through to a
 * clone when it expires.
 */
export const UPDATE_GIT_ARCHIVE_TIMEOUT_MS = 15_000;

/**
 * UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS — budget for the metadata clone
 * (`--filter=blob:none --no-checkout --depth 1`). No file content is transferred at
 * this step, so 30 s is generous; the previous 180 s was a DOWNLOAD budget applied to
 * a metadata read, and it made a dead git host freeze the check for three minutes.
 */
export const UPDATE_GIT_METADATA_CLONE_TIMEOUT_MS = 30_000;
