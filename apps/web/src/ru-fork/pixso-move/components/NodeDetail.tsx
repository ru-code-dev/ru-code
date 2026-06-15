import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { previewDataUrl } from "../api";
import { usePixsoNode, usePixsoProcessing } from "../queries";
import { usePixsoStore } from "../store";
import { CodeCollapsible } from "./CodeCollapsible";
import { ResultBlock } from "./ResultBlock";

/** A node's detail: preview, its raw node JSON (formatted), and the LLM result blocks. */
export function NodeDetail() {
  const settings = usePixsoStore((state) => state.settings);
  const nodeId = usePixsoStore((state) => state.selectedNodeId);
  const back = usePixsoStore((state) => state.backToGallery);
  const node = usePixsoNode(settings.serverUrl, settings.designerId, nodeId);
  const processing = usePixsoProcessing(settings.serverUrl, settings.designerId, nodeId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-2 py-2">
        <Button variant="ghost" size="sm" onClick={back}>
          <ChevronLeftIcon className="size-4" />
          Макеты
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {node.isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : node.isError ? (
            <p className="text-sm text-destructive">{(node.error as Error).message}</p>
          ) : (
            <>
              <h3 className="truncate text-sm font-semibold">{node.data.rootName}</h3>
              <img
                src={previewDataUrl(node.data.preview)}
                alt={node.data.rootName}
                className="w-full rounded-lg border border-border bg-white object-contain"
              />
              <CodeCollapsible
                defaultOpen
                title={
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    JSON узла
                  </span>
                }
              >
                <ChatMarkdown
                  text={`\`\`\`json\n${formatJson(node.data.nodesJson)}\n\`\`\``}
                  cwd={undefined}
                />
              </CodeCollapsible>
            </>
          )}

          <Section title="Результаты обработки">
            {processing.isPending ? (
              <Spinner />
            ) : processing.isError ? (
              <p className="text-xs text-muted-foreground">Не удалось загрузить результаты.</p>
            ) : processing.data.length === 0 ? (
              <p className="text-xs text-muted-foreground">Пока нет результатов.</p>
            ) : (
              <ul className="space-y-2">
                {processing.data.map((result) => (
                  <li key={result.resultTag}>
                    <ResultBlock result={result} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}

// Pretty-print the stored (minified) node JSON so the code block renders multi-line. The
// code renderer only highlights — it doesn't re-indent — so this is what makes it readable.
function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}
