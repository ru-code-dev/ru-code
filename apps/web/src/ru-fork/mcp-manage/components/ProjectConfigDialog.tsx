import { type ReactElement, useState } from "react";
import { Button } from "~/components/ui/button";
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
import { Label } from "~/components/ui/label";
import { useMcpMutations } from "../useMcp";
import type { McpProjectBinding, McpRegistryServer, McpVar } from "../types";
import { SecretAwareInput } from "./SecretAwareInput";
import { TimeoutField } from "./TimeoutField";
import { parseTimeout, timeoutTextFromMs } from "./serverConfigForm";

/** The per-project holes the catalog opened for this server (name read-only, value editable). */
function perProjectVars(server: McpRegistryServer): readonly McpVar[] {
  return server.vars.filter((variable) => variable.perProject);
}

/** Initial input values for the holes, prefilled from the binding (secrets read back masked). */
function initialValues(
  vars: readonly McpVar[],
  binding: McpProjectBinding,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of vars) {
    values[variable.name] = binding.varValues[variable.name] ?? "";
  }
  return values;
}

/**
 * Configure a server *for one project*. Identity is locked by the catalog — this dialog only
 * fills the per-project holes (`[для проекта]` vars) and the timeout override. Empty ⇒ inherit
 * the catalog value. Saving replaces the binding's per-project values.
 */
export function ProjectConfigDialog({
  trigger,
  server,
  binding,
}: {
  trigger: ReactElement;
  server: McpRegistryServer;
  binding: McpProjectBinding;
}) {
  const { setProjectBinding } = useMcpMutations();
  const vars = perProjectVars(server);

  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(vars, binding));
  const [timeoutText, setTimeoutText] = useState(timeoutTextFromMs(binding.timeoutMs));
  const [error, setError] = useState<string | null>(null);
  const storedSecretNames = new Set(binding.secretVarNames);

  function resync() {
    setValues(initialValues(vars, binding));
    setTimeoutText(timeoutTextFromMs(binding.timeoutMs));
    setError(null);
  }

  function handleSave() {
    setError(null);
    const timeout = parseTimeout(timeoutText);
    if (!timeout.ok) {
      setError(timeout.error);
      return;
    }
    // Empty fields are omitted → the binding inherits the catalog value for that hole.
    const varValues: Record<string, string> = {};
    const keepVarValues: string[] = [];
    for (const variable of vars) {
      const value = (values[variable.name] ?? "").trim();
      if (value.length > 0) {
        varValues[variable.name] = value;
      } else if (variable.secret && storedSecretNames.has(variable.name)) {
        // Masked secret left blank ⇒ preserve the stored per-project ref instead of clearing it.
        keepVarValues.push(variable.name);
      }
    }
    // ru-fork #5: a save rejection is shown as a readable TOAST by the mutation; keep the dialog open
    // (blocked) and close only on success.
    void setProjectBinding(server.id, binding.projectId, {
      varValues,
      keepVarValues,
      timeoutMs: timeout.timeoutMs ?? null,
    })
      .then(() => {
        setOpen(false);
      })
      .catch(() => undefined);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          resync(); // re-sync each time the dialog opens (binding may have changed)
        }
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Настройка «{server.name}» для проекта</DialogTitle>
          <DialogDescription>
            Эти параметры действуют только в этом проекте. Сам сервер берётся из каталога и не
            меняется.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {vars.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                У этого сервера нет переменных для настройки в проекте.
              </p>
            ) : (
              <div className="space-y-3">
                {vars.map((variable) => {
                  const hasDefault = !variable.secret && variable.value.length > 0;
                  return (
                    <div key={variable.name}>
                      <Label htmlFor={`mcp-proj-${variable.name}`} className="font-mono">
                        {variable.name}
                        {variable.required && <span className="ml-0.5 text-destructive">*</span>}
                      </Label>
                      <SecretAwareInput
                        id={`mcp-proj-${variable.name}`}
                        value={values[variable.name] ?? ""}
                        secret={variable.secret}
                        hasStoredSecret={storedSecretNames.has(variable.name)}
                        invalid={binding.missingVars.includes(variable.name)}
                        onChange={(next) =>
                          setValues((prev) => ({ ...prev, [variable.name]: next }))
                        }
                        placeholder={
                          variable.secret
                            ? "значение секрета"
                            : hasDefault
                              ? `по умолчанию: ${variable.value}`
                              : "значение"
                        }
                        className="mt-1.5"
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <TimeoutField
              value={timeoutText}
              onChange={setTimeoutText}
              idPrefix="mcp-proj"
              caption={<>Пусто — берётся таймаут из каталога.</>}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button onClick={handleSave}>Сохранить</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
