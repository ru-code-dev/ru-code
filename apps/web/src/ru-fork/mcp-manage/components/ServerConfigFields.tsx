import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import type { McpTransport } from "../types";
import type { ServerConfigDraft } from "./serverConfigForm";

/** Small caption shown under a field to explain its meaning (matches the app's settings forms). */
function FieldCaption({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 block text-xs text-muted-foreground">{children}</span>;
}

function TransportSegmented({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (value: McpTransport) => void;
}) {
  const options: ReadonlyArray<{ value: McpTransport; label: string; hint: string }> = [
    { value: "stdio", label: "Локальный (stdio)", hint: "Запускает команду как процесс" },
    { value: "http", label: "Удалённый (HTTP)", hint: "Подключается по URL" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
            value === option.value
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground",
          )}
        >
          <span className="text-sm font-medium">{option.label}</span>
          <span className="text-xs text-muted-foreground">{option.hint}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Controlled transport-config fields shared by the catalog dialog and the per-project
 * override dialog. `idPrefix` keeps field ids unique when two instances co-exist.
 */
export function ServerConfigFields({
  value,
  onChange,
  idPrefix,
}: {
  value: ServerConfigDraft;
  onChange: (next: ServerConfigDraft) => void;
  idPrefix: string;
}) {
  const patch = (partial: Partial<ServerConfigDraft>) => onChange({ ...value, ...partial });

  return (
    <div className="space-y-4">
      <TransportSegmented value={value.transport} onChange={(transport) => patch({ transport })} />

      {value.transport === "stdio" ? (
        <>
          <div>
            <Label htmlFor={`${idPrefix}-command`}>Команда</Label>
            <Input
              id={`${idPrefix}-command`}
              value={value.command}
              onChange={(event) => patch({ command: event.target.value })}
              placeholder="npx"
              className="mt-1.5 font-mono"
            />
            <FieldCaption>Исполняемый файл, который запускает MCP-сервер.</FieldCaption>
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-args`}>Аргументы</Label>
            <Input
              id={`${idPrefix}-args`}
              value={value.argsText}
              onChange={(event) => patch({ argsText: event.target.value })}
              placeholder="-y @modelcontextprotocol/server-filesystem"
              className="mt-1.5 font-mono"
            />
            <FieldCaption>Через пробел. Передаются команде при запуске.</FieldCaption>
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-env`}>Переменные окружения</Label>
            <Textarea
              id={`${idPrefix}-env`}
              value={value.envText}
              onChange={(event) => patch({ envText: event.target.value })}
              placeholder={"API_KEY=${MY_TOKEN}"}
              rows={2}
              className="mt-1.5 font-mono"
            />
            <FieldCaption>
              По одной на строку: <code>KEY=value</code>. Поддерживаются плейсхолдеры{" "}
              <code>${"{VAR}"}</code> — секреты не хранятся в открытом виде.
            </FieldCaption>
          </div>
        </>
      ) : (
        <>
          <div>
            <Label htmlFor={`${idPrefix}-url`}>URL</Label>
            <Input
              id={`${idPrefix}-url`}
              value={value.httpUrl}
              onChange={(event) => patch({ httpUrl: event.target.value })}
              placeholder="https://mcp.example.com/mcp"
              className="mt-1.5 font-mono"
            />
            <FieldCaption>Адрес streamable-HTTP эндпоинта сервера.</FieldCaption>
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-headers`}>Заголовки</Label>
            <Textarea
              id={`${idPrefix}-headers`}
              value={value.headersText}
              onChange={(event) => patch({ headersText: event.target.value })}
              placeholder={"Authorization: Bearer ${MY_TOKEN}"}
              rows={2}
              className="mt-1.5 font-mono"
            />
            <FieldCaption>
              По одному на строку: <code>Key: value</code>. Для токенов используйте{" "}
              <code>${"{VAR}"}</code>.
            </FieldCaption>
          </div>
        </>
      )}
    </div>
  );
}
