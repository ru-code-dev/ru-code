// ru-code: the composer mode-control catalogs + change guard. CompactComposerControlsMenu
// renders its runtime-access radio and interaction (plan) radio straight from these, so
// locking the option SET, labels, full-access gating, and the no-op change guard here
// guarantees the wired behaviour (which modes exist / what they're called / when full
// access is offered / that re-picking the current value does nothing), not a fragment.
import { describe, expect, it } from "vite-plus/test";

import {
  INTERACTION_MODE_OPTIONS,
  RUNTIME_MODE_OPTIONS,
  resolveRuntimeModeOptions,
  shouldApplyModeControlChange,
} from "../../composer/modeControls";

describe("runtime-access mode catalog", () => {
  it("exposes the three modes, in permissiveness order, with labels + descriptions", () => {
    // Both composer variants render from THIS catalog (the wide footer select
    // additionally shows the description) — one source, no drift.
    expect(RUNTIME_MODE_OPTIONS).toEqual([
      {
        value: "approval-required",
        label: "Supervised",
        description: "Ask before commands and file changes.",
      },
      {
        // Round-5: the label dropped "edits" so the footer trigger stays
        // narrow; the description keeps the full explanation.
        value: "auto-accept-edits",
        label: "Auto-accept",
        description: "Auto-approve edits, ask before other actions.",
      },
      {
        value: "full-access",
        label: "Full access",
        description: "Allow commands and edits without prompts.",
      },
    ]);
  });

  it("offers full-access when the provider allows it (nothing disabled)", () => {
    const options = resolveRuntimeModeOptions({ fullAccessDisabled: false });
    expect(options.map((o) => o.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    expect(options.every((o) => o.disabled === false)).toBe(true);
  });

  it("locks ONLY full-access for a provider that forbids it (other modes stay live)", () => {
    const options = resolveRuntimeModeOptions({ fullAccessDisabled: true });
    const disabledValues = options.filter((o) => o.disabled).map((o) => o.value);
    expect(disabledValues).toEqual(["full-access"]);
  });
});

describe("interaction (plan) mode catalog — plan toggle reflects interactionMode", () => {
  it("has exactly the chat/plan pair with their labels", () => {
    expect(INTERACTION_MODE_OPTIONS).toEqual([
      { value: "default", label: "Chat" },
      { value: "plan", label: "Plan" },
    ]);
  });

  it("the option matching a given interactionMode is the selected/active one", () => {
    // The radio's value === interactionMode, so "plan" activates Plan and
    // "default" activates Chat — the plan toggle's on/off state.
    const labelFor = (mode: "default" | "plan") =>
      INTERACTION_MODE_OPTIONS.find((o) => o.value === mode)?.label;
    expect(labelFor("plan")).toBe("Plan");
    expect(labelFor("default")).toBe("Chat");
  });
});

describe("shouldApplyModeControlChange — current-value resolution / no-op guard", () => {
  it("applies a real change to a different value", () => {
    expect(shouldApplyModeControlChange("full-access", "approval-required")).toBe(true);
    expect(shouldApplyModeControlChange("plan", "default")).toBe(true);
  });

  it("ignores re-picking the already-selected value", () => {
    expect(shouldApplyModeControlChange("plan", "plan")).toBe(false);
  });

  it("ignores an empty / null deselect payload", () => {
    expect(shouldApplyModeControlChange("", "default")).toBe(false);
    expect(shouldApplyModeControlChange(null, "default")).toBe(false);
    expect(shouldApplyModeControlChange(undefined, "default")).toBe(false);
  });
});
