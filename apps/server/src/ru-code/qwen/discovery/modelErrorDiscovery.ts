/**
 * ru-code: channel B of qwen model discovery — the pure decision that turns a
 * model-related ACP error into a store mutation (drop the dead model, add the
 * models the backend suggests).
 *
 * Two proven error shapes reach us as `-32603 data.details` (qwen 0.13.1 rethrows
 * everything verbatim — `errorHandler.ts:63`, `geminiChat.ts:448`, `Session.ts:338`):
 *   1. qwen-local registry miss:  `Model '<id>' not found for authType '<auth>'`
 *      (`modelsConfig.ts:383-387`) — names the dead model explicitly.
 *   2. Backend API rejection: `"<status> <backend prose>"` (openai SDK
 *      `APIError.makeMessage`) — arbitrary prose that may list valid models in
 *      the `xxx/…(auth)` grammar. Here the dead model is the one WE sent.
 *
 * Guards against false positives: backend prose only counts when it either
 * carries an explicit model-not-found phrase, or lists ≥2 model tokens next to
 * the word "model" (one token could be an unrelated error merely echoing the
 * current model id).
 *
 * @module ru-code/qwen/discovery/modelErrorDiscovery
 */
import { isHiddenModel } from "@ru-code/branding";
import { extractModelTokens, type ParsedModelToken } from "@ru-code/qwen/models/modelToken";

import type { DiscoveredQwenModel } from "./QwenModelDiscoveryStore.ts";

/** qwen-local registry miss (`modelsConfig.ts:383-387`), verbatim over ACP. */
const QWEN_LOCAL_MODEL_NOT_FOUND = /Model '([^']+)' not found for authType '([^']+)'/;

// Backend prose phrases signalling a model-not-found (EN + RU variants).
const MODEL_NOT_FOUND_PHRASES =
  /not found|not exist|does not exist|no such model|invalid model|unknown model|unsupported model|incorrect model|не найден|не существует|недоступн|неверная модель|неизвестная модель/i;

export interface ModelErrorDiscovery {
  /** Slug to drop from the served set; null when it can't be named. */
  readonly badModelSlug: string | null;
  /** Backend-suggested replacements (never includes the bad slug). */
  readonly suggestedModels: ReadonlyArray<DiscoveredQwenModel>;
}

const toDiscoveredModel = (token: ParsedModelToken): DiscoveredQwenModel => ({
  slug: token.slug,
  authMethod: token.authMethod,
  name: token.name,
  ...(token.nTokens !== null ? { nTokens: token.nTokens } : {}),
});

/**
 * Decide whether an error's `data.details` text is a model-not-found and what
 * to do about it. `sentModelSlug` is the clean slug the adapter dispatched for
 * the failing call (the "current model") — the dead model when the backend
 * prose doesn't name one.
 *
 * Returns null when the text is not a model error (nothing to mutate).
 */
export function detectModelErrorDiscovery(input: {
  readonly detailsText: string;
  readonly sentModelSlug: string | null;
}): ModelErrorDiscovery | null {
  const details = input.detailsText;

  const localMatch = QWEN_LOCAL_MODEL_NOT_FOUND.exec(details);
  if (localMatch?.[1]) {
    const badModelSlug = localMatch[1];
    return {
      badModelSlug,
      suggestedModels: extractModelTokens(details)
        // Scan gate: backend-suggested HIDE_MODELS matches never enter the app.
        .filter((token) => token.slug !== badModelSlug && !isHiddenModel(token.slug))
        .map(toDiscoveredModel),
    };
  }

  if (!/model|модел/i.test(details)) return null;
  const suggested = extractModelTokens(details);
  const hasNotFoundPhrase = MODEL_NOT_FOUND_PHRASES.test(details);
  // Accept: explicit phrase, or a genuine list (≥2 tokens) — a single token
  // without the phrase is just the current model echoed in unrelated prose.
  if (!hasNotFoundPhrase && suggested.length < 2) return null;
  if (!hasNotFoundPhrase && input.sentModelSlug === null) return null;

  const badModelSlug = input.sentModelSlug;
  const suggestedModels = suggested
    // Scan gate: backend-suggested HIDE_MODELS matches never enter the app.
    .filter((token) => token.slug !== badModelSlug && !isHiddenModel(token.slug))
    .map(toDiscoveredModel);
  // Nothing to drop AND nothing to add — not an actionable discovery.
  if (badModelSlug === null && suggestedModels.length === 0) return null;
  return { badModelSlug, suggestedModels };
}
