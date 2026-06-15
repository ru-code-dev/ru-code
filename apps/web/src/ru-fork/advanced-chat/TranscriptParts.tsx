// ru-fork: advanced chat mode — renders message `parts` (the @google/genai parts,
// normalized). Every kind is presented: text/thought as prose, calls/responses and
// unknown blobs in collapsibles, inline data as a labelled chip.
import type { TranscriptPart } from "@t3tools/contracts";
import { BrainIcon, PaperclipIcon } from "lucide-react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";

import { Disclosure, JsonBlock } from "./transcriptVisuals";

function PartView({ part, cwd }: { part: TranscriptPart; cwd: string | undefined }) {
  switch (part.kind) {
    case "text":
      return part.text.trim().length === 0 ? null : <ChatMarkdown text={part.text} cwd={cwd} />;
    case "thought":
      return (
        <Disclosure
          label={
            <span className="flex items-center gap-1.5">
              <BrainIcon className="size-3.5" />
              Размышления
            </span>
          }
        >
          <ChatMarkdown text={part.text} cwd={cwd} />
        </Disclosure>
      );
    case "function_call":
      return (
        <Disclosure
          label={
            <span className="flex items-center gap-1.5">
              Вызов инструмента
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.7rem] text-foreground">
                {part.name || "—"}
              </code>
            </span>
          }
          meta={
            <Badge variant="outline" size="sm">
              аргументы
            </Badge>
          }
        >
          <JsonBlock value={part.args} />
        </Disclosure>
      );
    case "function_response":
      return (
        <Disclosure
          label={
            <span className="flex items-center gap-1.5">
              Ответ инструмента
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.7rem] text-foreground">
                {part.name || "—"}
              </code>
            </span>
          }
        >
          <JsonBlock value={part.response} />
        </Disclosure>
      );
    case "inline_data":
      return (
        <Badge variant="outline" size="sm" className="font-mono">
          <PaperclipIcon className="size-3" />
          {part.mimeType || "вложение"}
        </Badge>
      );
    case "unknown":
      return (
        <Disclosure
          label="Неизвестный блок"
          meta={
            <Badge variant="outline" size="sm">
              raw
            </Badge>
          }
        >
          <JsonBlock value={part.raw} />
        </Disclosure>
      );
  }
}

// Parts are immutable for a given record, but build a content-derived key so we
// never rely on the bare array index.
function partKey(part: TranscriptPart, index: number): string {
  switch (part.kind) {
    case "text":
    case "thought":
      return `${part.kind}-${index}-${part.text.length}`;
    case "function_call":
    case "function_response":
      return `${part.kind}-${index}-${part.name}`;
    case "inline_data":
      return `inline-${index}-${part.mimeType}`;
    case "unknown":
      return `unknown-${index}`;
  }
}

export function TranscriptParts({
  parts,
  cwd,
}: {
  parts: ReadonlyArray<TranscriptPart>;
  cwd: string | undefined;
}) {
  const rendered = parts.map((part, index) => {
    const node = <PartView part={part} cwd={cwd} />;
    return node ? <div key={partKey(part, index)}>{node}</div> : null;
  });
  return <div className="flex min-w-0 flex-col gap-2">{rendered}</div>;
}
