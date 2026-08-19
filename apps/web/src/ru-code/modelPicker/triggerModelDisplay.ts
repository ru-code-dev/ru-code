// ru-code: the picker-trigger label decision as a pure composite, so
// ProviderModelPicker stays a thin seam. The one non-obvious case: an
// instance serving ZERO models with nothing persisted (fresh stock qwen,
// discovery flag off, last custom model deleted) must read as an honest
// "Default model" — the CLI runs its own defaults then — instead of a
// blank trigger. Any non-empty state keeps upstream behaviour verbatim.
import {
  type ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "../../components/chat/providerIconUtils";

export const DEFAULT_MODEL_TRIGGER_LABEL = "Default model";

/**
 * Which served option the trigger displays. If the current slug belongs to a
 * different instance (for example after a provider switch or disable), prefer
 * the active instance's first option so the trigger icon and label stay in
 * sync instead of showing a stale foreign slug. Zero served options ⇒
 * `undefined`, and `resolveTriggerModelDisplay` decides the label from the
 * raw model string.
 */
export function resolveTriggerModelOption(
  options: ReadonlyArray<ModelEsque>,
  model: string,
): ModelEsque | undefined {
  return options.find((option) => option.slug === model) ?? options[0];
}

export function resolveTriggerModelDisplay(
  selectedModel: ModelEsque | undefined,
  rawModel: string,
): { title: string; label: string } {
  if (selectedModel) {
    return {
      title: getTriggerDisplayModelName(selectedModel),
      label: getTriggerDisplayModelLabel(selectedModel),
    };
  }
  if (rawModel.trim().length === 0) {
    return { title: DEFAULT_MODEL_TRIGGER_LABEL, label: DEFAULT_MODEL_TRIGGER_LABEL };
  }
  return { title: rawModel, label: rawModel };
}
