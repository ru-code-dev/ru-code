import { ChevronLeftIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import { ScrollArea } from "~/components/ui/scroll-area";
import { MIN_SYNC_INTERVAL_MIN, usePixsoStore } from "../store";

/** The panel's settings form — real-time (no save button), like the rest of ru-code. */
export function SettingsView() {
  const settings = usePixsoStore((state) => state.settings);
  const update = usePixsoStore((state) => state.updateSettings);
  const back = usePixsoStore((state) => state.backToGallery);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-2 py-2">
        <Button variant="ghost" size="sm" onClick={back}>
          <ChevronLeftIcon className="size-4" />
          Макеты
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <Field>
            <FieldLabel>Адрес сервера</FieldLabel>
            <Input
              value={settings.serverUrl}
              onChange={(event) => update({ serverUrl: event.target.value })}
              placeholder="http://127.0.0.1:7787"
              aria-label="Адрес сервера"
            />
            <FieldDescription>Сервер Pixso Move, к которому отправляет данные плагин.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Идентификатор дизайнера</FieldLabel>
            <Input
              value={settings.designerId}
              onChange={(event) => update({ designerId: event.target.value })}
              placeholder="dz_…"
              aria-label="Идентификатор дизайнера"
            />
            <FieldDescription>Ключ дизайнера — тот же, что в плагине Pixso.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Интервал синхронизации, мин</FieldLabel>
            <NumberField
              className="w-32"
              size="sm"
              min={MIN_SYNC_INTERVAL_MIN}
              step={1}
              value={settings.syncIntervalMin}
              onValueChange={(value) =>
                update({
                  syncIntervalMin: Math.max(MIN_SYNC_INTERVAL_MIN, value ?? MIN_SYNC_INTERVAL_MIN),
                })
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Уменьшить интервал" />
                <NumberFieldInput inputMode="numeric" aria-label="Интервал синхронизации" />
                <NumberFieldIncrement aria-label="Увеличить интервал" />
              </NumberFieldGroup>
            </NumberField>
            <FieldDescription>
              Не меньше {MIN_SYNC_INTERVAL_MIN} минут. Сейчас обновление запускается вручную.
            </FieldDescription>
          </Field>
        </div>
      </ScrollArea>
    </div>
  );
}
