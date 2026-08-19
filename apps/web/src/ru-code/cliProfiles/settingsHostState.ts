// ru-code: the provider card's config-blob transitions as pure composites, so the
// card handlers stay thin seams (R6) and the WHOLE host decision — what the persisted
// `config` blob becomes when a user adds / removes / reorders a custom model or changes
// the session-start auth — is unit-testable end to end (MEMORY "test composites not
// fragments"), not just the leaf helpers it chains. Behaviour identical to the previous
// inline handler bodies in ProviderInstanceCard.
import type { AuthMethodId, CliProfileId } from "@ru-code/branding";

import {
  appendCustomModelEntry,
  nextConfigBlobWithValue,
  readCustomModelEntries,
  readDefaultAuthMethod,
  reconcileCustomModelEntries,
  setOrDeleteConfigKey,
} from "./customModelEntries";
import { effectiveDefaultAuthMethod, readProfileId } from "./profileConfig";

/**
 * The config blob after a custom-model list change (remove / reorder — arriving as
 * slugs). For a profile driver (qwen) each surviving slug KEEPS its stored auth
 * method; other drivers store the plain slug list. A model dropped from `nextSlugs`
 * is gone; a slug with no prior entry defaults to `""` (⇒ server-resolved auth).
 */
export function configAfterCustomModelListChange(
  config: unknown,
  nextSlugs: ReadonlyArray<string>,
  isProfileDriver: boolean,
): Record<string, unknown> {
  const entries = readCustomModelEntries(config);
  const value = isProfileDriver ? reconcileCustomModelEntries(entries, nextSlugs) : [...nextSlugs];
  return nextConfigBlobWithValue(config, "customModels", value);
}

/**
 * The config blob after adding one qwen custom model with its chosen auth method.
 * Appends `{ slug, authMethod }`, replacing any prior entry for the same slug so a
 * re-add updates the auth rather than duplicating the row.
 */
export function configAfterCustomModelAdd(
  config: unknown,
  slug: string,
  authMethod: string,
): Record<string, unknown> {
  const value = appendCustomModelEntry(readCustomModelEntries(config), slug, authMethod);
  return nextConfigBlobWithValue(config, "customModels", value);
}

/**
 * The config blob after changing the instance's session-start default auth method.
 * A concrete method is stored; `""` (Auto) DELETES the key so the server resolves it
 * from the profile default (distinct from storing an empty override).
 */
export function configAfterDefaultAuthMethodChange(
  config: unknown,
  authMethod: string,
): Record<string, unknown> {
  return setOrDeleteConfigKey(config, "defaultAuthMethod", authMethod);
}

export interface InstanceAuthProjection {
  /** Brand profile of the instance (drives the display + the Auto fallback). */
  readonly profileId: CliProfileId;
  /** The stored session-start override; `""` ⇒ Auto (no override). */
  readonly storedDefaultAuthMethod: string;
  /**
   * What Auto resolves to for THIS instance — the stored override when valid, else
   * the profile default. This is the per-model auth fallback the card passes down so
   * a model's "Auto" hint matches what the server will use.
   */
  readonly effectiveDefaultAuthMethod: AuthMethodId;
}

/**
 * The auth view the card renders from a qwen instance's config: profile + stored
 * override + the effective default the per-model rows fall back to. One projection so
 * "pick profile X (or set override Y) ⇒ this auth fallback" is a single tested decision.
 */
export function resolveInstanceAuthProjection(config: unknown): InstanceAuthProjection {
  return {
    profileId: readProfileId(config),
    storedDefaultAuthMethod: readDefaultAuthMethod(config),
    effectiveDefaultAuthMethod: effectiveDefaultAuthMethod(config),
  };
}
