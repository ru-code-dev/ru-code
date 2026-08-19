// ru-code: the picker-trigger label decision — the whole composite the
// ProviderModelPicker seam renders. The load-bearing case: an instance with
// ZERO served models and nothing persisted must read "Default model"
// (the CLI runs its own defaults), and adding/removing a model must flip the
// label back and forth through the same rule.
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MODEL_TRIGGER_LABEL,
  resolveTriggerModelDisplay,
  resolveTriggerModelOption,
} from "../../modelPicker/triggerModelDisplay";

const option = (slug: string, name: string, shortName?: string) => ({
  slug,
  name,
  isCustom: false,
  ...(shortName ? { shortName } : {}),
});

describe("resolveTriggerModelDisplay", () => {
  it("selected option keeps upstream display behaviour (shortName preferred for both)", () => {
    const { title, label } = resolveTriggerModelDisplay(
      option("team/alpha", "Team Alpha", "🅰 Alpha"),
      "team/alpha",
    );
    // Upstream getTriggerDisplayModelName prefers shortName for the trigger.
    expect(title).toBe("🅰 Alpha");
    expect(label).toBe("🅰 Alpha");
  });

  it("selected option without shortName shows its name", () => {
    const { title, label } = resolveTriggerModelDisplay(
      option("team/alpha", "Team Alpha"),
      "team/alpha",
    );
    expect(title).toBe("Team Alpha");
    expect(label).toBe("Team Alpha");
  });

  it('no option + empty model ⇒ "Default model" (CLI-defaults mode)', () => {
    const { title, label } = resolveTriggerModelDisplay(undefined, "");
    expect(title).toBe(DEFAULT_MODEL_TRIGGER_LABEL);
    expect(label).toBe(DEFAULT_MODEL_TRIGGER_LABEL);
  });

  it("whitespace-only model counts as empty", () => {
    expect(resolveTriggerModelDisplay(undefined, "   ").label).toBe(DEFAULT_MODEL_TRIGGER_LABEL);
  });

  it("no option but a NON-empty raw model falls back to the raw slug (upstream behaviour)", () => {
    const { title, label } = resolveTriggerModelDisplay(undefined, "typed/custom-model");
    expect(title).toBe("typed/custom-model");
    expect(label).toBe("typed/custom-model");
  });

  it("adding a model exits the default-label mode (first served becomes the display)", () => {
    // The picker resolves selectedModel = options[0] when the persisted slug
    // is empty/foreign — so the moment ONE model exists, the label is real.
    const firstServed = option("my/custom-64k", "my/custom-64k");
    expect(resolveTriggerModelDisplay(firstServed, "").label).not.toBe(DEFAULT_MODEL_TRIGGER_LABEL);
  });
});

describe("resolveTriggerModelOption — which served option the trigger displays", () => {
  const alpha = option("team/alpha", "Team Alpha");
  const beta = option("team/beta", "Team Beta");

  it("persisted model is served ⇒ exactly that option", () => {
    expect(resolveTriggerModelOption([alpha, beta], "team/beta")).toBe(beta);
  });

  it("persisted model NOT served ⇒ silently falls back to the FIRST option", () => {
    // The trigger relies on this so a stale foreign slug never shows.
    expect(resolveTriggerModelOption([alpha, beta], "other/gone")).toBe(alpha);
  });

  it("zero options ⇒ undefined, regardless of the persisted slug", () => {
    expect(resolveTriggerModelOption([], "")).toBeUndefined();
    expect(resolveTriggerModelOption([], "team/alpha")).toBeUndefined();
  });

  it('zero options + empty model ⇒ the REAL pair yields "Default model"', () => {
    const selected = resolveTriggerModelOption([], "");
    const { title, label } = resolveTriggerModelDisplay(selected, "");
    expect(title).toBe(DEFAULT_MODEL_TRIGGER_LABEL);
    expect(label).toBe(DEFAULT_MODEL_TRIGGER_LABEL);
  });
});
