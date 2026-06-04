import { type ReactElement, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { useMcpManagerStore } from "../store";
import type { McpRegistryServer, McpServerConfig } from "../types";
import { parseAdvancedJson } from "./addMcpParsing";
import { ServerConfigFields } from "./ServerConfigFields";
import {
  configFromDraft,
  draftFromConfig,
  EMPTY_DRAFT,
  type ServerConfigDraft,
} from "./serverConfigForm";

const PLACEHOLDER_JSON = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "\${PROJECT_CWD}"],
  "env": { "API_KEY": "\${MY_TOKEN}" }
}`;

/**
 * Add or edit a catalog server. `server` present → edit mode (prefilled). The trigger is
 * supplied by the caller (a `+` button in the list, a pencil in the detail view).
 */
export function McpServerDialog({
  trigger,
  server,
}: {
  trigger: ReactElement;
  server?: McpRegistryServer;
}) {
  const addServer = useMcpManagerStore((state) => state.addServer);
  const updateServer = useMcpManagerStore((state) => state.updateServer);
  const isEditing = server !== undefined;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(server?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [draft, setDraft] = useState<ServerConfigDraft>(
    server ? draftFromConfig(server.config) : EMPTY_DRAFT,
  );
  const [trusted, setTrusted] = useState(true);
  const [enableAllTools, setEnableAllTools] = useState(true);
  const [advancedJson, setAdvancedJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName(server?.name ?? "");
    setDescription(server?.description ?? "");
    setDraft(server ? draftFromConfig(server.config) : EMPTY_DRAFT);
    setTrusted(true);
    setEnableAllTools(true);
    setAdvancedJson("");
    setError(null);
  }

  function resolveConfig(): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
    if (advancedJson.trim().length > 0) {
      const parsed = parseAdvancedJson(advancedJson);
      return parsed.ok ? { ok: true, config: parsed.config } : { ok: false, error: parsed.error };
    }
    const result = configFromDraft(draft);
    return result.ok ? { ok: true, config: result.config } : { ok: false, error: result.error };
  }

  function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError("Укажите имя сервера.");
      return;
    }
    const resolved = resolveConfig();
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    const input = { name: name.trim(), description: description.trim(), config: resolved.config };
    if (isEditing) {
      updateServer(server.id, input);
    } else {
      addServer(input);
    }
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Re-sync to the latest server values whenever the dialog opens or closes, so a
        // re-opened edit dialog never shows stale pre-edit data.
        reset();
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Изменить MCP-сервер" : "Новый MCP-сервер"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Изменения применяются ко всем проектам, где используется этот сервер (если нет своей конфигурации)."
              : "Добавьте сервер в каталог. Потом его можно подключить к любому проекту."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div>
              <Label htmlFor="mcp-name">Имя</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="например, filesystem"
                autoComplete="off"
                className="mt-1.5"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Короткий идентификатор сервера в каталоге.
              </span>
            </div>
            <div>
              <Label htmlFor="mcp-description">
                Описание <span className="font-normal text-muted-foreground">— необязательно</span>
              </Label>
              <Textarea
                id="mcp-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Зачем нужен этот сервер?"
                rows={2}
                className="mt-1.5"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Обычно подтягивается из самого MCP-сервера — можно оставить пустым.
              </span>
            </div>

            <Tabs defaultValue="form">
              <TabsList className="mb-3 border-b border-border">
                <TabsTab value="form">Простая настройка</TabsTab>
                <TabsTab value="json">JSON</TabsTab>
                <TabsIndicator />
              </TabsList>

              <TabsPanel value="form">
                <div className="space-y-4">
                  <ServerConfigFields value={draft} onChange={setDraft} idPrefix="mcp-add" />

                  <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/30 p-3">
                    <label className="flex items-start gap-2.5">
                      <Checkbox
                        className="mt-0.5"
                        checked={trusted}
                        onCheckedChange={(checked) => setTrusted(checked === true)}
                      />
                      <span className="text-sm">
                        Доверять серверу
                        <span className="block text-xs text-muted-foreground">
                          Запускать инструменты без подтверждения.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2.5">
                      <Checkbox
                        className="mt-0.5"
                        checked={enableAllTools}
                        onCheckedChange={(checked) => setEnableAllTools(checked === true)}
                      />
                      <span className="text-sm">
                        Включить все инструменты
                        <span className="block text-xs text-muted-foreground">
                          По умолчанию для новых подключений к проектам.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              </TabsPanel>

              <TabsPanel value="json">
                <div>
                  <Label htmlFor="mcp-json">Конфигурация MCP (JSON)</Label>
                  <Textarea
                    id="mcp-json"
                    value={advancedJson}
                    onChange={(event) => setAdvancedJson(event.target.value)}
                    placeholder={PLACEHOLDER_JSON}
                    rows={8}
                    className="mt-1.5 font-mono text-xs"
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Ключи <code>command/args/env</code> или <code>httpUrl/headers</code>.
                    Перекрывает форму выше.
                  </span>
                </div>
              </TabsPanel>
            </Tabs>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button onClick={handleSubmit}>{isEditing ? "Сохранить" : "Добавить"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
