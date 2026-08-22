// ru-code: SW page kit — «<app> не запущен» page (pure HTML string).
// Served by the service worker when a navigation fails (F5 while the server is
// down, or opening the app URL with the daemon stopped). All product literals
// come from @ru-code/branding (#34); every static string is picked by the
// mirrored locale (#35).

import { APP_COMMAND, APP_NAME } from "@ru-code/branding";

import {
  brand,
  button,
  commandCard,
  devDetails,
  emblem,
  esc,
  factsGrid,
  keyValue,
  logBox,
} from "./parts";
import { pick, type SwLocale } from "./strings";

export interface DownPageVm {
  lastVersion: string;
  address: string;
  lastSeenAgo: string;
  /** page locale (default ru) — picks every static string */
  locale?: SwLocale;
  /**
   * True while a MANUAL «Проверить снова» is in flight. The 2.5 s background heartbeat does NOT
   * set it: a page the user may leave open for hours would otherwise flip its only button between
   * «Проверяю…» and «Проверить снова» twice every five seconds, forever, with nothing else on
   * screen changing. The status row already says the server is not responding.
   */
  probing?: boolean;
  /** Real diagnostics, always supplied by the emitting document. */
  diagnostics: {
    lines: Array<{ time: string; tone: "dim" | "ok" | "act" | "warn" | "err"; text: string }>;
    kv: Array<[string, string]>;
  };
}

export function downFragment(vm: DownPageVm): string {
  const locale: SwLocale = vm.locale ?? "ru";

  const howto = commandCard({
    head: pick(locale, `Запустить ${APP_NAME} снова`, `Start ${APP_NAME} again`),
    kicker: pick(locale, "в терминале", "in the terminal"),
    command: APP_COMMAND,
    // The app always daemonizes on start, so the old «хотите, чтобы он работал в фоне?» hint was
    // stale advice. What the user actually needs here is how to STOP it.
    altHtml: pick(
      locale,
      `Чтобы остановить приложение: <code class="rcu-mono">${esc(APP_COMMAND)} stop</code>.`,
      `To stop the app: <code class="rcu-mono">${esc(APP_COMMAND)} stop</code>.`,
    ),
    copyLabel: pick(locale, "Копировать", "Copy"),
  });

  const facts = factsGrid([
    {
      label: pick(locale, "Последняя версия", "Last version"),
      valueHtml: `v${esc(vm.lastVersion)}`,
    },
    { label: pick(locale, "Адрес", "Address"), valueHtml: esc(vm.address), dim: true },
    { label: pick(locale, "Был в сети", "Last seen"), valueHtml: esc(vm.lastSeenAgo), dim: true },
    {
      label: pick(locale, "Статус", "Status"),
      valueHtml: vm.probing
        ? `<span class="rcu-ok-dot">●</span> ${pick(locale, "проверяю…", "checking…")}`
        : `<span class="rcu-err-dot">●</span> ${pick(locale, "не отвечает", "not responding")}`,
    },
  ]);

  // The emitting document supplies these from the live mirror. There used to be canned defaults
  // here for a preview that no longer exists — English-only regardless of locale, a hardcoded
  // "7777 · not listening", and one row short of what the live path shows: a fallback that could
  // only ever have misinformed someone, on the page whose whole purpose is diagnosis.
  const diagnostics = devDetails(
    pick(locale, "Диагностика для разработчиков", "Diagnostics"),
    logBox(vm.diagnostics.lines) + keyValue(vm.diagnostics.kv),
  );

  return `
<div class="rcu-wrap">
  ${brand(pick(locale, "не запущен", "not running"))}
  ${emblem("plug", "err")}
  <div>
    <h1 class="rcu-headline">${pick(locale, `${esc(APP_NAME)} не запущен`, `${esc(APP_NAME)} is not running`)}</h1>
    <p class="rcu-subline">${pick(
      locale,
      "Приложение на этом компьютере сейчас остановлено. Запустите его — и эта страница сама вернёт вас внутрь.",
      "The app on this machine is stopped. Start it and this page will take you back in on its own.",
    )}</p>
  </div>
  ${howto}
  ${facts}
  <div class="rcu-actions">
    ${button(vm.probing ? pick(locale, "Проверяю…", "Checking…") : pick(locale, "Проверить снова", "Check again"), { action: "probe", variant: "primary", slot: "probe-label" })}
  </div>
  ${diagnostics}
</div>`;
}
