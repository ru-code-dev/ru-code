/**
 * ru-code: channel A of qwen model discovery — the pure transform from a
 * `session/new` / `session/load` response to the store's `DiscoveredQwenModel`
 * rows. qwen 0.13.1 advertises its FULL model catalog on every session setup
 * (`acpAgent.ts buildAvailableModels`): each entry's `modelId` is
 * `formatAcpModelId(id, authType)` = `${id}(${authType})` and
 * `_meta.contextLimit` is the model's context window (config override ??
 * qwen's own `tokenLimit(id)`).
 *
 * The SLUG is the single naming/window authority (the user's `xxx/…-256K(auth)`
 * convention): names are ALWAYS the humanized slug — the advertised `name`
 * label is IGNORED (it's CLI-side config junk: the user's `modelProviders`
 * display label or qwen's raw lowercase hardcoded id). Window resolution:
 * slug size suffix (`-256k`, priority) → advertised `_meta.contextLimit` →
 * absent (serve-time fallback).
 *
 * The transform never throws and never invents entries: an advertisement the
 * grammar can't parse still lands with its raw id as the slug (auth resolved
 * to the instance default at serve time), so no advertised model is dropped.
 *
 * @module ru-code/qwen/discovery/discoveredModelsFromSessionSetup
 */
import type * as EffectAcpSchema from "effect-acp/schema";

import { isHiddenModel } from "@ru-code/branding";
import {
  humanizeModelSlug,
  parseContextWindowFromSlug,
  parseModelToken,
} from "@ru-code/qwen/models/modelToken";

import type { DiscoveredQwenModel } from "./QwenModelDiscoveryStore.ts";

type SessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

const asPositiveFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

/** `_meta.contextLimit` of one advertised ModelInfo, when present and sane. */
const advertisedContextLimit = (modelInfo: EffectAcpSchema.ModelInfo): number | null => {
  const meta = modelInfo._meta;
  if (!meta || typeof meta !== "object") return null;
  return asPositiveFiniteNumber((meta as Record<string, unknown>)["contextLimit"]);
};

/**
 * Extract the discovered model rows from a session setup response. Returns []
 * when the response has no model state or an empty catalog — the caller's
 * empty-guard treats that as "broken run, keep the current set".
 */
export function discoveredModelsFromSessionSetup(
  setupResult: SessionSetupResult,
): ReadonlyArray<DiscoveredQwenModel> {
  const modelState = "models" in setupResult ? setupResult.models : undefined;
  if (!modelState) return [];

  const seenSlugs = new Set<string>();
  const discovered: DiscoveredQwenModel[] = [];
  for (const modelInfo of modelState.availableModels) {
    const parsed = parseModelToken(modelInfo.modelId);
    const slug = parsed?.slug ?? modelInfo.modelId.trim();
    if (slug.length === 0 || seenSlugs.has(slug)) continue;
    // The SCAN GATE: a HIDE_MODELS match never enters the app — not persisted, not
    // served, never the auto-default. An advertisement of ONLY hidden models therefore
    // comes out empty, and the caller's empty-guard keeps the current set. (A user can
    // still add the model manually in provider settings — customModels are not a scan.)
    if (isHiddenModel(slug)) continue;
    seenSlugs.add(slug);

    // Slug is the authority: window from its size suffix first, name always
    // humanized from it (the advertised label is CLI-side config, ignored).
    const nTokens = parseContextWindowFromSlug(slug) ?? advertisedContextLimit(modelInfo);
    discovered.push({
      slug,
      authMethod: parsed?.authMethod ?? "",
      name: humanizeModelSlug(slug),
      ...(nTokens !== null ? { nTokens } : {}),
    });
  }
  return discovered;
}
