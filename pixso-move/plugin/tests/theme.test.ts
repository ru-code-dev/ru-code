import { describe, expect, it } from "vitest";

import {
  asThemeMode,
  asThemeName,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_NAME,
  THEME_NAMES,
} from "../src/ui/theme.ts";

describe("theme coercion", () => {
  it("accepts every known theme name", () => {
    for (const name of THEME_NAMES) {
      expect(asThemeName(name)).toBe(name);
    }
  });

  it("falls back to the default for an unknown theme name", () => {
    expect(asThemeName("nope")).toBe(DEFAULT_THEME_NAME);
  });

  it("accepts the known modes and falls back otherwise", () => {
    expect(asThemeMode("light")).toBe("light");
    expect(asThemeMode("dark")).toBe("dark");
    expect(asThemeMode("system")).toBe("system");
    expect(asThemeMode("bogus")).toBe(DEFAULT_THEME_MODE);
  });
});
