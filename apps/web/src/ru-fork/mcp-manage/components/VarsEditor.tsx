import { LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";
import type { McpVar } from "../types";

const EMPTY_VAR: McpVar = {
  name: "",
  value: "",
  secret: false,
  perProject: false,
  // Every var must resolve to a value; «обязательно» is implicit (no toggle).
  required: true,
  hasStoredSecret: false,
  origin: "user",
  valueLocked: false,
};

/** A compact checkbox + label used for the per-var flags. */
function FlagCheckbox({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      {label}
    </label>
  );
}

/**
 * The catalog vars block (identity-lock model): named values that fill the template's `${NAME}` holes
 * and are exported as process env vars. Every var must resolve to a value, so each row is one of two
 * kinds via `[для проекта]`: OFF = a catalog value filled here (shared by all projects); ON = a
 * per-project hole (no catalog value — each project fills it, so the value field is cleared + disabled).
 * `[секрет]` stores the value server-side (write-only). There is NO «обязательно» — all vars are required.
 */
export function VarsEditor({
  vars,
  onChange,
  lockedDeclarations = false,
}: {
  vars: readonly McpVar[];
  onChange: (next: McpVar[]) => void;
  /** Template mode: shipped rows (`origin === "shipped"`) have read-only name + flags; value stays editable. */
  lockedDeclarations?: boolean;
}) {
  const update = (index: number, partial: Partial<McpVar>) =>
    onChange(vars.map((variable, i) => (i === index ? { ...variable, ...partial } : variable)));
  const remove = (index: number) => onChange(vars.filter((_, i) => i !== index));
  const add = () => onChange([...vars, EMPTY_VAR]);

  return (
    <div className="space-y-2.5">
      <div>
        <Label>Переменные</Label>
        <span className="mt-1 block text-xs text-muted-foreground">
          Подставляются как <code>${"{NAME}"}</code> и передаются процессу как переменные
          окружения. Секреты не хранятся в открытом виде.
        </span>
      </div>

      {vars.map((variable, index) => {
        // A shipped declaration in template mode: its name + flags are read-only (the template owns
        // them); only the VALUE is the user's to fill, and the row can't be removed.
        const declarationLocked = lockedDeclarations && variable.origin === "shipped";
        // P4: the template author shipped a FIXED value (valueLocked) — read-only. This is a stable bit
        // from the definition, NOT derived from the live value, so typing/saving a user-fillable var
        // (e.g. JIRA_USERNAME) never locks it.
        const valueReadonly = declarationLocked && variable.valueLocked;
        // An empty, required CATALOG-level var (not a per-project hole, no stored secret) must be filled
        // here ⇒ red border on the value input, like the project dialog marks unfilled per-project holes.
        const catalogValueMissing =
          !variable.perProject &&
          variable.required &&
          variable.value.length === 0 &&
          !(variable.secret && variable.hasStoredSecret);
        return (
          // Rows have no stable id and never reorder (append/remove only); the inputs
          // are controlled by props, so an index key is safe here.
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2.5">
            <div className="flex items-center gap-2">
              <Input
                value={variable.name}
                onChange={(event) => update(index, { name: event.target.value.toUpperCase() })}
                placeholder="NAME"
                aria-label="Имя переменной"
                disabled={declarationLocked}
                className={cn(
                  "font-mono",
                  // Locked names are read-only ⇒ no fixed width: the box fits the text (no scroll).
                  // className lands on the wrapper span, so reach the inner <input> via [&_input].
                  declarationLocked
                    ? "w-auto max-w-full [&_input]:w-auto [&_input]:[field-sizing:content]"
                    : "w-2/5",
                )}
              />
              <Input
                value={variable.perProject ? "" : variable.value}
                type={variable.secret ? "password" : "text"}
                autoComplete="off"
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder={
                  variable.perProject
                    ? "заполняется в проекте"
                    : variable.secret && variable.hasStoredSecret && variable.value.length === 0
                      ? "сохранён — пусто оставит без изменений"
                      : variable.secret
                        ? "значение секрета"
                        : "значение"
                }
                aria-label="Значение переменной"
                // A per-project var has NO catalog value (filled per binding); a locked shipped value
                // is the template author's fixed value (P4) — both read-only.
                disabled={variable.perProject || valueReadonly}
                // Empty required catalog var ⇒ red border (it must be filled here).
                aria-invalid={catalogValueMissing || undefined}
                // Value stays a normal full-width field — NO field-sizing: a long URL would grow the box
                // past the row and add horizontal scroll. Only the NAME fits content.
                className="min-w-0 flex-1 font-mono"
              />
              {!declarationLocked && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => remove(index)}
                  title="Удалить переменную"
                  aria-label="Удалить переменную"
                >
                  <Trash2Icon className="size-4" />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-0.5">
              <FlagCheckbox
                checked={variable.secret}
                onChange={(secret) => update(index, { secret })}
                disabled={declarationLocked}
                label="секрет"
              />
              <FlagCheckbox
                checked={variable.perProject}
                onChange={(perProject) =>
                  // ON ⇒ a per-project hole: clear the catalog value (it's filled per project). OFF ⇒
                  // a catalog value. Either way the var is required (no separate «обязательно» toggle).
                  update(
                    index,
                    perProject
                      ? { perProject: true, value: "", required: true }
                      : { perProject: false, required: true },
                  )
                }
                disabled={declarationLocked}
                label="для проекта"
              />
              {valueReadonly && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <LockIcon className="size-3" />
                  задано шаблоном
                </span>
              )}
            </div>
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={add}>
        <PlusIcon className="size-4" />
        Добавить переменную
      </Button>
    </div>
  );
}
