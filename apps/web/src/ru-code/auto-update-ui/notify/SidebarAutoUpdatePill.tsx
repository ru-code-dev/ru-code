// ru-code: sidebar pill for the auto-update feature — mirrors the provider update
// pill's look/behaviour (SidebarProviderUpdatePill) but reads the auto-update live
// state. The decision (show / kind / tone / re-raise) is the pure `computePillView`;
// this component only renders it, records dismissals, and hosts the single app-root
// driver + relative-time mirror (issues #6/#12/#23/#30).
//
// Re-raise: the PROBLEMS pill runs off the server-owned `notified.problems` stamp and
// its ✕ writes it (snoozeNotification), the same record the toast writes. The RELEASE
// pill is a status indicator — always shown while a release is available and unmuted,
// and therefore not dismissible (see pillView). No browser storage on either path.

import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, DownloadIcon, XIcon } from "lucide-react";
import { useCallback } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useAutoUpdate, snoozeNotification } from "../store/autoUpdateStore";
import { computePillView, type PillTone } from "./pillView";
import { isRunActive, isRunRestarting, toProblemSignal, toReleaseSignal } from "./stateSignals";

const PILL_STYLES: Record<PillTone, string> = {
  available: "bg-primary/15 text-primary",
  attention: "bg-destructive/12 text-destructive",
};

export function SidebarAutoUpdatePill() {
  const navigate = useNavigate();
  const state = useAutoUpdate();
  // A PURE RENDERER. The driver + mirror sync used to be hosted here on the belief that the pill is
  // always mounted — it is not: the sidebar swaps the whole footer out on `/settings/*`, so both
  // stopped on the very page that starts an update. They live at the app root now
  // (AutoUpdateDriverMount); adding them back here would mean two of everything.

  const view =
    state !== null
      ? computePillView(
          {
            release: toReleaseSignal(state),
            problem: toProblemSignal(state),
            runActive: isRunActive(state),
            runTargetVersion: state.run?.targetVersion ?? null,
            runRestarting: isRunRestarting(state),
          },
          Date.now(),
        )
      : null;

  const openSettings = useCallback(() => {
    void navigate({ to: "/settings/auto-update" });
  }, [navigate]);

  const dismiss = useCallback(() => {
    // Only the notice kinds carry a quiet stamp; `updating` is a status indicator and is never
    // dismissible, so it can never reach this handler.
    if (view === null || (view.kind !== "release" && view.kind !== "problems")) return;
    // One server record per kind — the same stamp the toast writes.
    snoozeNotification(view.kind);
  }, [view]);

  if (view === null) return null;

  return (
    <div
      className={`relative flex h-7 w-full items-center overflow-hidden rounded-lg text-xs font-medium ${PILL_STYLES[view.tone]}`}
      data-testid="auto-update-pill"
      data-kind={view.kind}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={view.description}
              className="relative z-[1] flex h-full flex-1 items-center gap-2 px-2 text-left"
              onClick={openSettings}
            >
              {view.kind === "problems" ? (
                <CircleAlertIcon className="size-3.5" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
              <span className="truncate">{view.title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{view.description}</TooltipPopup>
      </Tooltip>
      {view.dismissible ? (
        <button
          type="button"
          aria-label="Hide the update notification"
          data-testid="auto-update-pill-dismiss"
          className="relative z-[1] mr-1 inline-flex size-5 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
          onClick={dismiss}
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
