// ru-code PIN SUITE — the §5 reconnect loop (production-error.md), reproduced end-to-end.
//
// Field report: one user's app showed «no connection» every 5–10 s forever; the server
// logged `threadSnapshot … errorTag: 'Interrupt'`; reloads never helped; deleting user
// data "fixed" it. The proven chain: a thread whose snapshot cannot be served inside the
// client's windows (6 s HTTP timeout, 5 s WS pong window) makes the client kill and
// re-dial the connection, and every reconnect replays the identical cold subscribe — the
// cache never warms, so the loop is permanent (threads.ts / RpcClient makePinger).
//
// A dev machine serves realistic threads orders of magnitude faster than the field
// machine (measured: ~2.9 ms/MiB — see threadSnapshotScale.perf.test.ts), so raw data
// volume cannot push serving past the windows here. Instead these pins model "serving
// always takes longer than the client windows" black-box: a freeze/thaw duty cycle on
// the REAL server (SIGSTOP 12 s / SIGCONT 2 s) — alive, answering, but never fast
// enough to finish a BIG thread's snapshot inside one alive window. A small thread
// fits in one alive window, so L2 (control) must load; the big thread (L1) can only
// load if the client can make progress across interruptions.
//
// L1 is the requirement pin and STAYS RED THROUGH PHASE 1 BY DECISION
// (boot-performance.md): its failing leg is ONE giant snapshot frame that cannot fit
// in any alive window, and the phase-1 fixes (S1/S2/S3/S5/G/M/W/D) deliberately do
// not touch frame size — the browser surfaces only COMPLETE WS messages, so no
// cursor/backoff/policy change can make progress inside a single unfinished frame.
// L1's fix is PHASE-2 SNAPSHOT PAGINATION (resumable/paginated thread detail); only
// that turns it green. Never edit this pin to pass. L2 green + L1 red together prove
// the failure is size-dependent, exactly like the field ("deleting user data fixed
// it").

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mkTemp } from "../harness/primitives.ts";
import {
  bootPin,
  CONNECTION_ERROR_PATTERN,
  freeze,
  readDaemonLog,
  runPinCleanups,
  runSql,
  saveEvidence,
  thaw,
  type PinnedApp,
} from "../harness/pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const THREAD_ID = "pin-loop-thread";
const SENTINEL = "PIN-LOOP-SENTINEL-MESSAGE";
// Calibrated on the reference machine (see L1-evidence.json history): a 384 MiB thread's
// server-side serve + transfer needs ~1.1–2 s, so a 1 s alive window can never fit it,
// while a ~2 MiB thread clears in well under one window. A dial made while the server is
// frozen completes AT thaw (the kernel backlog accepts the TCP handshake), so alive
// windows are fully usable for serving — the window bounds SERVING, not reconnecting.
const FREEZE_MS = 12_000;
const THAW_MS = 1_000;

/** Seed a project + one thread with `payloadRows` activity rows of ~256 KiB each. */
function seedThread(app: PinnedApp, payloadRows: number): void {
  const filler = "tool output line with paths and exit codes; ".repeat(6000); // ≈256 KiB
  runSql(app, (db) => {
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      "pin-loop-project",
      "Pin loop project",
      "/tmp/pin-loop-project",
      '{"provider":"codex","model":"gpt-5-codex"}',
      "[]",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, latest_user_message_at,
        pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, 0, ?, ?, NULL)`,
    ).run(
      THREAD_ID,
      "pin-loop-project",
      "Pin loop thread",
      '{"provider":"codex","model":"gpt-5-codex"}',
      "full-access",
      "default",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (?, ?, NULL, 'user', ?, 0, ?, ?)`,
    ).run(
      "pin-loop-message",
      THREAD_ID,
      SENTINEL,
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:01.000Z",
    );
    const insertActivity = db.prepare(
      `INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      ) VALUES (?, ?, NULL, 'info', 'runtime.note', ?, ?, ?)`,
    );
    for (let row = 0; row < payloadRows; row++) {
      insertActivity.run(
        `pin-loop-activity-${row}`,
        THREAD_ID,
        `Ran tool step ${row}`,
        `{"taskId":"task-${row}","status":"completed","output":${JSON.stringify(filler)}}`,
        "2026-01-01T00:00:02.000Z",
      );
    }
    db.exec("COMMIT");
  });
}

interface DutyCycle {
  stop(): Promise<void>;
}

/** SIGSTOP `freezeMs` / SIGCONT `thawMs`, until stopped. Always leaves the server thawed. */
function startDutyCycle(app: PinnedApp): DutyCycle {
  const state = { running: true };
  const done = (async () => {
    while (state.running) {
      try {
        freeze(app.pid);
      } catch {
        return;
      }
      await sleep(FREEZE_MS);
      try {
        thaw(app.pid);
      } catch {
        return;
      }
      await sleep(THAW_MS);
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await done;
      try {
        thaw(app.pid);
      } catch {
        /* already gone */
      }
    },
  };
}

interface StallObservation {
  readonly sentinelSeen: boolean;
  readonly bannerSightings: number;
  readonly bannerEpisodes: number;
  readonly elapsedMs: number;
}

/** Watch the page under the duty cycle: did the thread ever render? how often did the banner cycle? */
async function observeUnderStall(page: Page, windowMs: number): Promise<StallObservation> {
  const startedAt = Date.now();
  let sentinelSeen = false;
  let bannerSightings = 0;
  let bannerEpisodes = 0;
  let bannerVisible = false;
  while (Date.now() - startedAt < windowMs) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (bodyText.includes(SENTINEL)) {
      sentinelSeen = true;
      break;
    }
    const bannerNow = CONNECTION_ERROR_PATTERN.test(bodyText);
    if (bannerNow) bannerSightings += 1;
    if (bannerNow && !bannerVisible) bannerEpisodes += 1;
    bannerVisible = bannerNow;
    await sleep(500);
  }
  return { sentinelSeen, bannerSightings, bannerEpisodes, elapsedMs: Date.now() - startedAt };
}

test("L1: BIG cold thread + slow-serving server → client must still load it (RED until phase-2 pagination)", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  test.setTimeout(420_000);
  const app = await bootPin({ name: "l1-loop-big", env: { RU_CODE_WARM_ENGINE: "0" } });
  // ~384 MiB of activity payloads: far above what ONE 1 s alive window can serve
  // through query + encode + transfer (measured ~1.1–2 s on the reference machine),
  // far below the ~512 MiB V8 string ceiling that would break encoding outright.
  seedThread(app, 1536);

  // The duty cycle must be running BEFORE the detail load starts, or the click races
  // a still-fast server and the snapshot serves clean (first calibration run did
  // exactly that). The shell/thread list may load fast — field-real: the reporter's
  // sidebar worked; only the thread detail looped.
  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  const row = page.locator('[data-testid^="thread-row"]').first();
  await expect(row, "seeded thread visible in the sidebar").toBeVisible({ timeout: 30_000 });
  const cycle = startDutyCycle(app);
  let observation: StallObservation;
  try {
    await row.click();
    // ~7 full freeze/thaw cycles — the field cadence («no connection» every 5–10 s).
    observation = await observeUnderStall(page, 100_000);
  } finally {
    await cycle.stop();
  }

  // With the server permanently thawed the same seed MUST load quickly — this
  // validates the repro end-to-end (seed decodes, UI renders, only the stall was in
  // the way). If THIS fails the pin is invalid, not the requirement.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => document.body.innerText).catch(() => "")).includes(SENTINEL),
      {
        timeout: 120_000,
        message: "harness validation: thread must render once the server is fast again",
      },
    )
    .toBe(true);

  const interruptLines = readDaemonLog(app)
    .split("\n")
    .filter((line) => /threadSnapshot|Interrupt/i.test(line))
    .slice(-40);
  saveEvidence(
    "L1-evidence.json",
    JSON.stringify(
      { ...observation, freezeMs: FREEZE_MS, thawMs: THAW_MS, interruptLines },
      null,
      2,
    ),
  );

  // THE REQUIREMENT (RED until phase-2 snapshot pagination — see the header): a
  // slow-but-alive server must not strand the client in the reconnect loop — the
  // thread must render DURING the stall window. Only a resumable/paginated snapshot
  // can achieve that for ONE giant frame; the phase-1 fixes intentionally leave this
  // leg red as the acceptance instrument for phase 2.
  expect(
    observation.sentinelSeen,
    `thread never rendered under a slow server: ${observation.bannerEpisodes} connection-banner episodes ` +
      `(${observation.bannerSightings} sightings) in ${observation.elapsedMs} ms — the §5 permanent reconnect loop`,
  ).toBe(true);
});

// The field-visible banner ("<label>: Failed to connect. Reconnecting... Reason: <label>
// could not establish a WebSocket connection.") renders in ChatView's composer banner
// stack (ChatView.tsx ~1852) — it needs an ACTIVE thread view and a supervisor state
// with a recorded failure (presentation.ts:66-69). A failed DIAL takes ping-death
// (~10 s) + redial + the 15 s socket open-timeout (session.ts:23) of continuous server
// unresponsiveness — L1/L2's 12 s freezes could never produce one (a SIGSTOPPED
// listener still ACCEPTS TCP, so short-freeze dials hang and then succeed at thaw,
// recording no failure). L3 freezes for 30 s so dials genuinely fail, with a LOADED
// thread on screen so the banner has a surface to render on.
const BANNER_FREEZE_MS = 30_000;
const BANNER_THAW_MS = 4_000;
// The RU build renders connectionStatusText as «Не удалось подключиться.
// Переподключение... Причина: <label> соединение разорвано / не удалось установить
// WebSocket-соединение» — match BOTH locales (an EN-only pattern recorded 0 sightings
// while the banner was on screen; see L3-evidence midFreezeProbe history).
const BANNER_PATTERN = new RegExp(
  `${CONNECTION_ERROR_PATTERN.source}|Failed to connect\\. Reconnecting|Не удалось подключиться`,
  "i",
);

interface BannerObservation {
  readonly episodes: number;
  readonly sightings: number;
  readonly samples: ReadonlyArray<string>;
  readonly elapsedMs: number;
}

/** Track banner appear→disappear→appear cycles; collect the actual on-screen lines. */
async function observeBannerCycles(page: Page, windowMs: number): Promise<BannerObservation> {
  const startedAt = Date.now();
  const samples = new Set<string>();
  let episodes = 0;
  let sightings = 0;
  let visible = false;
  while (Date.now() - startedAt < windowMs) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const matched = BANNER_PATTERN.test(bodyText);
    if (matched) {
      sightings += 1;
      if (!visible) episodes += 1;
      if (samples.size < 6) {
        for (const line of bodyText.split("\n")) {
          if (BANNER_PATTERN.test(line)) samples.add(line.trim());
        }
      }
    }
    visible = matched;
    await sleep(500);
  }
  return { episodes, sightings, samples: [...samples], elapsedMs: Date.now() - startedAt };
}

test("L3: the field banner cycles — appears on failed dials, clears on reconnect, reappears", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  test.setTimeout(420_000);
  const app = await bootPin({ name: "l3-loop-banner", env: { RU_CODE_WARM_ENGINE: "0" } });
  seedThread(app, 8);

  // Socket forensics: record every WebSocket the page opens, when it closes and
  // with what code, and every console line — S5's evidence (0 sightings, empty
  // console during 10 pulsed freezes) says the client may never NOTICE a frozen
  // server; this instrumentation decides that question instead of theory.
  await page.addInitScript(() => {
    const log: Array<{
      url: string;
      openedAtMs: number;
      closedAtMs: number | null;
      closeCode: number | null;
    }> = [];
    (window as unknown as { __wsLog: typeof log }).__wsLog = log;
    const t0 = Date.now();
    const NativeWebSocket = window.WebSocket;
    const Wrapped = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new NativeWebSocket(url, protocols);
      const entry = {
        url: String(url),
        openedAtMs: Date.now() - t0,
        closedAtMs: null as number | null,
        closeCode: null as number | null,
      };
      log.push(entry);
      socket.addEventListener("close", (event) => {
        entry.closedAtMs = Date.now() - t0;
        entry.closeCode = (event as CloseEvent).code;
      });
      return socket;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = NativeWebSocket.prototype;
    Object.defineProperties(Wrapped, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED },
    });
    window.WebSocket = Wrapped;
  });
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    if (consoleLines.length < 300) consoleLines.push(`[${message.type()}] ${message.text()}`);
  });

  // Load the thread COMPLETELY first — the banner needs the thread view on screen.
  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  const row = page.locator('[data-testid^="thread-row"]').first();
  await expect(row, "seeded thread visible in the sidebar").toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByText(SENTINEL), "thread content rendered").toBeVisible({
    timeout: 30_000,
  });

  // Freeze long enough for a dial to FAIL: ping-death ~10 s + redial + 15 s open
  // timeout ≈ 26 s < 30 s. Thaw reconnects (clearing the banner), then the next
  // freeze restarts the cycle — the field's appear/disappear/reappear rhythm.
  const cycle = { stop: async () => {} };
  const state = { running: true };
  const done = (async () => {
    while (state.running) {
      try {
        freeze(app.pid);
      } catch {
        return;
      }
      await sleep(BANNER_FREEZE_MS);
      try {
        thaw(app.pid);
      } catch {
        return;
      }
      await sleep(BANNER_THAW_MS);
    }
  })();
  cycle.stop = async () => {
    state.running = false;
    await done;
    try {
      thaw(app.pid);
    } catch {
      /* already gone */
    }
  };

  let observation: BannerObservation;
  let midFreezeProbe: unknown = null;
  const probeUi = () =>
    page
      .evaluate(() => ({
        contenteditableCount: document.querySelectorAll('div[contenteditable="true"]').length,
        extendedChatMarkers: document.querySelectorAll('[data-testid*="extended"]').length,
        testIds: [...document.querySelectorAll("[data-testid]")]
          .map((el) => el.getAttribute("data-testid") ?? "")
          .slice(0, 60),
        bodyText: document.body.innerText.slice(0, 3000),
      }))
      .catch(() => null);
  try {
    // Probe the DOM in the middle of the first freeze's failed-dial window
    // (~20 s in: session dead ~10 s, redial pending toward its 15 s failure) —
    // what does the UI ACTUALLY show while the transport is down?
    const probeTask = (async () => {
      await sleep(20_000);
      midFreezeProbe = await probeUi();
    })();
    // ~5.4 full 31.5 s cycles — the field's "4-5 visible notifications" bar.
    observation = await observeBannerCycles(page, 170_000);
    await probeTask;
  } finally {
    await cycle.stop();
  }
  const wsLog = await page
    .evaluate(() => (window as unknown as { __wsLog: unknown }).__wsLog)
    .catch(() => "page-gone");
  saveEvidence(
    "L3-evidence.json",
    JSON.stringify(
      { ...observation, midFreezeProbe, wsLog, consoleTail: consoleLines.slice(-80) },
      null,
      2,
    ),
  );

  // The reproduction of the reported symptom: the connection banner must have
  // appeared, cleared, and REAPPEARED at least 4 times — the field's "notifications
  // appearing/disappearing 4-5 times" observation.
  expect(
    observation.episodes,
    `banner did not cycle enough: ${observation.episodes} episodes, ${observation.sightings} sightings, samples: ${observation.samples.join(" | ")}`,
  ).toBeGreaterThanOrEqual(4);
});

// ── L4: the SELF-SUSTAINING loop — no SIGSTOP, no external fault driver ─────────────────
//
// The #1 field-cause candidate (production-error.md §5 round 2): on reconnect the client
// re-subscribes shell+thread with an `afterSequence` FROZEN at page load, and the server
// serves that catch-up by reading the ENTIRE global event tail (ws.ts:1215/1330, limit
// MAX_SAFE_INTEGER) through the synchronous single-connection sqlite — each 500-row page
// is one blocking read+decode. With a fat-enough tail behind the cursor, every page burst
// starves the RPC pongs, the pinger kills the socket, the reconnect replays the SAME
// cursor from byte zero, and the loop sustains ITSELF. This is exactly what 15 days of
// ordinary events (or tool-output-inflated payloads) accumulate to on a slower machine;
// here the server is pinned to one core to stand in for that machine.
const TAIL_EVENTS = 3_000;
const TAIL_PAYLOAD_BYTES = 256 * 1024;

/** Append `count` valid thread.message-sent events (fat payloads) behind the cursor. */
function seedEventTail(app: PinnedApp, count: number): void {
  const filler = "tool output captured into the chat transcript; ".repeat(
    Math.ceil(TAIL_PAYLOAD_BYTES / 47),
  );
  runSql(app, (db) => {
    const versionRow = db
      .prepare(
        `SELECT COALESCE(MAX(stream_version), 0) AS v FROM orchestration_events
         WHERE aggregate_kind = 'thread' AND stream_id = ?`,
      )
      .get(THREAD_ID) as { v: number };
    const insert = db.prepare(
      `INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (?, 'thread', ?, ?, 'thread.message-sent', ?, NULL, NULL, NULL, 'provider', ?, '{}')`,
    );
    db.exec("BEGIN");
    for (let row = 0; row < count; row++) {
      insert.run(
        `pin-tail-event-${row}`,
        THREAD_ID,
        versionRow.v + 1 + row,
        "2026-01-02T00:00:00.000Z",
        JSON.stringify({
          threadId: THREAD_ID,
          messageId: `pin-tail-message-${row}`,
          role: row % 2 === 0 ? "user" : "assistant",
          text: filler,
          turnId: null,
          streaming: false,
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
    }
    db.exec("COMMIT");
  });
}

test("L4: SELF-SUSTAINING loop — fat event tail behind a frozen cursor, no fault driver (expected RED)", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  test.setTimeout(420_000);
  // One core + low priority stands in for the field machine; nothing else is done to
  // the server after boot — no freezes, no proxies. Whatever happens next is the app's
  // own behaviour under its own data.
  const app = await bootPin({
    name: "l4-loop-selfsustain",
    env: { RU_CODE_WARM_ENGINE: "0" },
    wrap: ["taskset", "-c", "0", "nice", "-n", "19"],
  });
  seedThread(app, 8);

  let pageCrashed = false;
  page.on("crash", () => {
    pageCrashed = true;
  });

  // 1. Warm the client caches: load the thread fully once. The persisted shell/thread
  //    snapshots record the CURRENT snapshot sequence — the cursor.
  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  const row = page.locator('[data-testid^="thread-row"]').first();
  await expect(row, "seeded thread visible in the sidebar").toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByText(SENTINEL), "thread content rendered").toBeVisible({
    timeout: 30_000,
  });
  await sleep(2_000); // persistence debounce (500 ms) — let the cache writes land

  // 2. Grow the tail BEHIND the cursor: ~768 MiB of ordinary-looking message events.
  seedEventTail(app, TAIL_EVENTS);

  // 3. Reload. The client resumes with afterSequence = the pre-tail cursor and the
  //    server starts serving the whole tail through the blocking sqlite connection.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });

  const observation = await observeBannerCycles(page, 180_000);

  // Post-window stabilization check: 20 s with no banner AND the thread content back.
  let stabilized = false;
  if (!pageCrashed) {
    const quietStart = Date.now();
    stabilized = true;
    while (Date.now() - quietStart < 20_000) {
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (BANNER_PATTERN.test(bodyText) || !bodyText.includes(SENTINEL)) {
        stabilized = false;
        break;
      }
      await sleep(1_000);
    }
  }
  saveEvidence(
    "L4-evidence.json",
    JSON.stringify(
      {
        ...observation,
        stabilized,
        pageCrashed,
        tailEvents: TAIL_EVENTS,
        tailPayloadBytes: TAIL_PAYLOAD_BYTES,
      },
      null,
      2,
    ),
  );

  // THE REQUIREMENT (expected RED): a client with a stale cursor over a grown event log
  // must converge — at most one visible reconnect episode, then a stable, usable app.
  // The field behaviour this pins: banner episodes keep coming (≥4-5) and the app never
  // settles, because every reconnect replays the identical tail from byte zero.
  expect(
    pageCrashed,
    "renderer crashed under the replay loop (client-side death — a finding in itself)",
  ).toBe(false);
  expect(
    observation.episodes,
    `reconnect episodes under self-sustained replay: ${observation.episodes} ` +
      `(${observation.sightings} sightings; samples: ${observation.samples.join(" | ")})`,
  ).toBeLessThanOrEqual(1);
  expect(stabilized, "app must settle after the catch-up (quiet 20 s + thread visible)").toBe(true);
});

// ── L5: a HANGING git blocks the shell snapshot — the broken-repo suspect ───────────────
//
// Code-verified chain (production-error.md §5): getShellSnapshot resolves repository
// identity per project; stage 1 (`git -C <root> rev-parse --show-toplevel`,
// RepositoryIdentityResolver.ts:97-104) is UNCACHED and runs on EVERY resolve with the
// ProcessRunner default timeout of 60 s (processRunner.ts:147). A git that BLOCKS (dead
// network mount, stuck .git/index.lock, AV interception) therefore stalls every cold
// shell load — and every reconnect — for up to 60 s per project. A merely MISSING repo
// fails fast (code 128) and is harmless; only a blocking git bites. This pin injects a
// git stub that hangs on rev-parse (delegating every other git call to the real binary)
// and states the requirement: the thread list must appear promptly anyway.
function makeHangingGitStub(): string {
  const stubDir = mkTemp("pin-hung-git-");
  const stubPath = NodePath.join(stubDir, "git");
  NodeFS.writeFileSync(
    stubPath,
    `#!/bin/sh
case "$*" in
  *rev-parse*) sleep 600 ;;
  *) real=$(PATH=/usr/bin:/usr/local/bin:/bin command -v git); exec "$real" "$@" ;;
esac
`,
  );
  NodeFS.chmodSync(stubPath, 0o755);
  return stubDir;
}

test("L5: hanging git on one project → thread list must still appear promptly (expected RED)", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  test.setTimeout(420_000);
  const gitStubDir = makeHangingGitStub();
  const app = await bootPin({
    name: "l5-hung-git",
    env: {
      RU_CODE_WARM_ENGINE: "0",
      PATH: `${gitStubDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  seedThread(app, 8);

  const startedAt = Date.now();
  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });

  // Requirement (expected RED): the sidebar must not be hostage to one project's git.
  const row = page.locator('[data-testid^="thread-row"]').first();
  let visibleAtMs: number | null = null;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (await row.isVisible().catch(() => false)) {
      visibleAtMs = Date.now() - startedAt;
      break;
    }
    await sleep(1_000);
  }
  const interruptLines = readDaemonLog(app)
    .split("\n")
    .filter((line) => /shellSnapshot|Interrupt/i.test(line))
    .slice(-20);
  saveEvidence("L5-evidence.json", JSON.stringify({ visibleAtMs, interruptLines }, null, 2));

  expect(
    visibleAtMs,
    "thread list never appeared — shell snapshot fully hostage to git",
  ).not.toBeNull();
  // The 60 s ProcessRunner default is the mechanism; anything near it proves the
  // sidebar waited for the hung child. Requirement: prompt (≤15 s) despite the hang.
  expect(
    visibleAtMs ?? Number.MAX_SAFE_INTEGER,
    `thread list appeared only after ${String(visibleAtMs)} ms — held hostage by the uncached 60 s git rev-parse`,
  ).toBeLessThanOrEqual(15_000);
});

// ── L6 (control): warm engine ON — production default — under the same slow server ──────
test("L6 (control): warm engine ON (production default) + slow server → small thread still loads", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  test.setTimeout(420_000);
  const app = await bootPin({ name: "l6-warm-on", env: { RU_CODE_WARM_ENGINE: "1" } });
  seedThread(app, 8);

  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  const row = page.locator('[data-testid^="thread-row"]').first();
  await expect(row, "seeded thread visible in the sidebar").toBeVisible({ timeout: 30_000 });
  const cycle = startDutyCycle(app);
  let observation: StallObservation;
  try {
    await row.click();
    observation = await observeUnderStall(page, 100_000);
  } finally {
    await cycle.stop();
  }
  saveEvidence("L6-evidence.json", JSON.stringify(observation, null, 2));

  // Production config: the warm pool spawning fake-qwen children must not change the
  // small-thread outcome — if this control fails while L2 passes, the pool IS a
  // window-relevant contender and needs its own investigation.
  expect(
    observation.sentinelSeen,
    `warm-on control failed: small thread did not load under the duty cycle ` +
      `(${observation.bannerEpisodes} banner episodes in ${observation.elapsedMs} ms)`,
  ).toBe(true);
});

test("L2 (control): SMALL cold thread + the same slow server → loads inside one alive window", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  test.setTimeout(420_000);
  const app = await bootPin({ name: "l2-loop-small", env: { RU_CODE_WARM_ENGINE: "0" } });
  // Same shape, ~2 MiB — serving fits easily inside a single 2 s alive window.
  seedThread(app, 8);

  // Same structure as L1: the cycle runs before the click, so the small thread's load
  // also happens strictly under the stall — otherwise this control proves nothing.
  await page.goto(app.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  const row = page.locator('[data-testid^="thread-row"]').first();
  await expect(row, "seeded thread visible in the sidebar").toBeVisible({ timeout: 30_000 });
  const cycle = startDutyCycle(app);
  let observation: StallObservation;
  try {
    await row.click();
    observation = await observeUnderStall(page, 100_000);
  } finally {
    await cycle.stop();
  }
  saveEvidence("L2-evidence.json", JSON.stringify(observation, null, 2));

  // The control MUST pass: if even a tiny thread cannot load under this duty cycle,
  // the cycle is too harsh to discriminate and L1's redness means nothing.
  expect(
    observation.sentinelSeen,
    `control failed: a ~2 MiB thread did not load under the duty cycle ` +
      `(${observation.bannerEpisodes} banner episodes in ${observation.elapsedMs} ms) — retune THAW_MS`,
  ).toBe(true);
});
