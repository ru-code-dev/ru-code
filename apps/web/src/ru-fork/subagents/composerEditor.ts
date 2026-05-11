// ru-fork: Lexical-side glue for the `#agent` chip. Keeps
// ComposerPromptEditor (upstream) small by owning the subagent segment
// append + metadata mirror logic here.

import type { ParagraphNode } from "lexical";

import { $createComposerSubagentNode } from "./SubagentNode";
import type { ComposerSubagentMetadata } from "./subagentMetadata";

export const $appendSubagentSegment = (
  paragraph: ParagraphNode,
  segment: { name: string },
  metadata: ReadonlyMap<string, ComposerSubagentMetadata>,
): void => {
  const entry = metadata.get(segment.name);
  paragraph.append(
    $createComposerSubagentNode(
      segment.name,
      entry?.label ?? segment.name,
      entry?.description ?? null,
    ),
  );
};
