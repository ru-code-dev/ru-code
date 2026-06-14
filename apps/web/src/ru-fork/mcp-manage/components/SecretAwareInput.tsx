import { CheckIcon } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "~/components/ui/input-group";

/**
 * One value field that knows about masked secrets. Three visual states:
 *  - saved secret, untouched (`hasStoredSecret`, empty value): a lock-check «сохранён» addon
 *    (native-title hint), no red border;
 *  - needs a value (`invalid`, empty): a destructive (red) border via `aria-invalid`;
 *  - editing: a plain field. Secrets render as a password input.
 */
export function SecretAwareInput({
  id,
  value,
  secret,
  hasStoredSecret = false,
  invalid = false,
  onChange,
  placeholder,
  className,
}: {
  readonly id?: string;
  readonly value: string;
  readonly secret: boolean;
  readonly hasStoredSecret?: boolean;
  readonly invalid?: boolean;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
}) {
  const showSaved = secret && hasStoredSecret && value.length === 0;
  return (
    <InputGroup className={className}>
      <InputGroupInput
        id={id}
        value={value}
        type={secret ? "password" : "text"}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="font-mono"
      />
      {showSaved && (
        <InputGroupAddon align="inline-end">
          <InputGroupText
            className="text-emerald-600 dark:text-emerald-300/90"
            title="Секрет сохранён. Пусто — оставит без изменений; введите, чтобы заменить."
          >
            <CheckIcon />
            сохранён
          </InputGroupText>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
