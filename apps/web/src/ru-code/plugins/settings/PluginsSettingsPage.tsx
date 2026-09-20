// ru-code S38 (V2-43, step 11): Settings ▸ Plugins — one row per plugin, one switch each.
//
// WHY THIS PAGE EXISTS AT ALL. A user plugin is switched off by deleting its folder; a SHIPPED one
// cannot be — it lives inside the release payload and comes back with the next update. Until now
// the only way to say "not this one" was to hand-edit `<stateDir>/plugins/disabled.json`, which is
// an operator's tool, not a user's. And since V2-42 the host says nothing to the user about a
// plugin that failed: this is where they find out, and it is the only place.
//
// WHAT IT DOES NOT DO. It does not uninstall, and it does not restart anything. A plugin the server
// already activated keeps running until the app restarts — tearing a plugin's surfaces out from
// under an open thread is not something a switch should do — so the switch reads as SAVED, not as
// RUNNING, and the callout above the list says what is owed. Those are two different facts and the
// row carries both (`plugin.settings`), which is what makes the sentence honest instead of hopeful.
//
// THE ROW IS THE PROVIDER INSTANCE CARD (step 12). Not "on its shape" — its JSX, pasted, with only
// the strings and the handlers changed; the per-element donor lines are on `PluginRow` below. That
// is where the hover, the version's own style and the collapsible's field layout come from. The
// callout is the app's `Alert`, inline, in the page flow. Nothing here is styled by hand except the
// dot's three colour tokens, which are the same ones `providerStatus.ts` uses.
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { L } from "@ru-code/localization";

import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Switch } from "~/components/ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { cn } from "~/lib/utils";

import { fetchPluginSettings, setPluginEnabled } from "./pluginsSettingsClient";
import {
  dataKeptLine,
  detailsLabel,
  errorFieldLabel,
  folderFieldLabel,
  mergeRows,
  orderedRows,
  restartLine,
  rootLabel,
  rowDescription,
  rowDotClass,
  rowName,
  sourceFieldLabel,
  switchLabel,
  type PluginSettingsRow,
} from "./pluginsSettingsModel";

/**
 * One plugin, rendered by the PROVIDER INSTANCE CARD's own JSX.
 *
 * Every element below is pasted from `components/settings/ProviderInstanceCard.tsx` and only the
 * strings and the handlers are ours (rule 41):
 *
 *   · the outer two divs      ← ProviderInstanceCard.tsx:632-633 (the hover lives on the OUTER one;
 *                               step 11 merged the two and lost it, which is what the owner saw)
 *   · the row grid            ← :634-635, :738 — `sm:flex-row sm:items-center sm:justify-between`
 *   · the title line          ← :636 + `titleIconNode`'s third arm :557 (the bare status dot) +
 *                               `titleHeadNode` :563-565
 *   · the version             ← `versionCodeNode` :627-629 — `code.text-xs.text-muted-foreground`,
 *                               which is how the card shows a version. Step 11 invented a chip.
 *   · the description line    ← `authRowNode` :610
 *   · chevron + switch        ← :739-753
 *   · the collapsible         ← :758-760 and the labelled-field shape inside it, :766-781
 */
function PluginRow(props: {
  readonly row: PluginSettingsRow;
  readonly busy: boolean;
  readonly onToggle: (row: PluginSettingsRow) => void;
}) {
  const { row, busy, onToggle } = props;
  const [expanded, setExpanded] = useState(false);
  const description = rowDescription(row);

  return (
    <div
      className="rounded-xl transition-colors hover:bg-muted/20"
      data-plugin-state={row.state}
      data-testid={`plugin-row-${row.id}`}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", rowDotClass(row))}
                data-testid={`plugin-dot-${row.id}`}
              />
              <h3 className="truncate font-medium text-foreground text-sm tracking-[-0.005em]">
                {rowName(row)}
              </h3>
              <code className="text-muted-foreground text-xs">{row.version}</code>
            </div>
            {description === "" ? null : (
              <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] text-muted-foreground/80 leading-[1.45]">
                {description}
              </p>
            )}
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              aria-label={detailsLabel(row)}
              onClick={() => {
                setExpanded(!expanded);
              }}
              size="compact"
              variant="ghost-muted"
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
              />
            </Button>
            <Switch
              aria-label={switchLabel(row)}
              checked={row.enabledSaved}
              disabled={busy}
              onCheckedChange={() => {
                onToggle(row);
              }}
            />
          </div>
        </div>
      </div>

      <Collapsible onOpenChange={setExpanded} open={expanded}>
        <CollapsibleContent>
          <div className="space-y-5 px-3 pt-2 pb-4 sm:px-4">
            <div>
              <span className="block font-medium text-foreground text-xs">
                {sourceFieldLabel()}
              </span>
              <span className="mt-1 block text-muted-foreground text-xs">
                {rootLabel(row.root)}
              </span>
            </div>
            {row.dir === undefined ? null : (
              <div>
                <span className="block font-medium text-foreground text-xs">
                  {folderFieldLabel()}
                </span>
                {/* The path is a FACT the user may have to read out; it wraps, it is never cut. */}
                <code className="mt-1 block break-all text-muted-foreground text-xs">
                  {row.dir}
                </code>
              </div>
            )}
            {row.state === "failed" && row.error !== undefined ? (
              <div>
                <span className="block font-medium text-foreground text-xs">
                  {errorFieldLabel()}
                </span>
                <p
                  className="mt-1 block break-all text-destructive text-xs"
                  data-testid={`plugin-error-${row.id}`}
                >
                  {row.error}
                </p>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function PluginsSettingsPage() {
  const [rows, setRows] = useState<ReadonlyArray<PluginSettingsRow> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The plugin whose switch is in flight — one at a time, so a row cannot be double-submitted. */
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPluginSettings()
      .then((next) => {
        if (!cancelled) {
          setRows(next);
          setFailure(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((row: PluginSettingsRow) => {
    setBusyId(row.id);
    void setPluginEnabled(row.id, !row.enabledSaved)
      .then((answered) => {
        // The SERVER's answer, never an optimistic local flip: the file is the truth and it has
        // just been rewritten whole. Merged by id so the rows that did not change keep their
        // object identity and React updates the one row in place — the list never remounts.
        setRows((current) => (current === null ? answered : mergeRows(current, answered)));
        setFailure(null);
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusyId(null);
      });
  }, []);

  const title = L("Plugins", "Расширения");

  if (failure !== null && rows === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title={title}>
          <SettingsRow
            data-testid="plugins-settings-failure"
            title={L("Could not read the plugin list", "Не удалось получить список расширений")}
            description={failure}
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const listed = orderedRows(rows ?? []);
  const restart = restartLine(rows ?? []);

  return (
    <SettingsPageContainer>
      <SettingsSection title={title} data-testid="plugins-settings-page">
        {restart === "" ? null : (
          <Alert
            data-testid="plugins-settings-restart"
            aria-live="polite"
            variant="warning"
            className="mx-3 sm:mx-4"
          >
            {restart}
          </Alert>
        )}

        {rows === null ? (
          <SettingsRow
            title={L("Reading the plugin list…", "Читаем список расширений…")}
            description=""
          />
        ) : listed.length === 0 ? (
          <SettingsRow
            data-testid="plugins-settings-empty"
            title={L("No plugins installed", "Расширений нет")}
            description={L(
              "Drop a plugin folder into the plugins directory and restart the app.",
              "Положите папку расширения в каталог плагинов и перезапустите приложение.",
            )}
          />
        ) : (
          listed.map((row) => (
            <PluginRow key={row.id} row={row} busy={busyId === row.id} onToggle={toggle} />
          ))
        )}

        {listed.length === 0 ? null : (
          <SettingsRow
            data-testid="plugins-settings-data-kept"
            title={L("Switching off is not uninstalling", "Выключение — это не удаление")}
            description={dataKeptLine()}
          />
        )}

        {failure === null || rows === null ? null : (
          <SettingsRow
            data-testid="plugins-settings-failure"
            title={L("The switch did not reach the server", "Переключатель не дошёл до сервера")}
            description={failure}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
