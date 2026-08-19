// ru-code: all composer segment LOGIC for the catalog `$skill`/`#agent` chips lives here — the port
// files (composer-editor-mentions, composer-logic) only make a one-line marked call into these. Merges
// the port's native inline tokens with the catalog's delimited `skill:⟦name⟧`/`agent:⟦name⟧` tokens into
// one position-sorted list of build-thunks, so the port's split loop stays generic (no per-type logic).
import {
  collectComposerInlineTokens,
  type ComposerInlineToken,
} from "@t3tools/shared/composerInlineTokens";
import { parseCatalogTokenSegments } from "@smart-tools/qwen-cli-catalog-core/contracts";

import type { ComposerPromptSegment } from "~/composer-editor-mentions";

// The catalog chip segment shapes (delimited). `source` carries the exact matched token text so the
// cursor math uses its real length (delimited tokens are longer than the native one-char `$` sigil).
export type CatalogPromptSegment =
  | { readonly type: "catalog-skill"; readonly name: string; readonly source: string }
  | { readonly type: "catalog-agent"; readonly name: string; readonly source: string };

export interface PositionedComposerSegment {
  readonly start: number;
  readonly end: number;
  readonly build: () => ComposerPromptSegment;
}

const buildNativeSegment = (match: ComposerInlineToken): ComposerPromptSegment =>
  match.type === "mention"
    ? { type: "mention", path: match.value, source: match.source }
    : { type: "skill", name: match.value };

// One position-sorted token stream = native (mention + `$skill`) ⊕ catalog (`skill:⟦⟧`/`agent:⟦⟧`).
// The two match disjoint byte patterns, so they never overlap.
export function collectComposerSegmentTokens(text: string): PositionedComposerSegment[] {
  const positioned: PositionedComposerSegment[] = [];
  for (const match of collectComposerInlineTokens(text)) {
    positioned.push({ start: match.start, end: match.end, build: () => buildNativeSegment(match) });
  }
  for (const segment of parseCatalogTokenSegments(text)) {
    if (segment.kind !== "chip") continue;
    const source = text.slice(segment.start, segment.end);
    const name = segment.name;
    const type =
      segment.catalogKind === "agent" ? ("catalog-agent" as const) : ("catalog-skill" as const);
    positioned.push({
      start: segment.start,
      end: segment.end,
      build: () => ({ type, name, source }),
    });
  }
  return positioned.sort((left, right) => left.start - right.start);
}

// Expanded (value-string) length of a catalog chip segment, or null if the segment is not ours (the
// port keeps its own `name.length + 1` sigil math for native `$skill`).
export function catalogSegmentExpandedLength(segment: ComposerPromptSegment): number | null {
  return segment.type === "catalog-skill" || segment.type === "catalog-agent"
    ? segment.source.length
    : null;
}
