import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

/**
 * The http escape hatch on a locked template (⑲): extra/override request headers, one `Key: Value`
 * per line, merged OVER the template's own headers. May contain `${NAME}` holes. The caller owns the
 * string state and parses it on save (via `parseHeaderLines`), mirroring `ExtraArgsField`.
 */
export function ExtraHeadersField({
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
      <Label htmlFor={`${idPrefix}-extra-headers`}>
        Доп. заголовки <span className="font-normal text-muted-foreground">— необязательно</span>
      </Label>
      <Textarea
        id={`${idPrefix}-extra-headers`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={"Authorization: Bearer ${TOKEN}"}
        rows={2}
        className="mt-1.5 font-mono"
      />
      <span className="mt-1 block text-xs text-muted-foreground">
        По одному <code>Key: Value</code> в строке. Добавляются к заголовкам шаблона. Можно
        подставлять <code>${"{NAME}"}</code> из переменных ниже.
      </span>
    </div>
  );
}
