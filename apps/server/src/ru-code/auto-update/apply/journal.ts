// ru-code: the apply journal — `<appRoot>/updates/journal.json`, the record of the LAST install
// run's outcome. Written at flip time as `started`; the freshly booted server promotes it at boot:
// `started` + our version == target ⇒ `ok` (the update landed), `started` + version mismatch ⇒
// `failed` (`not-applied` — the flip happened but this binary isn't the target, i.e. the pointer
// changed again or the relaunch never happened). A strict-port failure writes `failed`/`port-busy`
// before the process exits. The journal feeds `/healthz` (the SW page's only channel while the app
// is down) and the settings «последнее обновление» line. Atomic tmp+rename writes.

// @effect-diagnostics preferSchemaOverJson:off

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { LastApplyWire } from "@t3tools/contracts";

export const JOURNAL_RELATIVE_PATH = "updates/journal.json";
export const JOURNAL_SCHEMA = 1;

export type ApplyOutcome = "started" | "ok" | "failed";

export interface ApplyJournal {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly targetVersion: string;
  readonly fromVersion: string;
  readonly outcome: ApplyOutcome;
  /** Machine reason for `failed` ("port-busy", "not-applied", …); null otherwise. */
  readonly reasonCode: string | null;
  /** Epoch milliseconds of the last transition. */
  readonly at: number;
}

const isValidJournal = (value: unknown): value is ApplyJournal => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record["schema"] === JOURNAL_SCHEMA &&
    typeof record["targetVersion"] === "string" &&
    typeof record["fromVersion"] === "string" &&
    (record["outcome"] === "started" ||
      record["outcome"] === "ok" ||
      record["outcome"] === "failed") &&
    (record["reasonCode"] === null || typeof record["reasonCode"] === "string") &&
    typeof record["at"] === "number"
  );
};

/** Read the journal; `null` for missing/corrupt (never fails). */
export const readJournal = (
  appRoot: string,
): Effect.Effect<ApplyJournal | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(path.join(appRoot, JOURNAL_RELATIVE_PATH))
      .pipe(Effect.orElseSucceed(() => null));
    if (raw === null) return null;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    return isValidJournal(parsed) ? parsed : null;
  });

/** Atomically write the journal (tmp + rename). Best-effort: failures are swallowed after logging. */
export const writeJournal = (
  appRoot: string,
  journal: ApplyJournal,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const finalPath = path.join(appRoot, JOURNAL_RELATIVE_PATH);
    const tmpPath = `${finalPath}.tmp`;
    yield* fs.makeDirectory(path.dirname(finalPath), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(tmpPath, `${JSON.stringify(journal, null, 2)}\n`)),
      Effect.andThen(fs.rename(tmpPath, finalPath)),
      Effect.catch((error) =>
        Effect.logError("[auto-update] journal write failed", { cause: error }),
      ),
    );
  });

/**
 * Boot-time reconcile: settle the journal against the version that ACTUALLY booted. Returns the
 * (possibly rewritten) journal for the wire/`/healthz`.
 *
 * Two rules, and they use the same discriminator — what is running now:
 *
 *   · a `started` record settles into `ok` (this binary IS the target) or `failed`/`not-applied`
 *     (something else booted, so the flip never took effect);
 *
 *   · a `failed` record whose target IS the running version is REWRITTEN to `ok`. That combination
 *     cannot describe a real failure: the machine is executing the very version the record calls
 *     unapplied. It is produced by the relaunch handing off to a pinned port that stays busy —
 *     `journalPortBusy` writes `failed`/`port-busy` and the process dies with the pointer already
 *     naming the new version, which the user's next launch then boots successfully. Without this
 *     rule the record survived forever: `/healthz` and the settings card reported a FAILED update
 *     that had in fact landed, the settings hero stayed destructive-red for the life of the
 *     process, and the boot GC — gated on `outcome === "ok"` — never collected the superseded
 *     version directory, so `versions/` kept a tree the "exactly [current]" invariant says cannot
 *     be there.
 */
export const reconcileJournalAtBoot = (params: {
  readonly appRoot: string;
  readonly currentVersion: string;
  readonly now: number;
}): Effect.Effect<ApplyJournal | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const journal = yield* readJournal(params.appRoot);
    if (journal === null) return journal;

    if (journal.outcome === "failed" && journal.targetVersion === params.currentVersion) {
      const corrected: ApplyJournal = {
        ...journal,
        outcome: "ok",
        reasonCode: null,
        at: params.now,
      };
      yield* Effect.logDebug("[auto-update] journal corrected: the target version is running", {
        targetVersion: journal.targetVersion,
        wasReasonCode: journal.reasonCode,
      });
      yield* writeJournal(params.appRoot, corrected);
      return corrected;
    }

    if (journal.outcome !== "started") return journal;
    const promoted: ApplyJournal =
      journal.targetVersion === params.currentVersion
        ? { ...journal, outcome: "ok", reasonCode: null, at: params.now }
        : { ...journal, outcome: "failed", reasonCode: "not-applied", at: params.now };
    yield* writeJournal(params.appRoot, promoted);
    return promoted;
  });

/** The wire projection (settings «последнее обновление» + /healthz). `started` maps to null reason. */
export const journalToWire = (journal: ApplyJournal | null): LastApplyWire | null =>
  journal === null || journal.outcome === "started"
    ? null
    : {
        targetVersion: journal.targetVersion,
        fromVersion: journal.fromVersion,
        outcome: journal.outcome,
        reasonCode: journal.reasonCode,
        at: journal.at,
      };
