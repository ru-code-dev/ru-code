// ru-code: SW page kit — the DOCUMENTS the service worker actually serves.
// Composes the existing fragments (updatingPage/downPage — the accepted
// prototype look) with the runtime protocol: mirrored theme vars, the inline
// `window.__RCU__` config and the vanilla page script. The success, manual and
// failure sections are PRE-RENDERED here and hidden; the page script only
// toggles visibility and fills text slots — all markup lives in this kit, none
// in JS. Product literals come from branding (#34); every static string is
// picked by the mirrored locale (#35).

import { APP_COMMAND, APP_NAME, SUPPORT_CHANNEL_URL } from "@ru-code/branding";

import { brand, button, commandCard, emblem, esc, pageDocument } from "./parts";
import { SW_PAGE_CSS } from "./theme";
import { SW_PAGE_SCRIPT } from "./pageScript";
import { downFragment } from "./downPage";
import { updatingFragment } from "./updatingPage";
import { pick, runtimeStrings, toSwLocale, type SwLocale } from "./strings";
import { SW_MSG_UPDATE_CLEAR, themeStyleTag, type SwMirror, type UpdateMarker } from "./runtime";

function timeHms(at: number): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function agoLabel(from: number, now: number, locale: SwLocale): string {
  const minutes = Math.round((now - from) / 60_000);
  if (from === 0) return "—";
  if (minutes <= 1) return pick(locale, "только что", "just now");
  if (minutes < 60) return pick(locale, `${minutes} мин назад`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  return pick(locale, `${hours} ч назад`, `${hours} h ago`);
}

function configScript(config: Record<string, unknown>): string {
  // JSON with `<` escaped so "</script>" can never terminate the tag early.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return `window.__RCU__=${json};`;
}

/** The `__RCU__` config the page script reads: page id, timings, target version,
 *  the app command for clipboard writes (#34) and the runtime string map (#35). */
function pageConfig(
  page: "updating" | "down",
  locale: SwLocale,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    page,
    command: APP_COMMAND,
    clearMsg: SW_MSG_UPDATE_CLEAR,
    strings: runtimeStrings(locale),
    ...extra,
  };
}

// ── updating (blind restart window) ─────────────────────────────────────────

function manualHowto(locale: SwLocale): string {
  const supportHtml =
    SUPPORT_CHANNEL_URL === ""
      ? ""
      : ` ${pick(locale, "Нужна помощь?", "Need help?")} <a class="rcu-back" href="${esc(SUPPORT_CHANNEL_URL)}" target="_blank" rel="noreferrer noopener">${esc(SUPPORT_CHANNEL_URL)}</a>`;
  return commandCard({
    head: pick(locale, "Приложение не вернулось", "The app didn't come back"),
    kicker: pick(locale, "запустите вручную", "run it manually"),
    command: APP_COMMAND,
    altHtml:
      pick(
        locale,
        `Запустите <code class="rcu-mono">${esc(APP_COMMAND)}</code> вручную — страница подхватит сервер, как только он ответит.`,
        `Run <code class="rcu-mono">${esc(APP_COMMAND)}</code> manually — the page will pick the server up as soon as it responds.`,
      ) + supportHtml,
    copyLabel: pick(locale, "Копировать", "Copy"),
  });
}

/** The document served on a failed navigation while a FRESH update marker exists (W15). */
export function swUpdatingDocument(input: {
  readonly marker: UpdateMarker;
  readonly mirror: SwMirror | null;
  readonly now: number;
}): string {
  const { marker, mirror, now } = input;
  const locale = toSwLocale(mirror?.locale);

  const live = updatingFragment({
    targetVersion: marker.targetVersion,
    phase: "restart",
    pct: 0,
    locale,
    log: [
      {
        time: timeHms(marker.startedAt),
        tone: "dim",
        text: pick(
          locale,
          `запрошено обновление ${marker.fromVersion !== "" ? `v${marker.fromVersion} → ` : ""}v${marker.targetVersion}`,
          `update requested ${marker.fromVersion !== "" ? `v${marker.fromVersion} → ` : ""}v${marker.targetVersion}`,
        ),
      },
      {
        time: timeHms(now),
        tone: "act",
        text: pick(
          locale,
          "сервер перезапускается — жду /healthz…",
          "server is restarting — waiting for /healthz…",
        ),
      },
    ],
  });

  const returnLabel = pick(locale, "Вернуться", "Return");
  const success = `
<div class="rcu-wrap">
  ${brand(`v${esc(marker.targetVersion)}`)}
  ${emblem("check", "ok")}
  <div>
    <h1 class="rcu-headline">${pick(locale, "Готово — вы на", "Done — you're on")} <span data-rcu="new-version">v${esc(marker.targetVersion)}</span></h1>
    <p class="rcu-subline">${pick(locale, "Сервер снова в сети. Сейчас вернёмся в приложение.", "The server is back online. Returning to the app now.")}</p>
  </div>
  <div class="rcu-actions">
    <button class="rcu-btn" type="button" data-action="return-now" data-variant="primary">${esc(returnLabel)} (<span data-rcu="countdown">5</span>)</button>
    ${button(pick(locale, "Остаться", "Stay"), { action: "stay", variant: "ghost" })}
  </div>
</div>`;

  const manual = `
<div class="rcu-wrap">
  ${brand(pick(locale, "обновление…", "updating…"))}
  ${emblem("alert", "err")}
  <div>
    <h1 class="rcu-headline">${pick(locale, `${esc(APP_NAME)} пока не вернулся`, `${esc(APP_NAME)} hasn't come back yet`)}</h1>
    <p class="rcu-subline">${pick(
      locale,
      `Обновление до <b>v${esc(marker.targetVersion)}</b> идёт дольше обычного. Возможно, серверу нужна помощь.`,
      `The update to <b>v${esc(marker.targetVersion)}</b> is taking longer than usual. The server may need a hand.`,
    )}</p>
  </div>
  ${manualHowto(locale)}
  <div class="rcu-actions">
    ${button(pick(locale, "Проверить снова", "Check again"), { action: "probe", variant: "primary", slot: "probe-label" })}
  </div>
</div>`;

  const failed = `
<div class="rcu-wrap">
  ${brand(pick(locale, "обновление…", "updating…"))}
  ${emblem("alert", "err")}
  <div>
    <h1 class="rcu-headline">${pick(locale, "Обновление не удалось", "Update failed")}</h1>
    <p class="rcu-subline">${pick(
      locale,
      "Сервер вернулся на прежней версии. Причина:",
      "The server came back on the previous version. Reason:",
    )}</p>
  </div>
  <div class="rcu-error">
    <b class="rcu-mono" data-rcu="fail-reason">—</b>
  </div>
  <div class="rcu-actions">
    ${button(pick(locale, "Открыть настройки", "Open settings"), { action: "back", variant: "primary" })}
  </div>
</div>`;

  const body = `
<div data-testid="sw-updating-page">
<div data-rcu-section="live">${live}<div class="rcu-foot" data-rcu="elapsed"></div></div>
<div data-rcu-section="success" hidden>${success}</div>
<div data-rcu-section="manual" hidden>${manual}</div>
<div data-rcu-section="failed" hidden>${failed}</div>
</div>`;

  return pageDocument(
    pick(locale, `${APP_NAME} — обновление`, `${APP_NAME} — updating`),
    SW_PAGE_CSS,
    body,
    {
      lang: locale,
      headHtml: themeStyleTag(mirror),
      script:
        configScript(
          pageConfig("updating", locale, {
            startedAt: marker.startedAt,
            targetVersion: marker.targetVersion,
          }),
        ) + SW_PAGE_SCRIPT,
    },
  );
}

// ── down (no update in flight) ───────────────────────────────────────────────

/** The document served on a failed navigation with no fresh marker. */
export function swDownDocument(input: {
  readonly mirror: SwMirror | null;
  readonly now: number;
}): string {
  const { mirror, now } = input;
  const locale = toSwLocale(mirror?.locale);
  const fragment = downFragment({
    lastVersion: mirror?.version ?? "—",
    address: mirror !== null && mirror.address !== "" ? mirror.address : "—",
    lastSeenAgo: mirror !== null ? agoLabel(mirror.updatedAt, now, locale) : "—",
    locale,
    probing: false,
    diagnostics: {
      lines: [
        {
          time: timeHms(now),
          tone: "warn",
          text: pick(locale, "GET /healthz — сервер не отвечает", "GET /healthz — no response"),
        },
        {
          time: timeHms(now),
          tone: "act",
          text: pick(locale, "повторная проверка каждые 2.5 с…", "re-checking every 2.5 s…"),
        },
      ],
      kv: [
        [
          "pid",
          mirror?.pid !== null && mirror?.pid !== undefined
            ? String(mirror.pid)
            : pick(locale, "— (процесс не найден)", "— (process not found)"),
        ],
        [
          pick(locale, "порт", "port"),
          mirror?.port !== null && mirror?.port !== undefined
            ? `${mirror.port} · ${pick(locale, "не слушает", "not listening")}`
            : "—",
        ],
        [
          pick(locale, "установка", "install"),
          mirror !== null && mirror.installDir !== "" ? mirror.installDir : "—",
        ],
        [pick(locale, "перезапуск", "restart"), `${APP_COMMAND} restart`],
      ],
    },
  });

  return pageDocument(
    pick(locale, `${APP_NAME} — не запущен`, `${APP_NAME} — not running`),
    SW_PAGE_CSS,
    `<div data-testid="sw-down-page" data-rcu-section="live">${fragment}</div>`,
    {
      lang: locale,
      headHtml: themeStyleTag(mirror),
      script: configScript(pageConfig("down", locale)) + SW_PAGE_SCRIPT,
    },
  );
}
