import { Badge } from "~/components/ui/badge";
import type { McpServerConfig, McpVar } from "../types";
import { transportDescription } from "../visuals";

/** Compact, read-only rendering of a server's transport TEMPLATE + declared vars. */
export function ConfigSummary({
  config,
  vars,
}: {
  config: McpServerConfig;
  vars?: readonly McpVar[];
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 font-mono text-xs">
      <div className="flex items-center gap-2 font-sans">
        <Badge variant="secondary" className="uppercase">
          {config.transport}
        </Badge>
        <span className="text-muted-foreground">{transportDescription(config.transport)}</span>
      </div>
      {config.transport === "stdio" ? (
        <KeyValue label="command" value={`${config.command} ${config.args.join(" ")}`.trim()} />
      ) : (
        <>
          <KeyValue label="url" value={config.httpUrl} />
          <HeadersBlock headers={config.headers} />
        </>
      )}
      {vars && vars.length > 0 && <VarsBlock vars={vars} />}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-foreground">{value || "—"}</span>
    </div>
  );
}

function HeadersBlock({ headers }: { headers: Readonly<Record<string, string>> }) {
  const pairs = Object.entries(headers);
  if (pairs.length === 0) return null;
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">headers</span>
      <div className="min-w-0 space-y-0.5">
        {pairs.map(([key, value]) => (
          <div key={key} className="break-all text-foreground">
            {key}: <span className="text-sky-600 dark:text-sky-300/90">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VarsBlock({ vars }: { vars: readonly McpVar[] }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">vars</span>
      <div className="min-w-0 space-y-0.5">
        {vars.map((variable) => {
          // Unfilled CATALOG-level required var ⇒ «требует настройки» (amber). A per-project hole being
          // empty at the catalog is normal (it's filled per project) ⇒ not marked.
          const needsCatalogValue =
            !variable.perProject && variable.required && variable.value.length === 0;
          return (
            <div key={variable.name} className="flex flex-wrap items-center gap-1.5 break-all">
              <span
                className={
                  needsCatalogValue ? "text-amber-700 dark:text-amber-300/90" : "text-foreground"
                }
              >
                {variable.name}
                {needsCatalogValue && <span className="ml-0.5">*</span>}
              </span>
              {variable.secret && (
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  секрет
                </Badge>
              )}
              {variable.perProject && (
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  проект{variable.required ? " *" : ""}
                </Badge>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
