import { describe, expect, it } from "vitest";

import {
  DEFAULT_SERVER_URL,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_NAME,
  parseSettings,
} from "../src/code/settings.ts";

const defaults = {
  serverUrl: DEFAULT_SERVER_URL,
  designerId: "",
  themeName: DEFAULT_THEME_NAME,
  themeMode: DEFAULT_THEME_MODE,
};

describe("parseSettings", () => {
  it("applies defaults for missing values", () => {
    expect(parseSettings(undefined)).toEqual(defaults);
  });

  it("keeps stored values when complete", () => {
    expect(
      parseSettings({
        serverUrl: "https://x.dev",
        designerId: "dz_1",
        themeName: "onyx",
        themeMode: "dark",
      }),
    ).toEqual({
      serverUrl: "https://x.dev",
      designerId: "dz_1",
      themeName: "onyx",
      themeMode: "dark",
    });
  });

  it("fills only the missing parts of partial input", () => {
    expect(parseSettings({ designerId: "dz_2" })).toEqual({ ...defaults, designerId: "dz_2" });
  });

  it("ignores garbage shapes and non-string fields", () => {
    expect(parseSettings(42)).toEqual(defaults);
    expect(parseSettings({ serverUrl: 5, designerId: {}, themeName: 1, themeMode: [] })).toEqual(
      defaults,
    );
  });
});
