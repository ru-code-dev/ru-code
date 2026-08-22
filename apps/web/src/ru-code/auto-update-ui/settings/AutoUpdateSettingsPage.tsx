// ru-code: auto-update settings — page assembly (v3).
//
// Compact (≥1 source works): hero + auto-check switch + «Настроить источники
// вручную». Advanced (nothing works OR the user opened manual setup): compact +
// full source editor + check history. The mode is derived, never stored.
import { SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { APP_NAME } from "@ru-code/branding";

import { anySourceWorks } from "../model";
import { setAutoCheck, setNotifyPrefs, useAutoUpdate } from "../store/autoUpdateStore";
import { setManualSourcesOpen, useManualSourcesOpen } from "../store/autoUpdateClientLocal";
import { Button } from "../ui-kit/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../ui-kit/layout";
import { Switch } from "../ui-kit/switch";
import { HistorySection } from "./HistorySection";
import { ReleaseNotesSection } from "./ReleaseNotesSection";
import { deriveSourcesSection } from "./sourcesVisibility";
import { SourcesSection } from "./SourcesSection";
import { StatusHeroCard } from "./StatusHeroCard";
import { CredentialsWizard, type WizardKind } from "./wizard/CredentialsWizard";

export function AutoUpdateSettingsPage() {
  const state = useAutoUpdate();
  const manualSourcesOpen = useManualSourcesOpen();
  const [wizard, setWizard] = useState<WizardKind | null>(null);
  // The section-visibility latch: once the section is up because nothing worked, it stays up
  // until the user hides it — a source coming alive under their hands must not unmount the
  // editor they are using. The whole rule is pure in sourcesVisibility.ts.
  const [latchedOpen, setLatchedOpen] = useState(false);
  const notesRef = useRef<HTMLDivElement>(null);
  const sourcesRef = useRef<HTMLDivElement>(null);

  // Disconnected (`state === null`) is UNKNOWN, not broken — it must not latch the section.
  const working = state === null ? true : anySourceWorks(state);
  const section = deriveSourcesSection({
    working,
    manualSourcesOpen,
    latchedOpen,
  });
  useEffect(() => {
    if (section.latchedOpen !== latchedOpen) setLatchedOpen(section.latchedOpen);
  }, [section.latchedOpen, latchedOpen]);

  if (state === null) {
    return (
      <SettingsPageContainer className="gap-5" data-testid="auto-update-settings-page">
        <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Not connected — reconnect to manage updates.
        </div>
      </SettingsPageContainer>
    );
  }

  const advanced = section.visible;

  const openSources = () => {
    setManualSourcesOpen(true);
    window.setTimeout(
      () => sourcesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      60,
    );
  };

  const showReleaseNotes = () =>
    notesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <SettingsPageContainer className="gap-5" data-testid="auto-update-settings-page">
        <StatusHeroCard onConfigureSources={openSources} onShowReleaseNotes={showReleaseNotes} />

        <SettingsSection title="Update check">
          <SettingsRow
            control={
              <Switch
                checked={state.autoCheck}
                onCheckedChange={(checked) => setAutoCheck(checked)}
              />
            }
            description={`${APP_NAME} checks the sources on a schedule during working hours. Reloading the app never starts a check.`}
            status={
              state.autoCheck && state.nextCheckClock !== null ? (
                <>
                  Next check at{" "}
                  <span className="font-mono text-foreground/80">{state.nextCheckClock}</span>
                </>
              ) : null
            }
            title="Check automatically"
          />
          <SettingsRow
            control={
              <Switch
                checked={!state.notify.releasesMuted}
                onCheckedChange={(checked) =>
                  setNotifyPrefs({
                    releasesMuted: !checked,
                    problemsMuted: state.notify.problemsMuted,
                  })
                }
              />
            }
            description="Show a pill and a toast when a newer version is found."
            title="Notify about new versions"
          />
          <SettingsRow
            control={
              <Switch
                checked={!state.notify.problemsMuted}
                onCheckedChange={(checked) =>
                  setNotifyPrefs({
                    releasesMuted: state.notify.releasesMuted,
                    problemsMuted: !checked,
                  })
                }
              />
            }
            description="Remind me when no source can deliver updates and one needs attention."
            title="Notify about source problems"
          />
        </SettingsSection>

        <ReleaseNotesSection ref={notesRef} />

        {advanced ? (
          <>
            <div ref={sourcesRef}>
              <SourcesSection onOpenWizard={(kind) => setWizard(kind)} />
            </div>
            <HistorySection />
            {working ? (
              <div className="flex justify-center">
                <Button
                  onClick={() => {
                    // Dismiss BOTH holds: the user's own open and the broken-state latch.
                    setManualSourcesOpen(false);
                    setLatchedOpen(false);
                  }}
                  size="xs"
                  variant="ghost"
                >
                  Hide manual setup
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex justify-center">
            <Button
              data-testid="auto-update-configure-sources"
              onClick={openSources}
              size="xs"
              variant="ghost"
            >
              <SlidersHorizontalIcon />
              Configure sources manually
            </Button>
          </div>
        )}
      </SettingsPageContainer>

      <CredentialsWizard kind={wizard} onClose={() => setWizard(null)} />
    </>
  );
}
