import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { DEFAULT_TIMEOUT_SECONDS } from "./serverConfigForm";

/**
 * Connect/probe timeout, in seconds. A server-level default in the catalog dialog and a
 * per-project override in the project dialog — same control, same value qwen uses live.
 */
export function TimeoutField({
  value,
  onChange,
  idPrefix,
  caption,
}: {
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
  caption: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={`${idPrefix}-timeout`}>Таймаут подключения (сек)</Label>
      <Input
        id={`${idPrefix}-timeout`}
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={String(DEFAULT_TIMEOUT_SECONDS)}
        className="mt-1.5 font-mono"
      />
      <span className="mt-1 block text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}
