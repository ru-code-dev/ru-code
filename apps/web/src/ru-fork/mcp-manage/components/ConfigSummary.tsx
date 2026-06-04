import { Badge } from "~/components/ui/badge";
import type { McpServerConfig } from "../types";
import { transportDescription } from "../visuals";

/** Compact, read-only rendering of a server's transport + connection details. */
export function ConfigSummary({ config }: { config: McpServerConfig }) {
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 font-mono text-xs">
      <div className="flex items-center gap-2 font-sans">
        <Badge variant="secondary" className="uppercase">
          {config.transport}
        </Badge>
        <span className="text-muted-foreground">{transportDescription(config.transport)}</span>
      </div>
      {config.transport === "stdio" ? (
        <>
          <KeyValue label="command" value={`${config.command} ${config.args.join(" ")}`.trim()} />
          <EnvBlock label="env" entries={config.env} />
        </>
      ) : (
        <>
          <KeyValue label="url" value={config.httpUrl} />
          <EnvBlock label="headers" entries={config.headers} separator=": " />
        </>
      )}
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

function EnvBlock({
  label,
  entries,
  separator = "=",
}: {
  label: string;
  entries: Readonly<Record<string, string>>;
  separator?: string;
}) {
  const pairs = Object.entries(entries);
  if (pairs.length === 0) return null;
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 space-y-0.5">
        {pairs.map(([key, value]) => (
          <div key={key} className="break-all text-foreground">
            {key}
            {separator}
            <span className="text-sky-600 dark:text-sky-300/90">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
