import { type ReactElement, useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
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
import { useMcpMutations, useMcpProjectBindings, useMcpProjects } from "../useMcp";
import type { AddServerInput } from "../useMcp";
import type { McpRegistryServer, McpServerConfig, McpVar } from "../types";
import { parseAdvancedJson, parseHeaderLines } from "./addMcpParsing";
import { ExtraArgsField } from "./ExtraArgsField";
import { ExtraHeadersField } from "./ExtraHeadersField";
import { ServerConfigFields } from "./ServerConfigFields";
import { TimeoutField } from "./TimeoutField";
import { VarsEditor } from "./VarsEditor";
import {
  configFromDraft,
  describeEditImpact,
  draftFromConfig,
  type EditImpact,
  EMPTY_DRAFT,
  parseTimeout,
  recordToLines,
  type ServerConfigDraft,
  timeoutTextFromMs,
  validateVars,
  varWarnings,
} from "./serverConfigForm";

const PLACEHOLDER_JSON = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "\${PROJECT_CWD}"],
  "env": { "API_KEY": "your-token" }
}`;

type ResolvedInput =
  | { ok: true; config: McpServerConfig; vars: McpVar[]; timeoutMs: number | undefined }
  | { ok: false; error: string };

/**
 * Add or edit a catalog server. `server` present → edit mode (prefilled). A managed template
 * (`server.locked`) renders in TEMPLATE mode: the command/args are read-only, the user edits only var
 * values + extra args. The trigger is supplied by the caller (a `+` button, a pencil in the detail).
 */
export function McpServerDialog({
  trigger,
  server,
}: {
  trigger: ReactElement;
  server?: McpRegistryServer;
}) {
  const { addServer, updateServer } = useMcpMutations();
  const projects = useMcpProjects();
  const bindings = useMcpProjectBindings();
  const isEditing = server !== undefined;
  const isTemplate = server?.locked === true;

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectName = (projectId: string) => projectNameById.get(projectId) ?? projectId;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(server?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [draft, setDraft] = useState<ServerConfigDraft>(
    server ? draftFromConfig(server.config) : EMPTY_DRAFT,
  );
  const [vars, setVars] = useState<McpVar[]>(server ? [...server.vars] : []);
  const [extraArgsText, setExtraArgsText] = useState((server?.extraArgs ?? []).join(" "));
  const [extraHeadersText, setExtraHeadersText] = useState(
    recordToLines(server?.extraHeaders ?? {}, ": "),
  );
  const [timeoutText, setTimeoutText] = useState(timeoutTextFromMs(server?.timeoutMs));
  const [trusted, setTrusted] = useState(server?.trust ?? true);
  const [advancedJson, setAdvancedJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Warn-on-impact: a disruptive edit (removed per-project var / new required var) stages here until
  // the user confirms, instead of dispatching immediately (AMEND-2).
  const [impact, setImpact] = useState<EditImpact | null>(null);
  const [pendingInput, setPendingInput] = useState<AddServerInput | null>(null);

  function reset() {
    setName(server?.name ?? "");
    setDescription(server?.description ?? "");
    setDraft(server ? draftFromConfig(server.config) : EMPTY_DRAFT);
    setVars(server ? [...server.vars] : []);
    setExtraArgsText((server?.extraArgs ?? []).join(" "));
    setExtraHeadersText(recordToLines(server?.extraHeaders ?? {}, ": "));
    setTimeoutText(timeoutTextFromMs(server?.timeoutMs));
    setTrusted(server?.trust ?? true);
    setAdvancedJson("");
    setError(null);
    setImpact(null);
    setPendingInput(null);
  }

  // Soft, non-blocking authoring warnings (undeclared `${X}` refs, `$…` in values).
  const warnings = advancedJson.trim().length === 0 ? varWarnings(draft, vars) : [];
  // extraArgs only apply to stdio (http has no args) — show the field there only.
  const showExtraArgs = draft.transport === "stdio";
  // extraHeaders only apply to http — and only as a locked-template escape hatch (⑲).
  const showExtraHeaders = draft.transport === "http";

  function resolveInput(): ResolvedInput {
    if (advancedJson.trim().length > 0) {
      const parsed = parseAdvancedJson(advancedJson);
      return parsed.ok
        ? { ok: true, config: parsed.config, vars: parsed.vars, timeoutMs: parsed.timeoutMs }
        : { ok: false, error: parsed.error };
    }
    const varsCheck = validateVars(vars);
    if (!varsCheck.ok) {
      return { ok: false, error: varsCheck.error };
    }
    const configResult = configFromDraft(draft);
    if (!configResult.ok) {
      return { ok: false, error: configResult.error };
    }
    const timeout = parseTimeout(timeoutText);
    if (!timeout.ok) {
      return { ok: false, error: timeout.error };
    }
    return { ok: true, config: configResult.config, vars, timeoutMs: timeout.timeoutMs };
  }

  /** Dispatch the add/update; close + clear on success, or stay OPEN (blocked) on a server error. */
  function commit(input: AddServerInput) {
    // ru-fork #5: a server rejection is shown as a readable TOAST by the mutation; the dialog just
    // stays open (the add/save is blocked) and closes only on success.
    const dispatched = isEditing ? updateServer(server.id, input) : addServer(input);
    void dispatched
      .then(() => {
        setOpen(false);
        setImpact(null);
        setPendingInput(null);
      })
      .catch(() => undefined);
  }

  function handleSubmit() {
    setError(null);
    if (server?.checking) {
      setError("Идёт проверка сервера — дождитесь её завершения.");
      return;
    }
    if (!name.trim()) {
      setError("Укажите имя сервера.");
      return;
    }
    const resolved = resolveInput();
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    const extraArgs = showExtraArgs ? extraArgsText.split(/\s+/u).filter(Boolean) : [];
    // ⑲ extraHeaders only ship for a locked http template (the escape hatch); manual http edits headers directly.
    const extraHeaders = showExtraHeaders && isTemplate ? parseHeaderLines(extraHeadersText) : {};
    const input: AddServerInput = {
      name: name.trim(),
      description: description.trim(),
      config: resolved.config,
      vars: resolved.vars,
      extraArgs,
      extraHeaders,
      trust: trusted,
      ...(isTemplate ? { locked: true } : {}),
      ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
    };
    // On an edit, warn before disrupting projects already using this server (removed per-project var
    // / brand-new required var). Stage the input and open the confirmation instead of dispatching.
    if (isEditing) {
      const editImpact = describeEditImpact(
        { id: server.id, vars: server.vars },
        resolved.vars,
        bindings,
        projectName,
      );
      if (editImpact !== null) {
        setPendingInput(input);
        setImpact(editImpact);
        return;
      }
    }
    commit(input);
  }

  const formBody = (
    <div className="space-y-4">
      <ServerConfigFields
        value={draft}
        onChange={setDraft}
        idPrefix="mcp-add"
        disabled={isTemplate}
        hideTransport={isTemplate}
      />

      {/* ⑱ escape hatch — stdio AND a locked template only (a manual server edits args directly) */}
      {showExtraArgs && isTemplate && (
        <ExtraArgsField value={extraArgsText} onChange={setExtraArgsText} idPrefix="mcp-add" />
      )}

      {/* ⑲ escape hatch — http AND a locked template only (a manual server edits headers directly) */}
      {showExtraHeaders && isTemplate && (
        <ExtraHeadersField
          value={extraHeadersText}
          onChange={setExtraHeadersText}
          idPrefix="mcp-add"
        />
      )}

      <VarsEditor vars={vars} onChange={setVars} lockedDeclarations={isTemplate} />

      <TimeoutField
        value={timeoutText}
        onChange={setTimeoutText}
        idPrefix="mcp-add"
        caption={
          <>
            Сколько ждать ответа сервера — при проверке и в самой сессии qwen. Можно переопределить в
            проекте.
          </>
        }
      />

      {isEditing && vars.some((variable) => variable.secret) && (
        <p className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Секреты не показываются. Оставьте поле пустым, чтобы очистить значение, или введите заново,
          чтобы изменить.
        </p>
      )}

      {warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300/90">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

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
              Запускать инструменты без подтверждения. Для серверов с инструментами записи; инструменты
              только для чтения qwen разрешает всегда.
            </span>
          </span>
        </label>
      </div>
    </div>
  );

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
          <DialogTitle>
            {isTemplate ? "Настроить шаблон MCP" : isEditing ? "Изменить MCP-сервер" : "Новый MCP-сервер"}
          </DialogTitle>
          <DialogDescription>
            {isTemplate
              ? "Команда шаблона зафиксирована. Заполните значения переменных и при необходимости добавьте аргументы."
              : isEditing
                ? "Изменения применяются ко всем проектам, где используется этот сервер."
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
                disabled={isTemplate} // ⑯ a built-in owns its name (set by the migrator)
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
                disabled={isTemplate} // ⑯ a built-in owns its description (shipped / probe-backfilled)
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Обычно подтягивается из самого MCP-сервера — можно оставить пустым.
              </span>
            </div>

            {/* Template mode has no JSON tab (the command is locked) — render the form directly. */}
            {isTemplate ? (
              formBody
            ) : (
              <Tabs defaultValue="form">
                <TabsList className="mb-3 border-b border-border">
                  <TabsTab value="form">Простая настройка</TabsTab>
                  <TabsTab value="json">JSON</TabsTab>
                  <TabsIndicator />
                </TabsList>

                <TabsPanel value="form">{formBody}</TabsPanel>

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
                      Ключи <code>command/args/env</code> или <code>httpUrl/headers</code>. Блок{" "}
                      <code>env</code> станет переменными. Перекрывает форму выше.
                    </span>
                  </div>
                </TabsPanel>
              </Tabs>
            )}

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

      {/* Warn-on-impact confirmation (AMEND-2): nested over the editor; base-ui handles the stack. */}
      <AlertDialog
        open={impact !== null}
        onOpenChange={(next) => {
          if (!next) {
            setImpact(null);
            setPendingInput(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Применить изменения?</AlertDialogTitle>
            <AlertDialogDescription>
              Это изменение затронет проекты, уже использующие сервер.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {impact !== null && (
            <div className="space-y-3 text-sm">
              {impact.removedVars.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium">Удаляются переменные проекта:</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {impact.removedVars.map((removed) => (
                      <li key={removed.name}>
                        <code>{removed.name}</code> — {removed.projects.join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {impact.newRequiredProjects.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium">Появится обязательная переменная без значения — проекты потребуют настройки:</p>
                  <p className="text-muted-foreground">{impact.newRequiredProjects.join(", ")}</p>
                </div>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Отмена</AlertDialogClose>
            <Button
              onClick={() => {
                if (pendingInput !== null) {
                  commit(pendingInput);
                }
              }}
            >
              Применить
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}
