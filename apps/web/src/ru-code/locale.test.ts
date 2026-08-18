import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readInjectedLocale } from "./locale";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readInjectedLocale", () => {
  it("reads the server-stamped window.__RU_LOCALE__", () => {
    vi.stubGlobal("window", { __RU_LOCALE__: "ru" });
    expect(readInjectedLocale()).toBe("ru");
  });

  it("falls back to the module locale for a missing/invalid global", () => {
    // Under vitest the module default locale is English (EN-identity).
    vi.stubGlobal("window", { __RU_LOCALE__: "xx" });
    expect(readInjectedLocale()).toBe("en");
  });
});
