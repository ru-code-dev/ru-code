// @effect-diagnostics nodeBuiltinImport:off
// ru-code: exact-pid child reaper — the KILL_BY_JOURNAL_PIDS backend. The app
// journals every ACP child it spawns to `<stateDir>/qwen-pids.<instanceSlug>.json`
// (QwenProcessJournal: {pid, kind: session|warm, spawnedAt}, entry removed on
// observed teardown), and stateDir is where `server-runtime.json` lives — so the
// daemon derives everything from the statePath it already has. Kills are plain
// `process.kill` syscalls (no pkill/taskkill), so this works on locked-down
// Windows too. The journal is advisory by contract (write-only, best-effort):
// every step here tolerates absent/garbled files and never fails the caller.
//
// SURVIVOR CONTRACT: a journal file is deleted only when every entry is
// confirmed gone. A child that survives the kill pass (e.g. it ignores SIGTERM
// under "SIGTERM_NO_WAIT") keeps its entry — the file is REWRITTEN with the
// survivors (original spawnedAt preserved) so the next stop/start can still
// find and kill it. Deleting the only record of a live process would make it
// untrackable forever.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import {
  GROUP_KILL_METHOD,
  JOURNAL_REAP_SETTLE_MS,
  SIGTERM_GRACE_MS,
  VERIFY_JOURNAL_PIDS_CMDLINE,
} from "./constants.ts";
import { isProcessAlive, signalProcess } from "./signal.ts";

const JOURNAL_FILE_PATTERN = /^qwen-pids\..*\.json$/;
const CMDLINE_MARKER = "--acp";
const VERIFY_TIMEOUT_MS = 2_000;
const SETTLE_POLL_INTERVAL_MS = 50;

// Mirror of the app's QwenProcessJournal entry (a stable on-disk contract).
const JournalEntry = Schema.Struct({
  pid: Schema.Number,
  kind: Schema.Literals(["session", "warm"]),
  spawnedAt: Schema.String,
});
type JournalEntry = typeof JournalEntry.Type;
const journalFileSchema = fromJsonStringPretty(Schema.Array(JournalEntry));
const decodeJournalFile = Schema.decodeUnknownEffect(journalFileSchema);
const encodeJournalFile = Schema.encodeSync(journalFileSchema);

/** All journal files sitting next to the runtime-state file. Never fails. */
const listJournalFiles = (statePath: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => NodeFSP.readdir(NodePath.dirname(statePath))).pipe(
    Effect.map((names) =>
      names
        .filter((name) => JOURNAL_FILE_PATTERN.test(name))
        .map((name) => NodePath.join(NodePath.dirname(statePath), name)),
    ),
    Effect.orElseSucceed(() => []),
  );

/** Decode one journal file into entries; unreadable/garbled → empty. */
const readJournalEntries = (filePath: string): Effect.Effect<ReadonlyArray<JournalEntry>> =>
  Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
    Effect.flatMap((contents) => decodeJournalFile(contents.trim())),
    Effect.orElseSucceed((): ReadonlyArray<JournalEntry> => []),
  );

/**
 * Pid-reuse guard (VERIFY_JOURNAL_PIDS_CMDLINE): true when the pid's command
 * line still looks like our ACP child. Linux reads /proc/<pid>/cmdline (argv
 * joined with NUL bytes); macOS asks `ps`. Windows and any read failure verify
 * as TRUE — the journal entry itself is the evidence, and a false negative
 * would leak a real orphan.
 */
const cmdlineLooksLikeAcpChild = (pid: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform === "linux") {
      return yield* Effect.tryPromise(() => NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8")).pipe(
        // /proc cmdline is NUL-separated argv - join with spaces before matching.
        Effect.map((raw) => raw.split("\0").join(" ").includes(CMDLINE_MARKER)),
        Effect.orElseSucceed(() => true),
      );
    }
    if (platform === "darwin") {
      return yield* Effect.callback<boolean>((resume) => {
        NodeChildProcess.execFile(
          "ps",
          ["-p", String(pid), "-o", "command="],
          { timeout: VERIFY_TIMEOUT_MS },
          (error, stdout) =>
            resume(Effect.succeed(error !== null ? true : stdout.includes(CMDLINE_MARKER))),
        );
      });
    }
    return true;
  });

/** First-pass signal: SIGKILL when hard-configured OR the caller forces it. */
const firstPassSignal = (force: boolean): NodeJS.Signals =>
  force || GROUP_KILL_METHOD === "SIGKILL" ? "SIGKILL" : "SIGTERM";

/**
 * Atomic rewrite (temp + rename) — mirrors the app's own journal writes, so a
 * crash mid-write can never leave a half-written file that would decode as
 * empty and untrack a survivor. The `.tmp` name never matches the journal
 * pattern; a crash between write and rename leaves the ORIGINAL file intact
 * (over-complete → harmlessly re-reaped next time). Best-effort.
 */
const writeFileAtomically = (filePath: string, contents: string): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const tempPath = `${filePath}.tmp`;
    await NodeFSP.writeFile(tempPath, contents, "utf8");
    await NodeFSP.rename(tempPath, filePath);
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Poll until every target pid is gone or the settle budget is spent. Returns the
 * pids still alive. The settle is NOT a graceful wait — it only observes the
 * quick deaths (a SIGTERM'd child normally exits within milliseconds) so files
 * whose entries are all confirmed dead can be deleted instead of rewritten.
 */
const awaitTargetsGone = (
  targets: ReadonlyArray<number>,
  budgetMs: number,
): Effect.Effect<ReadonlySet<number>> =>
  Effect.gen(function* () {
    let alive = new Set(targets);
    const maxPolls = Math.max(1, Math.ceil(budgetMs / SETTLE_POLL_INTERVAL_MS));
    for (let poll = 0; poll < maxPolls && alive.size > 0; poll += 1) {
      const stillAlive = new Set<number>();
      for (const pid of alive) {
        if (yield* isProcessAlive(pid)) {
          stillAlive.add(pid);
        }
      }
      alive = stillAlive;
      if (alive.size > 0) {
        yield* Effect.sleep(Duration.millis(SETTLE_POLL_INTERVAL_MS));
      }
    }
    return alive;
  });

/**
 * Reap every journaled ACP child: collect entries from all `qwen-pids.*.json`
 * files next to the state file, drop the dead / not-ours ones, then kill per
 * GROUP_KILL_METHOD (SIGKILL / SIGTERM+grace+escalate / SIGTERM fire-and-forget)
 * and settle briefly. Files whose entries are all confirmed gone are deleted;
 * files with survivors are rewritten with ONLY the survivors (see the survivor
 * contract in the header). Best-effort throughout; never fails.
 */
export const reapJournaledChildren = (
  statePath: string,
  options?: { readonly force?: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const force = options?.force === true;
    const files = yield* listJournalFiles(statePath);
    if (files.length === 0) {
      return;
    }
    const entriesByFile = new Map<string, ReadonlyArray<JournalEntry>>();
    for (const file of files) {
      entriesByFile.set(file, yield* readJournalEntries(file));
    }

    // One verdict per unique pid: dead / not-ours (verify says reused) / target.
    const targets = new Set<number>();
    for (const entries of entriesByFile.values()) {
      for (const entry of entries) {
        if (targets.has(entry.pid) || !(yield* isProcessAlive(entry.pid))) {
          continue;
        }
        if (VERIFY_JOURNAL_PIDS_CMDLINE && !(yield* cmdlineLooksLikeAcpChild(entry.pid))) {
          continue; // pid reused by something that is not ours — leave it alone
        }
        targets.add(entry.pid);
      }
    }

    for (const pid of targets) {
      yield* signalProcess(pid, firstPassSignal(force));
    }
    // `force` already SIGKILLed on the first pass — no grace escalation needed.
    if (!force && GROUP_KILL_METHOD === "SIGTERM_WITH_GRACE" && targets.size > 0) {
      yield* Effect.sleep(Duration.millis(SIGTERM_GRACE_MS));
      for (const pid of targets) {
        if (yield* isProcessAlive(pid)) {
          yield* signalProcess(pid, "SIGKILL");
        }
      }
    }
    const survivors =
      targets.size > 0
        ? yield* awaitTargetsGone(Array.from(targets), JOURNAL_REAP_SETTLE_MS)
        : new Set<number>();

    for (const [file, entries] of entriesByFile) {
      // Not-ours and confirmed-dead entries are dropped; survivors are kept.
      const keep = entries.filter((entry) => survivors.has(entry.pid));
      if (keep.length === 0) {
        yield* Effect.tryPromise(() => NodeFSP.rm(file, { force: true })).pipe(
          Effect.orElseSucceed(() => undefined),
        );
      } else {
        yield* writeFileAtomically(file, encodeJournalFile(keep));
      }
    }
  });
