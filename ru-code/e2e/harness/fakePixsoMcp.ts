// ru-code: e2e harness — the fake Pixso MCP plugin, RE-EXPORTED FROM THE PACKAGE.
//
// The server itself (both routes, the synthetic PNG, the realistic card tables and the
// capture loader) moved into `@smart-tools/pixso-core` on 2026-08-24 (the extraction wave)
// — before that it briefly lived in `@smart-tools/t3-code-pixso-mcp-assistant-plugin` (2026-08-21,
// decisions 510/511, when it first moved out of this repo). It is Pixso tooling, it needs
// the capture corpus, and both now live with pixso-core. This file stays only so the specs'
// imports keep their names — the import path below is already correct (DW-4 task 8).
//
// THE PATH GOES THROUGH THE `ru-code-packages` SYMLINK at this repo's root — the same
// gitignored switch `.pnpmfile.cjs` uses. Two reasons it is a symlink and not the installed
// package: the fake is deliberately NOT published (`files` ships `dist` + `src/styles.css`
// and nothing else), and Node refuses to strip TypeScript types for any file whose real path
// is inside `node_modules` — a symlink's real path is not.
//
// NO SYMLINK ⇒ THIS IMPORT THROWS, and the pixso specs fail loudly by design (owner ruling,
// 2026-08-21). They are dev-machine tests: without the linked packages checkout there is no
// corpus, and a silent skip would let a run report success having exercised nothing.
import * as NodePath from "node:path";

export * from "../../../ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts";

/**
 * The file to SPAWN when the harness needs the fake as its own process.
 *
 * Re-exporting the module is not enough for that: the server's run-when-invoked-directly
 * block compares `import.meta.url` against `process.argv[1]`, which never matches a
 * re-export, so spawning this file would exit 0 without binding 3667. `bootApp.ts` spawns
 * the real file — named here so the symlink path is written down ONCE.
 */
export const FAKE_PIXSO_ENTRY_PATH = NodePath.join(
  import.meta.dirname,
  "../../../ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts",
);

import { realFrameKeys } from "../../../ru-code-packages/packages/pixso-core/dev/fake-mcp/fakePixsoMcp.ts";
import {
  loadRealCapture as loadServedCapture,
  remoteItemCaptures as servedItemCaptures,
} from "../../../ru-code-packages/packages/pixso-core/dev/fake-mcp/realCaptures.ts";

/**
 * Every node guid of the DSL the fake SERVES for `key` — read from the SAME bytes its remote
 * route answers `get_node_dsl` with (`remoteItemCaptures()[key]` → `loadRealCapture(set).dslText`,
 * `fakePixsoMcp.ts`), each record's own `guid`. A spec that says «no node guid is shown» asks
 * this set, never a digits-colon-digits shape: a design's own «15:02» or «01:30:12» is copy.
 */
export function servedNodeGuidsOf(key: string): ReadonlySet<string> {
  const entry = servedItemCaptures()[key];
  if (entry === undefined) throw new Error(`the fake serves no capture for key ${key}`);
  const guids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
      if (field === "guid" && typeof inner === "string") guids.add(inner);
      else walk(inner);
    }
  };
  walk(JSON.parse(loadServedCapture(entry.set).dslText) as unknown);
  return guids;
}

/**
 * Every COPY string of the DSL the fake serves for `key` — the design's own words, which are
 * allowed to look like an address («15:02», «13:24»). A copy string is the value of a `nodeText`
 * or `characters` field of the SAME bytes `servedNodeGuidsOf` reads. Everything else the capture
 * states (`overrideKey`, `publishID`, `componentId`, `inherit*StyleID`, `pathString`, …) is
 * bookkeeping, never copy.
 */
export function servedCopyTextsOf(key: string): readonly string[] {
  const entry = servedItemCaptures()[key];
  if (entry === undefined) throw new Error(`the fake serves no capture for key ${key}`);
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
      if ((field === "nodeText" || field === "characters") && typeof inner === "string") {
        texts.push(inner);
      } else walk(inner);
    }
  };
  walk(JSON.parse(loadServedCapture(entry.set).dslText) as unknown);
  return texts;
}

/**
 * THE REAL FRAMES, BY KEY — every `debug-N` set of the corpus as the remote route addresses it
 * (`realFrameKeys()`: frame order). A set's key is its BARE guid when that resolves to it (the
 * real protocol's own addressing) and its ALIAS `<guid>@<id12>` when a newer capture of the same
 * address owns the bare guid (a superseded set is reachable only by alias — the fake serves by
 * SET, never «last wins»). Every entry therefore reaches exactly its own bytes, so a superseded
 * frame is no longer silently the same card as its successor. The app specs prove real frames per
 * route end to end — the local route lands each keyed selection as a card, the remote route scans
 * by key; the loop over EVERY dump by key, on both routes, with every assertion, lives in the
 * package's lane (`dev/fake-mcp/*.test.ts`, `tests/fakeCycleRealFrames.corpus.test.ts`). Empty
 * only when the corpus holds no frame — the boot's corpus precondition (`bootApp.ts`
 * `assertPixsoCorpus`) stops the run first.
 */
export const REAL_FRAMES_BY_KEY: ReadonlyArray<{ readonly frame: string; readonly key: string }> =
  realFrameKeys().map((row) => ({ frame: row.frame, key: row.key }));

/** The corpus's FIRST frame by key — the ONE real frame the local-route spec proves. */
export const FIRST_REAL_FRAME: { readonly frame: string; readonly key: string } | null =
  REAL_FRAMES_BY_KEY[0] ?? null;
