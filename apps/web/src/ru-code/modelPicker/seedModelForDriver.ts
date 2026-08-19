// ru-code: the ONE terminal fallback for "which model do we seed/persist when
// nothing better is known". Providers with a registered default keep it;
// a provider absent from the map (qwen, by design) seeds "" = "not selected" —
// the CLI-defaults mode. The upstream chain ended in the hardcoded
// DEFAULT_MODEL ("gpt-5.4"), which resurfaced as a phantom model on qwen
// threads: displayed in the picker AND dispatched to a CLI that never
// served it.
import { DEFAULT_MODEL_BY_PROVIDER, type ProviderDriverKind } from "@t3tools/contracts";

export function seedModelForDriver(driverKind: ProviderDriverKind): string {
  return DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? "";
}
