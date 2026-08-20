// ru-code: the welcome screen the launcher prints. A bordered, colored box on a
// TTY; plain lines otherwise (piped / captured output). Localized via L() so
// --language / the app locale flows through. Brand name from APP_NAME, the stop
// command from APP_HOME_SLUG. Pure string builders — unit-testable, no IO.

import { APP_HOME_SLUG, APP_NAME } from "@ru-code/branding";
import { L } from "@ru-code/localization";

import { ARROW_OK, gradient, isTty, paint } from "./paint.ts";

/** A banner line in both its plain (width-measuring) and styled forms. */
interface Row {
  readonly plain: string;
  readonly styled: string;
}

interface KeyValue {
  readonly label: string;
  readonly value: string;
  readonly paintValue: (value: string) => string;
}

const asIs = (value: string): string => value;
const stopCommand = `${APP_HOME_SLUG} stop`;
const restartCommand = `${APP_HOME_SLUG} restart`;

/** Left-pad labels to a common width so the values line up in a column. */
const buildKeyValueRows = (entries: ReadonlyArray<KeyValue>): Array<Row> => {
  const labelWidth = Math.max(...entries.map((entry) => entry.label.length));
  return entries.map((entry) => {
    const label = entry.label.padEnd(labelWidth);
    return {
      plain: `${label}  ${entry.value}`,
      styled: `${paint.dim(label)}  ${entry.paintValue(entry.value)}`,
    };
  });
};

const headlineRow = (text: string): Row => ({
  plain: `▸ ${APP_NAME} ${text}`,
  // ru-code: gradient wordmark for the brand name, bold for the rest.
  styled: `${ARROW_OK} ${gradient(APP_NAME)} ${paint.bold(text)}`,
});

const render = (headline: Row, rows: ReadonlyArray<Row>): string => {
  const all = [headline, ...rows];

  if (!isTty) {
    return ["", `  ${headline.plain}`, ...rows.map((row) => `    ${row.plain}`), ""].join("\n");
  }

  const inner = Math.max(...all.map((row) => row.plain.length));
  const border = "─".repeat(inner + 2);
  const wall = paint.dim("│");
  const line = (row: Row): string =>
    `  ${wall} ${row.styled}${" ".repeat(inner - row.plain.length)} ${wall}`;

  return [
    "",
    `  ${paint.dim(`┌${border}┐`)}`,
    ...all.map(line),
    `  ${paint.dim(`└${border}┘`)}`,
    "",
  ].join("\n");
};

const openRow = (url: string): KeyValue => ({
  label: L("Open:", "Открыть:"),
  value: url,
  paintValue: (v) => paint.bold(paint.cyan(v)),
});
const versionRow = (version: string): KeyValue => ({
  label: L("Version:", "Версия:"),
  value: version,
  paintValue: asIs,
});
const uptimeRow = (runningFor: string): KeyValue => ({
  label: L("Uptime:", "Время работы:"),
  value: runningFor,
  paintValue: asIs,
});
const statusRow = (): KeyValue => ({
  label: L("Status:", "Статус:"),
  value: `● ${L("running", "работает")}`,
  paintValue: (v) => paint.green(v),
});
// A function (not a const) so L() resolves at print time against the current
// locale — a module-level const would freeze to the load-time locale.
const stopRow = (): KeyValue => ({
  label: L("Stop:", "Остановить:"),
  value: stopCommand,
  paintValue: (v) => paint.bold(paint.magenta(v)),
});
const restartRow = (): KeyValue => ({
  label: L("Restart:", "Перезапустить:"),
  value: restartCommand,
  paintValue: (v) => paint.bold(paint.magenta(v)),
});

/**
 * A branded one-line notice — `▸ Ru Code <text>` — in the banner's own visual
 * language (green ▸ + gradient wordmark for `ok`, dim for `info`). Plain off-TTY.
 */
export const formatBrandNotice = (kind: "ok" | "info", text: string): string => {
  const arrow = kind === "info" ? paint.dim("▸") : ARROW_OK;
  const body = kind === "info" ? paint.dim(text) : paint.bold(text);
  return `\n  ${arrow} ${gradient(APP_NAME)} ${body}\n`;
};

/** A red error notice — `▸ <message>`. Plain off-TTY. */
export const formatErrorNotice = (message: string): string =>
  `\n  ${paint.red("▸")} ${paint.red(message)}\n`;

export const formatReadyBanner = (params: {
  readonly url: string;
  readonly version: string;
  readonly runningFor: string;
  readonly pid: number;
  readonly logPath: string;
}): string =>
  render(
    headlineRow(L("is running in the background", "работает в фоне")),
    buildKeyValueRows([
      openRow(params.url),
      versionRow(params.version),
      statusRow(),
      uptimeRow(params.runningFor),
      { label: "PID:", value: String(params.pid), paintValue: asIs },
      { label: L("Logs:", "Журнал:"), value: params.logPath, paintValue: asIs },
      stopRow(),
      restartRow(),
    ]),
  );

// ru-code: reuse banner shows the PLAIN origin — the persisted pairing token is
// single-use + 5-min TTL (PairingGrantStore), so it's stale once the app is running.
export const formatAlreadyRunningBanner = (params: {
  readonly url: string;
  readonly version: string;
  readonly runningFor: string;
  readonly pid: number;
}): string =>
  render(
    headlineRow(L("is already running", "уже запущен")),
    buildKeyValueRows([
      openRow(params.url),
      versionRow(params.version),
      statusRow(),
      uptimeRow(params.runningFor),
      { label: "PID:", value: String(params.pid), paintValue: asIs },
      stopRow(),
      restartRow(),
    ]),
  );
