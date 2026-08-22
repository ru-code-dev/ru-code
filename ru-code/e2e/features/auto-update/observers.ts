// ru-code: auto-update FEATURE — on-disk observers and the suite's fixed values.
//
// What the update path leaves behind on disk, read back as plain data: which version the pointer
// boots, what the journal recorded about the last apply, and which version dirs survived GC. These
// are auto-update concepts, so they live with the feature and not in the shared harness.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { readJsonFile } from "../../harness/primitives.ts";

/**
 * Proof that a built bundle carries the auto-update test seams (the loopback trigger route). The
 * harness knows nothing about it; it is handed in via `prepareArtifacts({seamMarker})`.
 */
export const SEAM_MARKER = "RU_CODE_UPDATE_TEST_TRIGGER";

// ── on-disk observation helpers ────────────────────────────────────────────────────────────────
export const readPointer = (appRoot: string): { version?: string; entry?: string } | null =>
  readJsonFile(NodePath.join(appRoot, "current.json")) as {
    version?: string;
    entry?: string;
  } | null;
export const readJournal = (
  appRoot: string,
): { outcome?: string; reasonCode?: string | null; targetVersion?: string } | null =>
  readJsonFile(NodePath.join(appRoot, "updates", "journal.json")) as {
    outcome?: string;
    reasonCode?: string | null;
    targetVersion?: string;
  } | null;
export const listVersions = (appRoot: string): Array<string> => {
  try {
    return NodeFS.readdirSync(NodePath.join(appRoot, "versions")).sort();
  } catch {
    return [];
  }
};
