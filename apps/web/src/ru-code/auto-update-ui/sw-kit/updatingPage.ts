// ru-code: SW page kit — «<app> обновляется» page (pure HTML string).
// Rendered while the server restarts into the new version. Product literals come from branding
// (#34); every static string is picked by the mirrored locale (#35).
//
// SCOPE: this page exists for the blind window — the seconds when the server is being replaced and
// a navigation cannot be answered by anything else. It is served by `swUpdatingDocument`, which is
// reached only from the service worker's navigate fallback, and it therefore renders exactly ONE
// situation: the restart is under way. The success and failure screens live in that same document
// as sibling sections which `pageScript.ts` reveals once /healthz answers — they are not phases of
// this fragment.
//
// It used to accept a full run view-model with `failed` / `done` phases, an error panel and a
// `retry` button. None of it could ever render: the one caller passes `{phase:"restart", pct:0,
// error:null}` and the script has no `retry` handler. Dead branches on a page whose whole job is to
// be truthful while nothing else can answer are worse than absent ones — one of them interpolated a
// server-supplied string into HTML unescaped, which stayed harmless only because it was
// unreachable.

import { APP_NAME } from "@ru-code/branding";

import type { RunLogLine, RunPhase } from "../model";
import { brand, devDetails, emblem, esc, logBox } from "./parts";
import { pick, type SwLocale } from "./strings";

export interface UpdatingPageVm {
  targetVersion: string;
  /** The phase the run had reached when the server went away. Today always `restart`. */
  phase: RunPhase;
  /** Download percent 0..100 — drives the bar while the phase is `download`. */
  pct: number;
  log: RunLogLine[];
  /** Page locale (default ru). */
  locale?: SwLocale;
}

/**
 * The four steps of a real run, in order. Deliberately the SAME four the in-app `PhaseTimeline`
 * renders: the user crosses from that strip to this one mid-update, and a strip that grows a fifth
 * dot exactly at the crossing reads as two unrelated screens rather than one sequence. There used
 * to be a «Подключение» step here with no in-app counterpart — and nothing ever reached it, since
 * a page that gets its answer from /healthz reveals the success section instead of advancing.
 */
function steps(locale: SwLocale): Array<{ key: RunPhase; label: string }> {
  return [
    { key: "download", label: pick(locale, "Скачивание", "Download") },
    { key: "verify", label: pick(locale, "Проверка", "Verify") },
    { key: "install", label: pick(locale, "Установка", "Install") },
    { key: "restart", label: pick(locale, "Перезапуск", "Restart") },
  ];
}

const PHASE_ORDER: RunPhase[] = ["download", "verify", "install", "restart"];

/** The bar: the download owns the first 40 %, each later step a fixed slice of the rest. */
function overallPct(vm: UpdatingPageVm): number {
  const index = PHASE_ORDER.indexOf(vm.phase);
  if (index <= 0) return vm.pct * 0.4;
  return Math.min(100, 40 + index * 15);
}

function stepState(step: RunPhase, vm: UpdatingPageVm): "done" | "now" | "todo" {
  const current = PHASE_ORDER.indexOf(vm.phase);
  const own = PHASE_ORDER.indexOf(step);
  if (own < current) return "done";
  if (own === current) return "now";
  return "todo";
}

export function updatingFragment(vm: UpdatingPageVm): string {
  const locale: SwLocale = vm.locale ?? "ru";

  const headline = pick(locale, `${APP_NAME} обновляется`, `${APP_NAME} is updating`);

  // The only unescaped markup here is our own <b>; the value inside it IS escaped.
  const subline = pick(
    locale,
    `Устанавливаю <b>v${esc(vm.targetVersion)}</b> — обычно это занимает меньше минуты. Страница сама вернёт вас в приложение, ничего делать не нужно.`,
    `Installing <b>v${esc(vm.targetVersion)}</b> — this usually takes under a minute. The page will return you to the app on its own, nothing to do.`,
  );

  const track = `
<div class="rcu-track">
  <div class="rcu-bar"><i style="width:${Math.round(overallPct(vm))}%"></i></div>
  <div class="rcu-flow">
    ${steps(locale)
      .map(
        (step) =>
          `<div class="rcu-step" data-state="${stepState(step.key, vm)}"><span class="rcu-dot"></span>${esc(step.label)}</div>`,
      )
      .join("")}
  </div>
</div>`;

  const journal = devDetails(
    pick(locale, "Что происходит", "What's happening"),
    logBox(vm.log.map((line) => ({ time: line.time, tone: line.tone, text: line.text }))),
  );

  // F18: while the update is LIVE this page offers no way out — the server it would navigate to is
  // the one being replaced. The document's terminal sections carry the actions.
  return `
<div class="rcu-wrap">
  ${brand(pick(locale, "обновление…", "updating…"))}
  ${emblem("up", "spin")}
  <div>
    <h1 class="rcu-headline">${esc(headline)}</h1>
    <p class="rcu-subline">${subline}</p>
  </div>
  ${track}
  ${journal}
</div>`;
}
