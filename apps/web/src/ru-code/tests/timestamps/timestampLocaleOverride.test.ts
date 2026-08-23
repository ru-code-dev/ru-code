// ru-code: fork-zone pin for C-13-003 — t3's own timestampFormat.test.ts stays byte-HEAD (RULES
// 8.1: never add a case to an upstream port test). This file pins the fork's one-line seam inside
// getTimestampFormatter (apps/web/src/timestampFormat.ts) instead: a Russian app language must not
// print an American clock, even on a host machine reporting an English locale. Only the wall-clock
// time is overridden; the numeric date keeps following the host tag (#7081's date/time agreement
// is unaffected).
import { describe, expect, it, vi } from "vite-plus/test";

describe("timestampFormat — Russian app-language override (C-13-003)", () => {
  it("overrides the host locale for the wall-clock time when the app language is Russian", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { getSystemLocale: () => "en-US" },
    });
    vi.resetModules();

    try {
      // Re-import BOTH modules inside the same reset epoch, so the locale we set is read by
      // the same `@ru-code/localization` instance `timestampFormat`'s fresh copy resolves —
      // a statically-imported `setLocale` would mutate a DIFFERENT (pre-reset) instance.
      const { setLocale: setLocaleFresh } = await import("@ru-code/localization");
      setLocaleFresh("ru");
      const { formatDayAwareTimestamp: formatInRussian } = await import("../../../timestampFormat");

      const iso = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
        new Date(y, monthIndex, d, h, mi).toISOString();
      const now = new Date(2026, 7, 14, 12, 0).getTime();
      const messageAt = iso(2026, 7, 12, 15, 44);

      expect(formatInRussian(messageAt, "locale", now)).toBe("8/12 15:44");
    } finally {
      vi.resetModules();
      vi.unstubAllGlobals();
    }
  });
});
