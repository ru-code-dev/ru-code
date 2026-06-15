import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import type { PixsoProcessingResult } from "../api";
import { statusLabel, statusTone } from "../format";
import { CodeCollapsible } from "./CodeCollapsible";

const fenced = (body: string): string => `\`\`\`\n${body}\n\`\`\``;

/** One processing result as a collapsible, code-formatted block (open when done). */
export function ResultBlock({ result }: { result: PixsoProcessingResult }) {
  const body = result.result ?? result.error ?? "";

  return (
    <CodeCollapsible
      defaultOpen={result.status === "done"}
      title={
        <code className="font-mono text-xs font-medium text-foreground">{result.resultTag}</code>
      }
      trailing={
        <Badge variant={statusTone[result.status]} className="shrink-0">
          {statusLabel[result.status]}
        </Badge>
      }
    >
      {body.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">Нет данных.</p>
      ) : (
        <ChatMarkdown text={fenced(body)} cwd={undefined} />
      )}
    </CodeCollapsible>
  );
}
