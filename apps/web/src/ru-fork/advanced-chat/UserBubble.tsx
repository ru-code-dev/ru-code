// ru-fork: advanced chat mode — user message bubble. Matches the existing chat
// bubble look (right-aligned secondary bubble + timestamp + copy); an image part
// shows as a 📎 chip (the transcript carries only the mime type, not the bytes).
import { PaperclipIcon } from "lucide-react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";

import type { UserRecord } from "./transcriptTypes";
import { CopyButton } from "./transcriptVisuals";

export function UserBubble({ record, cwd }: { record: UserRecord; cwd: string | undefined }) {
  const text = record.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n\n");
  // Keep each image part's index in the immutable record — a stable, unique identity for the key
  // (two parts of the same mime type still differ), instead of the rendered-list position.
  const images = record.parts.flatMap((part, partIndex) =>
    part.kind === "inline_data" ? [{ mimeType: part.mimeType, partIndex }] : [],
  );
  const date = new Date(record.timestamp);
  const time = Number.isNaN(date.getTime()) ? record.timestamp : date.toLocaleTimeString();

  return (
    <div className="flex justify-end">
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        {text.length > 0 ? <ChatMarkdown text={text} cwd={cwd} /> : null}
        {images.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {images.map((image) => (
              <Badge key={image.partIndex} variant="outline" size="sm" className="font-mono">
                <PaperclipIcon className="size-3" />
                {image.mimeType || "вложение"}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-1 flex items-center justify-end gap-1 text-[0.7rem] text-muted-foreground">
          {text.length > 0 ? <CopyButton text={text} /> : null}
          <span title={record.timestamp}>{time}</span>
        </div>
      </div>
    </div>
  );
}
