// ru-code: the whole "add a custom model" decision as one pure function.
//
// ProviderModelsSection's add handler is otherwise a tangle of parse →
// normalize → validate → decide-commit-shape that can only be exercised through
// the DOM. Extracting it here means the composite — including the qwen inline
// `slug(auth)` split and every rejection branch — is unit-testable, and the
// component becomes a thin dispatcher that applies the result.
//
// The auth field is qwen-only: `authFallback` is set iff the instance shows the
// per-model auth UI. When set, a successful result carries an `authMethod`
// string (`""` ⇒ Auto/server-resolved) and the caller commits via
// `onAddModelWithAuth`; when unset, `authMethod` is undefined and the caller
// appends the plain slug via `onChange`.

import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { type AuthMethodId } from "@ru-code/branding";

import { MAX_CUSTOM_MODEL_LENGTH } from "~/modelSelection";
import { parseSlugWithAuth } from "./parseSlugWithAuth";

export type CustomModelAddition =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly slug: string;
      /** qwen: the auth method to commit (`""` ⇒ Auto). `undefined` ⇒ non-qwen plain append. */
      readonly authMethod?: string;
    };

export interface CustomModelAdditionInput {
  /** Raw text from the add input. */
  readonly raw: string;
  /** Driver kind for slug normalization; `null` when metadata is missing. */
  readonly driverKind: ProviderDriverKind | null;
  /** The live model list — a match against a non-custom slug is "already built in". */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** Already-saved custom slugs — a match is "already saved". */
  readonly customModels: ReadonlyArray<string>;
  /** qwen only: set ⇒ per-model auth on; also the value "Auto" resolves to. */
  readonly authFallback?: AuthMethodId | undefined;
  /** qwen only: the auth chosen in the add dropdown (`""` ⇒ Auto). */
  readonly authMethodInput?: string;
}

export function resolveCustomModelAddition(input: CustomModelAdditionInput): CustomModelAddition {
  const authOn = input.authFallback !== undefined;
  // qwen: peel an inline `slug(auth)` suffix so the slug stays clean and the
  // parsed auth wins over the dropdown. Other drivers take the raw text as-is.
  const parsed = authOn ? parseSlugWithAuth(input.raw) : { slug: input.raw, authMethod: undefined };
  const normalized = input.driverKind
    ? normalizeModelSlug(parsed.slug, input.driverKind)
    : parsed.slug.trim() || null;

  if (!normalized) {
    return { ok: false, error: "Enter a model slug." };
  }
  if (input.models.some((model) => !model.isCustom && model.slug === normalized)) {
    return { ok: false, error: "That model is already built in." };
  }
  if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
    return {
      ok: false,
      error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
    };
  }
  if (input.customModels.includes(normalized)) {
    return { ok: false, error: "That custom model is already saved." };
  }

  if (!authOn) {
    return { ok: true, slug: normalized };
  }
  // Parsed inline auth wins; else the dropdown value (`""` ⇒ Auto).
  return {
    ok: true,
    slug: normalized,
    authMethod: parsed.authMethod ?? input.authMethodInput ?? "",
  };
}
