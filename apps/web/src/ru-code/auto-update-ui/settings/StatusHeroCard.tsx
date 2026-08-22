// ru-code: auto-update settings — the status hero card. ONE card carries every hero
// state: never-checked / up-to-date / checking / available / running / apply-failed /
// attention, and always ends with the quick-facts strip.
//
// The press never leaves this page (F13/F14): pressing «Установить» starts the
// server-owned run and the card itself becomes the run view — download %, verify,
// restart. A refusal (nothing newer, node too old, an install that cannot write) and a
// failed run both render INLINE here with «Повторить». No toast, no separate page: the
// user pressed a button on this card, so this card answers.
import {
  ArrowUpCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  RefreshCwIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { APP_NAME } from "@ru-code/branding";

import { anySourceCheckable, sourcesSummary } from "../model";
import { checkNow, install, retryRun, useAutoUpdate } from "../store/autoUpdateStore";
import { Badge } from "../ui-kit/badge";
import { Button } from "../ui-kit/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui-kit/collapsible";
import { Callout } from "../ui-kit/custom/Callout";
import { PhaseTimeline } from "../ui-kit/custom/PhaseTimeline";
import { ProgressBar } from "../ui-kit/custom/ProgressBar";
import { StatusHalo, type HaloTone } from "../ui-kit/custom/StatusHalo";
import { useRelativeTimeTick } from "../ui-kit/layout";
import { TerminalBox } from "../ui-kit/custom/TerminalBox";
import { Spinner } from "../ui-kit/spinner";

function FactChip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
        {label}
      </span>
      <span className="truncate font-mono text-[11.5px] font-medium text-foreground/85">
        {value}
      </span>
    </div>
  );
}

export function StatusHeroCard({
  onConfigureSources,
  onShowReleaseNotes,
}: {
  onConfigureSources: () => void;
  onShowReleaseNotes: () => void;
}) {
  const state = useAutoUpdate();
  // The restart counter must climb while the server is DOWN — i.e. while no snapshot arrives — so
  // the card carries its own second hand instead of leaning on the wire's shared tick.
  const nowMs = useRelativeTimeTick(1_000);
  if (state === null) return null;

  const restartElapsedSec =
    state.run?.restartedAtMs == null
      ? null
      : Math.max(0, Math.round((nowMs - state.run.restartedAtMs) / 1000));

  const { status } = state;
  // #G33: "can a check reach anything", NOT "did the last check succeed". A fresh install has
  // never checked, so the old `anySourceWorks` gate disabled the very button that would fix that.
  const checkable = anySourceCheckable(state);
  // #24: no check/install CTA fires while a check is in flight or a run is LIVE. A run that already
  // failed is terminal — counting it as "busy" left every button on this card permanently disabled,
  // with no way out but a restart (and the run is server state, so F5 changed nothing).
  const runLive = state.run !== null && state.run.phase !== "failed";
  // The press-lock closes the window the server cannot: `install` re-resolves every source before
  // it creates a run, so between the click and that first `run !== null` snapshot the state still
  // reads "idle" and the button would sit enabled and unchanged — a press that looks ignored.
  // Every one of these is a SERVER fact delivered by the state stream — nothing here is derived
  // from the click, so nothing needs a timer to undo it. `pressInFlight` covers the gap between the
  // press and a run existing (the install re-resolves both sources first).
  const pressPending = state.pressInFlight;
  const busy = state.checking || runLive || pressPending;
  // An installation that cannot apply updates says so instead of offering a press that dies.
  const blocked = state.applyBlocked;

  let tone: HaloTone = "muted";
  let pulse = false;
  let icon: ReactNode = <SettingsIcon />;
  let lead: ReactNode = null;
  let meta: ReactNode = null;
  let cta: ReactNode = null;
  let extra: ReactNode = null;

  // The re-check, rendered by every phase where the user could otherwise be stuck: a hero pinned
  // to a release whose host has since died had NO way to re-resolve, because a per-source probe
  // deliberately never touches the release verdict (transitions.applyProbeResult).
  const checkButton = (
    <Button
      data-testid="auto-update-check"
      disabled={!checkable || busy}
      onClick={checkNow}
      variant="outline"
    >
      <RefreshCwIcon />
      Check now
    </Button>
  );

  switch (status.phase) {
    case "never-checked":
      tone = "muted";
      icon = <RefreshCwIcon />;
      lead = "No checks yet";
      meta = (
        <>
          {`${APP_NAME} has not checked for updates yet. You are on `}
          <b className="font-mono font-semibold text-foreground">v{state.currentVersion}</b>.
        </>
      );
      cta = checkButton;
      break;

    case "up-to-date":
      tone = "success";
      icon = <CheckIcon />;
      lead = "You have the latest version";
      meta = (
        <>
          Installed{" "}
          <b className="font-mono font-semibold text-foreground">v{state.currentVersion}</b> —
          nothing newer exists. Last check {status.lastCheckedAgo}.
        </>
      );
      cta = checkButton;
      break;

    case "checking":
      tone = "primary";
      pulse = true;
      icon = <Spinner className="size-7" />;
      lead = "Checking for updates…";
      meta = <>Polling the enabled sources: {sourcesSummary(state)}.</>;
      cta = (
        <Button disabled variant="outline">
          <Spinner />
          Checking…
        </Button>
      );
      break;

    case "available": {
      const release = status.release;
      tone = "primary";
      icon = <ArrowUpCircleIcon />;
      lead = (
        <span className="flex items-center gap-2">
          Available version <span className="font-mono">v{release.version}</span>
          <Badge size="sm" variant="info">
            new release
          </Badge>
        </span>
      );
      meta = (
        <>
          Released {release.releasedAgo} · {release.sizeMb} MB · you currently have{" "}
          <b className="font-mono font-semibold text-foreground">v{state.currentVersion}</b>. The
          update will download, pass an integrity check, and apply after your confirmation.
        </>
      );
      cta = (
        <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
          <Button
            data-testid="auto-update-install"
            data-pending={pressPending ? "true" : "false"}
            disabled={busy || blocked !== null}
            onClick={install}
          >
            {pressPending && !runLive ? (
              <>
                <Spinner />
                Starting…
              </>
            ) : (
              <>
                <SparklesIcon />
                Update to v{release.version}
              </>
            )}
          </Button>
          {checkButton}
          <Button onClick={onShowReleaseNotes} size="xs" variant="ghost">
            What's new ↓
          </Button>
        </div>
      );
      break;
    }

    // The run IS this card now: the same block the user pressed in reports the progress — INCLUDING
    // the restart, which the tab rides out here rather than handing the screen to the service
    // worker (see notify/restartWait.ts). While the server is down the WS is silent but the shared
    // time tick is not, so the elapsed seconds keep climbing: an honest «Перезапуск… 4 с» instead
    // of a spinner that cannot say how long it has been spinning.
    case "running": {
      const run = status.run;
      tone = "primary";
      pulse = true;
      icon = <Spinner className="size-7" />;
      lead =
        run.phase === "restart"
          ? `Restarting on the new version… ${restartElapsedSec ?? 0} s`
          : `Updating to v${run.targetVersion}…`;
      meta =
        run.phase === "restart" ? (
          <>
            {`Installed v${run.targetVersion}. Waiting for it to answer — this page returns to it by itself.`}
          </>
        ) : (
          <>
            {run.phaseLabel}
            {run.phase === "download" ? ` · ${run.pct}%` : ""}. The app will restart on its own when
            the new version is in place.
          </>
        );
      // The bar alone only says "something is happening". The timeline says WHICH step of four,
      // and it is the same strip the SW-served page shows once the server goes down — so the
      // handover reads as one continuous sequence rather than two unrelated screens.
      extra = (
        <div
          className="space-y-3"
          data-elapsed={restartElapsedSec ?? ""}
          data-phase={run.phase}
          data-testid="auto-update-run"
        >
          <ProgressBar value={run.phase === "download" ? run.pct : 100} />
          <PhaseTimeline phase={run.phase} />
        </div>
      );
      break;
    }

    // A run that ENDED in failure. Everything the wire already carried and the old `running`
    // branch threw away: the reason, the technical evidence, the journal, and a way out.
    case "run-failed": {
      const run = status.run;
      tone = "destructive";
      icon = <CircleAlertIcon />;
      lead = (
        <span className="flex items-center gap-2">
          Update to <span className="font-mono">v{run.targetVersion}</span> did not complete
        </span>
      );
      meta = (
        <>
          {run.error?.title ?? "The update failed."} {run.error?.hint ?? ""}
        </>
      );
      cta = (
        <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
          <Button
            data-testid="auto-update-retry"
            // A blocked installation refuses EVERY press for the same unfixable reason, so an
            // enabled retry here can only ever re-fail. Same gate as the main install button.
            disabled={busy || blocked !== null}
            onClick={retryRun}
            variant="outline"
          >
            <RefreshCwIcon />
            Retry
          </Button>
          {checkButton}
        </div>
      );
      extra = (
        <div className="space-y-3" data-phase={run.phase} data-testid="auto-update-run-failed">
          {run.error !== null && run.error.detail.length > 0 ? (
            <Callout tone="warning">
              <span className="font-mono text-[11.5px]">{run.error.detail}</span>
            </Callout>
          ) : null}
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRightIcon className="size-4 transition-transform duration-200 group-data-panel-open:rotate-90" />
              What happened
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <TerminalBox
                className="mt-2"
                lines={run.log.map((line) => ({
                  time: line.time,
                  tone: line.tone,
                  text: line.text,
                }))}
              />
            </CollapsiblePanel>
          </Collapsible>
        </div>
      );
      break;
    }

    case "apply-failed": {
      const lastApply = status.lastApply;
      tone = "destructive";
      icon = <CircleAlertIcon />;
      lead = (
        <span className="flex items-center gap-2">
          Update to <span className="font-mono">v{lastApply.targetVersion}</span> did not complete
        </span>
      );
      meta = <>{lastApply.reason ?? "The update failed."}</>;
      cta = (
        <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
          <Button
            data-testid="auto-update-retry"
            // A blocked installation refuses EVERY press for the same unfixable reason, so an
            // enabled retry here can only ever re-fail. Same gate as the main install button.
            disabled={busy || blocked !== null}
            onClick={install}
            variant="outline"
          >
            <RefreshCwIcon />
            Retry
          </Button>
          {checkButton}
        </div>
      );
      if (lastApply.reasonRaw !== null) {
        extra = (
          <Callout className="mt-4" tone="warning">
            <span className="font-mono text-[11.5px]">{lastApply.reasonRaw}</span>
          </Callout>
        );
      }
      break;
    }

    case "attention": {
      const attention = status.attention;
      tone = "warning";
      icon = <SettingsIcon />;
      lead = attention.title;
      meta = <>{attention.message}</>;
      cta = (
        <Button onClick={onConfigureSources} variant="outline">
          <SettingsIcon />
          Configure sources
        </Button>
      );
      break;
    }
  }

  // A refused press outranks the phase's own `extra`: it is the answer to the last thing the user
  // did, it names the reason, and it offers the fix right where the button was pressed. WHICH fix
  // follows the cause — re-pressing «Установить» cannot help when nothing answered the check.
  if (state.pressRefusal !== null && status.phase !== "running") {
    const refusal = state.pressRefusal;
    extra = (
      <Callout className="mt-4" data-testid="auto-update-refusal" tone="warning">
        <div className="flex flex-col gap-2" data-code={refusal.code}>
          <span>{refusal.sentence}</span>
          {refusal.raw !== null ? (
            <span className="font-mono text-[11.5px] opacity-80">{refusal.raw}</span>
          ) : null}
          <div>
            {refusal.action === "check" ? (
              <Button
                data-testid="auto-update-refusal-check"
                disabled={!checkable || busy}
                onClick={checkNow}
                size="xs"
                variant="outline"
              >
                <RefreshCwIcon />
                Check now
              </Button>
            ) : (
              <Button
                data-testid="auto-update-refusal-retry"
                disabled={busy || blocked !== null}
                onClick={install}
                size="xs"
                variant="outline"
              >
                <RefreshCwIcon />
                Try again
              </Button>
            )}
          </div>
        </div>
      </Callout>
    );
  } else if (blocked !== null && status.phase !== "running") {
    extra = (
      <Callout className="mt-4" data-testid="auto-update-blocked" tone="warning">
        {blocked.note}
      </Callout>
    );
  }

  return (
    <section
      className="relative overflow-visible rounded-2xl border bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:shadow-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"
      data-phase={status.phase}
      data-version={state.currentVersion}
      data-testid="auto-update-hero"
    >
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5">
        <StatusHalo pulse={pulse} tone={tone}>
          {icon}
        </StatusHalo>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{lead}</h2>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {meta}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">{cta}</div>
      </div>
      {extra ? <div className="px-5 pb-4">{extra}</div> : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-border/60 px-5 py-2.5">
        <FactChip label="Version" value={`v${state.currentVersion}`} />
        <FactChip label="Sources" value={sourcesSummary(state)} />
        <FactChip label="Next check" value={state.nextCheckIn ?? "off"} />
      </div>
    </section>
  );
}
