/**
 * ru-code: THE serving rule for a qwen instance's model list — one pure
 * decision, no branches hidden in the snapshot builders:
 *
 *   base   = discovered set (when non-empty)  — discovery is authoritative
 *          | profile built-ins (until the first successful discovery)
 *   served = base + user custom models (slugs already in base are skipped —
 *            the base entry carries the authoritative window)
 *
 * Window (`nTokens`) per source: profile models carry a profile-owned value;
 * discovered models carry qwen's advertised `contextLimit` (or their slug's
 * size suffix); custom models parse their slug's size suffix. Models with no
 * derivable window omit `nTokens` — the meter falls back to the adapter
 * default.
 *
 * @module ru-code/qwen/discovery/serveQwenModels
 */
import type { QwenSettings, ServerProviderModel } from "@t3tools/contracts";

import {
  asAuthMethodId,
  hiddenModelWindow,
  resolveCliProfile,
  type AuthMethodId,
} from "@ru-code/branding";
import { QWEN_MODELS_AUTO_DISCOVERY } from "@ru-code/qwen/constants";
import { parseContextWindowFromSlug } from "@ru-code/qwen/models/modelToken";

import { resolveDefaultAuthMethod, resolveModelAuthMethod } from "../profileResolver.ts";
import type { DiscoveredQwenModel } from "./QwenModelDiscoveryStore.ts";

/**
 * Assemble the full served model list for one qwen instance.
 * Pure — both snapshot builders and tests call this directly.
 */
export function serveQwenModels(
  settings: QwenSettings,
  discoveredModels: ReadonlyArray<DiscoveredQwenModel>,
): ReadonlyArray<ServerProviderModel> {
  const profile = resolveCliProfile(settings.profile);
  const fallbackAuth = resolveDefaultAuthMethod(settings);

  // Kill-switch off ⇒ the discovered store is ignored wholesale, so a
  // previously persisted set can never resurface.
  const servedDiscoveredModels = QWEN_MODELS_AUTO_DISCOVERY ? discoveredModels : [];

  const base: ServerProviderModel[] =
    servedDiscoveredModels.length > 0
      ? servedDiscoveredModels.map((model) => ({
          slug: model.slug,
          name: model.name.trim().length > 0 ? model.name : model.slug,
          isCustom: false,
          capabilities: null,
          authType: asAuthMethodId(model.authMethod) ?? fallbackAuth,
          ...(model.nTokens !== undefined && model.nTokens > 0
            ? { nTokens: Math.round(model.nTokens) }
            : {}),
        }))
      : profile.models.map((model) => ({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          isCustom: false,
          capabilities: null,
          authType: model.authMethod,
          nTokens: model.nTokens,
        }));

  const baseSlugs = new Set(base.map((model) => model.slug));
  const custom: ServerProviderModel[] = settings.customModels
    .filter((model) => !baseSlugs.has(model.slug))
    .map((model) => {
      // Slug size-suffix first; else, for a manually-added HIDE_MODELS match, the entry's
      // KNOWN window (the scan gate dropped the advertisement that would have carried it).
      const nTokens = parseContextWindowFromSlug(model.slug) ?? hiddenModelWindow(model.slug);
      return {
        slug: model.slug,
        name: model.slug,
        isCustom: true,
        capabilities: null,
        authType: asAuthMethodId(model.authMethod) ?? fallbackAuth,
        ...(nTokens !== null ? { nTokens } : {}),
      };
    });

  return [...base, ...custom];
}

/**
 * Auth for a model about to be DISPATCHED (setModel / textgen --auth-type):
 * the served entry's own auth wins — a discovered model advertises its auth
 * in the session advertisement, a profile/custom model carries its configured
 * one — and only a slug absent from the served list falls back to the
 * settings-based resolution (profile built-ins → custom → instance default).
 */
export function resolveServedModelAuthMethod(
  settings: QwenSettings,
  servedModels: ReadonlyArray<ServerProviderModel>,
  slug: string,
): AuthMethodId {
  const servedAuth = asAuthMethodId(servedModels.find((model) => model.slug === slug)?.authType);
  return servedAuth ?? resolveModelAuthMethod(settings, slug);
}
