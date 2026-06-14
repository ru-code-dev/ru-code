import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

/**
 * The user's escape hatch on a locked template (and an optional extra for manual stdio servers):
 * space-separated args appended AFTER the template's own args. May contain `${NAME}` holes. The
 * caller owns the string state and splits it on save (mirrors the args field parsing).
 */
export function ExtraArgsField({
  value,
  onChange,
  idPrefix,
}: {
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
}) {
  return (
    <div>
      <Label htmlFor={`${idPrefix}-extra-args`}>
        Доп. аргументы <span className="font-normal text-muted-foreground">— необязательно</span>
      </Label>
      <Input
        id={`${idPrefix}-extra-args`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={"--read-only --max-files 100"}
        className="mt-1.5 font-mono"
      />
      <span className="mt-1 block text-xs text-muted-foreground">
        Через пробел. Добавляются к команде шаблона. Можно подставлять <code>${"{NAME}"}</code> из
        переменных ниже.
      </span>
    </div>
  );
}
