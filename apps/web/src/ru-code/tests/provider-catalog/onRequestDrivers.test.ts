// ru-code: the "On request" display cards for this build's disabled drivers
// (see onRequestDrivers.ts). Pins: the set mirrors exactly what was disabled,
// the caption is the dict-localized literal, and no value collides with a
// selectable or Coming-Soon card (they all share one RadioGroup).
import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS } from "../../../components/settings/providerDriverMeta";
import {
  ON_REQUEST_BADGE_LABEL,
  ON_REQUEST_DRIVER_OPTIONS,
} from "../../provider-catalog/onRequestDrivers";

describe("onRequestDrivers", () => {
  it("lists exactly the disabled upstream drivers, in catalog order", () => {
    expect(ON_REQUEST_DRIVER_OPTIONS.map((option) => option.value)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
    ]);
    expect(ON_REQUEST_DRIVER_OPTIONS.map((option) => option.label)).toEqual([
      "Codex",
      "Claude",
      "Cursor",
      "Grok",
    ]);
    for (const option of ON_REQUEST_DRIVER_OPTIONS) {
      expect(typeof option.icon).toBe("function");
    }
  });

  it("the caption is the localizable literal", () => {
    expect(ON_REQUEST_BADGE_LABEL).toBe("On request");
  });

  it("never collides with a SELECTABLE driver card (shared RadioGroup values)", () => {
    const selectableValues = new Set(DRIVER_OPTIONS.map((option) => option.value));
    for (const option of ON_REQUEST_DRIVER_OPTIONS) {
      expect(selectableValues.has(option.value)).toBe(false);
    }
  });
});
