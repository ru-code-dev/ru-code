// ru-code: pure changelog parsing + accumulation for auto-update (W28). No I/O, no Effect —
// reads the user-authored repo-root `changelog.json` and derives the newest-first, capped
// list of release notes for every version above the running one. Every step is defensive:
// garbage in the author's file is skipped, never fatal, so a typo can't wedge a check.
// @effect-diagnostics preferSchemaOverJson:off

import type { ChangelogVersionWire, ReleaseNoteWire } from "@t3tools/contracts";

import { compareSemver, isNewer, isValidVersion } from "./manifest.ts";

/** The changelog `kind` badges; anything else authored decays to a plain (null-kind) note. */
const KNOWN_KINDS = new Set(["feat", "fix", "perf", "ui"]);

type NoteKind = ReleaseNoteWire["kind"];

const asNoteKind = (value: unknown): NoteKind =>
  typeof value === "string" && KNOWN_KINDS.has(value) ? (value as NoteKind) : null;

/**
 * Turn one authored entry into a `ReleaseNoteWire`, or `null` if it is garbage (to be
 * skipped by the caller). A bare string → `{kind: null, text}`; an object needs a string
 * `text` and an optional known `kind` — unknown kinds decay to null.
 */
const parseEntry = (entry: unknown): ReleaseNoteWire | null => {
  if (typeof entry === "string") return { kind: null, text: entry };
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const text = record["text"];
  if (typeof text !== "string") return null;
  return { kind: asNoteKind(record["kind"]), text };
};

/**
 * Parse the raw `changelog.json` text into a per-version note list. Defensive throughout:
 * invalid JSON or a non-object root → `[]`; invalid-semver keys are skipped; a version
 * whose value is not an array is skipped; individual garbage entries are dropped while the
 * rest of that version's notes survive. Versions are returned in author order (accumulate
 * sorts them) — each shaped as a `ChangelogVersionWire`.
 */
export const parseChangelog = (text: string): ReadonlyArray<ChangelogVersionWire> => {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return [];
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const record = obj as Record<string, unknown>;

  const versions: Array<ChangelogVersionWire> = [];
  for (const version of Object.keys(record)) {
    if (!isValidVersion(version)) continue;
    const rawNotes = record[version];
    if (!Array.isArray(rawNotes)) continue;
    const notes: Array<ReleaseNoteWire> = [];
    for (const entry of rawNotes) {
      const parsed = parseEntry(entry);
      if (parsed !== null) notes.push(parsed);
    }
    versions.push({ version, notes });
  }
  return versions;
};

export interface AccumulatedChangelog {
  readonly versions: ReadonlyArray<ChangelogVersionWire>;
  readonly truncated: boolean;
}

/**
 * From a parsed changelog, keep every version strictly NEWER than `currentVersion`, sorted
 * newest-first, capped at `cap` versions. `truncated` is true when the cap dropped any.
 * Semver ordering reuses `compareSemver` from manifest.ts so the changelog and the update
 * check can never disagree on which version is newer.
 */
export const accumulateChangelog = (
  parsed: ReadonlyArray<ChangelogVersionWire>,
  currentVersion: string,
  cap = 10,
): AccumulatedChangelog => {
  const newer = parsed
    .filter((entry) => isNewer(entry.version, currentVersion))
    .sort((a, b) => compareSemver(b.version, a.version));
  const truncated = newer.length > cap;
  return { versions: truncated ? newer.slice(0, cap) : newer, truncated };
};
