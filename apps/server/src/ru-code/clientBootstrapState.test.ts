import { describe, expect, it } from "vite-plus/test";

import {
  appearanceFromSettings,
  getBootstrapAppearance,
  setBootstrapAppearance,
} from "./clientBootstrapState.ts";

describe("clientBootstrapState", () => {
  it("defaults mirror the ServerSettings appearance defaults", () => {
    expect(getBootstrapAppearance()).toEqual({
      themePreference: "",
      appearanceMode: "system",
      followSystem: true,
      themeHalves: "",
      customThemes: "",
    });
  });

  it("round-trips the five appearance values", () => {
    const next = {
      themePreference: "aurora",
      appearanceMode: "dark",
      followSystem: false,
      themeHalves: '{"light":"a","dark":"b"}',
      customThemes: '[{"id":"mine"}]',
    };
    setBootstrapAppearance(next);
    expect(getBootstrapAppearance()).toEqual(next);
  });

  it("maps ServerSettings field names onto the holder shape", () => {
    expect(
      appearanceFromSettings({
        themePreference: "onyx",
        themeAppearanceMode: "light",
        themeFollowSystem: true,
        themeHalves: "",
        customThemes: "",
      }),
    ).toEqual({
      themePreference: "onyx",
      appearanceMode: "light",
      followSystem: true,
      themeHalves: "",
      customThemes: "",
    });
  });
});
