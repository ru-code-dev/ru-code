// ru-code: what the UI must show for each real capture — READ, never derived here.
//
// These values used to be computed in this repo: the specs imported the harness's own
// capture loader and parsed ~10 MB of DSL per set, inside the browser test process, with a
// second copy of the parsing rules living in the app repo. The package owns the parser, so
// the package computes them once (`pnpm pixso:expectations`) into
// `pixso_dumps/expectations.json` and the specs read data. Identical values — the manifest
// generator calls the very functions the specs used to call (verified byte-for-byte against
// a pre-move snapshot, decisions 510/511).
//
// Read at the assets root (`pnpm pixso:expectations` writes it there).
// No manifest ⇒ a NAMED throw, never a skip: these specs are dev-machine tests
// and a silent pass would mean a run that exercised nothing (owner ruling, 2026-08-21).

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CORPUS_DIR } from "./fakePixsoMcp.ts";

// Contract 2 (2026-09-26): the corpus lives at the assets root, `<PIXSO_ASSETS>/current-dsl/dumps`
// — read off the engine's ONE constant (`CORPUS_DIR`, `src/io/captures.ts`, re-exported by the
// harness exactly as `scripts/bootApp.ts` reads it), never a second literal of the same path.
// `pnpm pixso:expectations` writes the manifest there (`scripts/expectations.ts`).
const MANIFEST = NodePath.join(CORPUS_DIR, "expectations.json");

export interface CaptureImage {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

/** The package's own default in `expectedTextsOf(capture, limit = 3)`. */
const MANIFEST_TEXT_LIMIT = 3;

export interface ExpectedTexts {
  readonly origin: string;
  readonly texts: readonly string[];
}

interface SetExpectation {
  readonly rootLayerName: string | null;
  readonly rootGuid: string | null;
  readonly rootSizeLabel: string | null;
  readonly expectedTexts: ExpectedTexts;
  readonly expectedAxisSetName: string | null;
  /** The names the card's «Компоненты» tab lists, in the card's order (null: no card). */
  readonly componentUsageNames: readonly string[] | null;
  readonly image: CaptureImage | null;
}

interface Manifest {
  readonly sets: readonly string[];
  readonly frames: readonly {
    readonly frame: string;
    readonly sources: readonly ("local" | "remote")[];
    readonly guid: string | null;
    readonly fileKey: string | null;
    readonly hasTruthSvg: boolean;
    readonly hasTruthPng: boolean;
    /** The frame's served DSL top-level roots, in wire order. */
    readonly topLevelRoots: readonly string[];
  }[];
  readonly expectations: Readonly<Record<string, SetExpectation>>;
}

function readManifest(): Manifest {
  if (!NodeFS.existsSync(MANIFEST)) {
    throw new Error(
      `pixso expectations manifest not found at ${MANIFEST} — run ` +
        `'pnpm pixso:expectations' in the pixso package (it writes the assets-root corpus ` +
        `manifest). These specs are dev-machine tests ` +
        `and do not run without the capture corpus.`,
    );
  }
  return JSON.parse(NodeFS.readFileSync(MANIFEST, "utf8")) as Manifest;
}

const manifest = readManifest();

/** An opaque handle for one capture set — kept so call sites read as they always did. */
export interface RealCapture {
  readonly set: string;
}

function expectationOf(set: string): SetExpectation {
  const found = manifest.expectations[set];
  if (found === undefined) {
    throw new Error(`no expectations for capture set "${set}" — regenerate the manifest`);
  }
  return found;
}

export function loadRealCapture(set: string): RealCapture {
  expectationOf(set);
  return { set };
}

export const realCaptureSets = (): readonly string[] => manifest.sets;
export const rootLayerNameOf = (c: RealCapture): string | null =>
  expectationOf(c.set).rootLayerName;
export const rootGuidOf = (c: RealCapture): string | null => expectationOf(c.set).rootGuid;
export const rootSizeLabelOf = (c: RealCapture): string | null =>
  expectationOf(c.set).rootSizeLabel;
export const expectedAxisSetName = (c: RealCapture): string | null =>
  expectationOf(c.set).expectedAxisSetName;
export const realCaptureImage = (set: string): CaptureImage | null => expectationOf(set).image;
export const componentUsageNamesOf = (c: RealCapture): readonly string[] | null =>
  expectationOf(c.set).componentUsageNames;

/** The top-level roots a frame's served DSL carries, in wire order (the keyed root among
 *  them). A frame the manifest does not know is a regenerate-the-manifest error, never []. */
export function topLevelRootsOf(frame: string): readonly string[] {
  const found = manifest.frames.find((f) => f.frame === frame);
  if (found === undefined) {
    throw new Error(`no frame "${frame}" in the manifest — regenerate it`);
  }
  return found.topLevelRoots;
}

/**
 * The manifest stores exactly what the package's `expectedTextsOf(capture)` returned, which
 * uses its own default limit of 3. A caller asking for a DIFFERENT limit would get an answer
 * computed for 3 — silently wrong — so that throws instead. If a spec ever needs another
 * limit, the manifest must carry it; guessing here would be the regression this move exists
 * to avoid.
 */
export function expectedTextsOf(c: RealCapture, limit = MANIFEST_TEXT_LIMIT): ExpectedTexts {
  if (limit !== MANIFEST_TEXT_LIMIT) {
    throw new Error(
      `expectedTextsOf(limit=${String(limit)}) — the manifest was generated with limit ` +
        `${String(MANIFEST_TEXT_LIMIT)}; regenerate it for another limit rather than trusting this one`,
    );
  }
  return expectationOf(c.set).expectedTexts;
}
