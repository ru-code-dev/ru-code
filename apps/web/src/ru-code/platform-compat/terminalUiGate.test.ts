// ru-code: pins the terminal UI visibility decision. Written relative to
// TERMINAL_UI_VISIBILITY so flipping the constant for a field test keeps the suite honest:
// "all" shows everywhere, "hidden" hides everywhere (the preview/testing mode), and
// "hide-windows" gates ONLY Windows servers while unknown/not-yet-loaded descriptors stay
// enabled (no flicker while the descriptor loads).

import { TERMINAL_UI_VISIBILITY } from "@ru-code/platform-compat/constants";
import { describe, expect, it } from "vite-plus/test";

import { isTerminalUiEnabledForOs } from "./terminalUiGate";

describe("isTerminalUiEnabledForOs", () => {
  it("windows servers follow the visibility constant", () => {
    expect(isTerminalUiEnabledForOs("windows")).toBe(TERMINAL_UI_VISIBILITY === "all");
  });

  it("darwin/linux/unknown are hidden only in the everywhere-hidden mode", () => {
    const expected = TERMINAL_UI_VISIBILITY !== "hidden";
    expect(isTerminalUiEnabledForOs("darwin")).toBe(expected);
    expect(isTerminalUiEnabledForOs("linux")).toBe(expected);
    expect(isTerminalUiEnabledForOs("unknown")).toBe(expected);
  });

  it("descriptor not loaded yet (undefined) never counts as Windows", () => {
    expect(isTerminalUiEnabledForOs(undefined)).toBe(TERMINAL_UI_VISIBILITY !== "hidden");
  });
});
