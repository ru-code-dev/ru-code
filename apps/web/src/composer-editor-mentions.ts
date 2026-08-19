import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import {
  collectComposerInlineTokens,
  type ComposerInlineToken,
} from "@t3tools/shared/composerInlineTokens";
// ru-code: the catalog `$skill`/`#agent` chip logic (parse/merge/build) lives in this ru-code module;
// the port only unions in its segment shapes and calls collectComposerSegmentTokens below.
import {
  collectComposerSegmentTokens,
  type CatalogPromptSegment,
} from "./ru-code/skills-agents/composer/catalogSegments";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      source: string;
    }
  | {
      type: "skill";
      name: string;
    }
  | CatalogPromptSegment // ru-code: delimited catalog chips (qwen skills/agents)
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

function rangeIncludesIndex(start: number, end: number, index: number): boolean {
  return start <= index && index < end;
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function forEachPromptSegmentSlice(
  prompt: string,
  visitor: (
    slice:
      | {
          type: "text";
          text: string;
          promptOffset: number;
        }
      | {
          type: "terminal-context";
          promptOffset: number;
        },
  ) => boolean | void,
): boolean {
  let textCursor = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (
      index > textCursor &&
      visitor({
        type: "text",
        text: prompt.slice(textCursor, index),
        promptOffset: textCursor,
      }) === true
    ) {
      return true;
    }
    if (visitor({ type: "terminal-context", promptOffset: index }) === true) {
      return true;
    }
    textCursor = index + 1;
  }

  if (
    textCursor < prompt.length &&
    visitor({
      type: "text",
      text: prompt.slice(textCursor),
      promptOffset: textCursor,
    }) === true
  ) {
    return true;
  }

  return false;
}

function forEachPromptTextSlice(
  prompt: string,
  visitor: (text: string, promptOffset: number) => boolean | void,
): boolean {
  return forEachPromptSegmentSlice(prompt, (slice) => {
    if (slice.type !== "text") {
      return false;
    }
    return visitor(slice.text, slice.promptOffset);
  });
}

function forEachMentionMatch(
  prompt: string,
  visitor: (
    match: Extract<ComposerInlineToken, { type: "mention" }>,
    promptOffset: number,
  ) => boolean | void,
): boolean {
  return forEachPromptTextSlice(prompt, (text, promptOffset) => {
    for (const match of collectComposerInlineTokens(text)) {
      if (match.type !== "mention") {
        continue;
      }
      if (visitor(match, promptOffset) === true) {
        return true;
      }
    }
    return false;
  });
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  // ru-code: native (mention + `$skill`) ⊕ catalog (`skill:⟦⟧`/`agent:⟦⟧`) tokens, merged + built in
  // ru-code; the loop below stays generic (no per-type logic).
  let cursor = 0;
  for (const token of collectComposerSegmentTokens(text)) {
    if (token.start < cursor) {
      continue;
    }
    if (token.start > cursor) {
      pushTextSegment(segments, text.slice(cursor, token.start));
    }
    segments.push(token.build());
    cursor = token.end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function selectionTouchesMentionBoundary(
  prompt: string,
  start: number,
  end: number,
): boolean {
  if (!prompt || start >= end) {
    return false;
  }

  return forEachMentionMatch(prompt, (match, promptOffset) => {
    const mentionStart = promptOffset + match.start;
    const mentionEnd = promptOffset + match.end;
    const beforeMentionIndex = mentionStart - 1;
    const afterMentionIndex = mentionEnd;

    if (
      beforeMentionIndex >= 0 &&
      /\s/.test(prompt[beforeMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, beforeMentionIndex)
    ) {
      return true;
    }

    if (
      afterMentionIndex < prompt.length &&
      /\s/.test(prompt[afterMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, afterMentionIndex)
    ) {
      return true;
    }
    return false;
  });
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let terminalContextIndex = 0;
  forEachPromptSegmentSlice(prompt, (slice) => {
    if (slice.type === "text") {
      segments.push(...splitPromptTextIntoComposerSegments(slice.text));
      return false;
    }

    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    return false;
  });

  return segments;
}
