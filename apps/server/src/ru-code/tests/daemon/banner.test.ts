// ru-code: the launcher banner is pure string-building, so it's fully testable —
// and it's where the locale-freeze regression once shipped (row builders that were
// module-level consts froze L() to the load-time locale). These tests pin the
// content, the RU/EN localization, the reuse-vs-ready differences, and — as an
// explicit regression guard — that re-rendering after a locale switch re-localizes.
//
// Under the test runner the locale defaults to EN and stdout is not a TTY, so the
// banner emits its plain (escape-free) form — deterministic to assert against.

import { afterEach, describe, expect, it } from "vite-plus/test";

import { APP_HOME_SLUG, APP_NAME } from "@ru-code/branding";
import { setLocale } from "@ru-code/localization";
import {
  formatAlreadyRunningBanner,
  formatBrandNotice,
  formatErrorNotice,
  formatReadyBanner,
} from "@ru-code/daemon/banner";

const READY = {
  url: "http://127.0.0.1:7777/?pair=abc",
  version: "1.2.3",
  runningFor: "3m 5s",
  pid: 4242,
  logPath: "/home/user/.ru-code/daemon.log",
};

const ANSI_ESCAPE = "[";

describe("daemon banner", () => {
  // The suite defaults to EN; any test that switches to RU restores it.
  afterEach(() => setLocale("en"));

  it("ready banner (EN) shows every field and both command lines, no ANSI off-TTY", () => {
    const out = formatReadyBanner(READY);
    expect(out).toContain(`${APP_NAME} is running in the background`);
    expect(out).toContain("Open:");
    expect(out).toContain(READY.url);
    expect(out).toContain("Version:");
    expect(out).toContain(READY.version);
    expect(out).toContain("Status:");
    expect(out).toContain("running");
    expect(out).toContain("Uptime:");
    expect(out).toContain(READY.runningFor);
    expect(out).toContain("PID:");
    expect(out).toContain(String(READY.pid));
    expect(out).toContain("Logs:");
    expect(out).toContain(READY.logPath);
    expect(out).toContain(`${APP_HOME_SLUG} stop`);
    expect(out).toContain(`${APP_HOME_SLUG} restart`);
    expect(out).not.toContain(ANSI_ESCAPE);
  });

  it("ready banner (RU) localizes labels, headline and command lines", () => {
    setLocale("ru");
    const out = formatReadyBanner(READY);
    expect(out).toContain(`${APP_NAME} работает в фоне`);
    expect(out).toContain("Открыть:");
    expect(out).toContain("Версия:");
    expect(out).toContain("Статус:");
    expect(out).toContain("работает");
    expect(out).toContain("Время работы:");
    expect(out).toContain("Журнал:");
    expect(out).toContain("Остановить:");
    expect(out).toContain("Перезапустить:");
    // The command itself is brand-derived, not translated.
    expect(out).toContain(`${APP_HOME_SLUG} stop`);
    // No English labels leaked into the Russian render.
    expect(out).not.toContain("Open:");
    expect(out).not.toContain("Uptime:");
  });

  it("re-rendering after a locale switch re-localizes (locale-freeze regression guard)", () => {
    const en = formatReadyBanner(READY);
    setLocale("ru");
    const ru = formatReadyBanner(READY);
    // Same builder, different locale → different labels. A frozen const would have
    // made both identical (the original bug).
    expect(en).toContain("Open:");
    expect(en).not.toContain("Открыть:");
    expect(ru).toContain("Открыть:");
    expect(ru).not.toContain("Open:");
  });

  it("already-running banner shows the plain origin + commands, but NO Logs row", () => {
    const out = formatAlreadyRunningBanner({
      url: "http://127.0.0.1:7777",
      version: READY.version,
      runningFor: READY.runningFor,
      pid: READY.pid,
    });
    expect(out).toContain(`${APP_NAME} is already running`);
    expect(out).toContain("http://127.0.0.1:7777");
    expect(out).toContain(`${APP_HOME_SLUG} stop`);
    expect(out).toContain(`${APP_HOME_SLUG} restart`);
    // Reuse never spawns → no log file to point at.
    expect(out).not.toContain("Logs:");
  });

  it("already-running banner localizes its headline", () => {
    setLocale("ru");
    const out = formatAlreadyRunningBanner({
      url: "http://127.0.0.1:7777",
      version: READY.version,
      runningFor: READY.runningFor,
      pid: READY.pid,
    });
    expect(out).toContain(`${APP_NAME} уже запущен`);
  });

  it("brand notices carry the wordmark + message; error notice carries the message", () => {
    expect(formatBrandNotice("ok", "all good")).toContain(APP_NAME);
    expect(formatBrandNotice("ok", "all good")).toContain("all good");
    expect(formatBrandNotice("info", "just so you know")).toContain("just so you know");
    expect(formatErrorNotice("something broke")).toContain("something broke");
    // Off-TTY the notices are escape-free too.
    expect(formatBrandNotice("ok", "x")).not.toContain(ANSI_ESCAPE);
    expect(formatErrorNotice("x")).not.toContain(ANSI_ESCAPE);
  });
});
