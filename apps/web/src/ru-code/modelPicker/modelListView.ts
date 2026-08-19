// ru-code: the model picker's LIST decisions as pure composites, so ModelPickerContent
// stays a thin seam that renders what these return. Two decisions live here: which
// models flatten into the searchable array (only READY instances contribute — a
// visible-but-not-ready instance rails but withholds its models), and what the list
// finally shows for the current search / rail selection / locked-provider state.
// Mirrors the inline useMemos in ModelPickerContent verbatim.
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { type CliProfileId } from "@ru-code/branding";

import {
  buildModelPickerSearchText,
  scoreModelPickerSearch,
} from "../../components/chat/modelPickerSearch";
import type { ModelEsque } from "../../components/chat/providerIconUtils";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { canHoldContext } from "../tokens-usage/selectedModelContextWindow";
import { matchesLockedProvider } from "./instanceView";

/** Tooltip on rows the current chat no longer fits into. */
export const CONTEXT_OVERFLOW_DISABLED_REASON =
  "The conversation no longer fits this model's context";

export type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  /** Served context window (tokens) when the provider reports one. */
  contextWindowTokens?: number | undefined;
  /**
   * The current chat's usage no longer fits into this model's window, so the
   * row renders disabled. The composer's active model is never gated, and
   * models with an unreported window are never gated either.
   */
  disabledByContext: boolean;
  /** Superseded by a newer model per the assistant — grouped/marked as legacy. */
  isLegacy?: boolean;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  /**
   * Brand profile of the owning instance (qwen only) so the row shows the
   * profile mark, not the stock kind glyph.
   */
  instanceProfile?: CliProfileId | undefined;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
};

/**
 * Flatten models into a searchable array. One pass over the instance-keyed
 * map; each model carries its instance id + driver kind so the list row can
 * render the right icon and display name without another lookup. Only
 * instances in `readyInstanceIds` contribute — the rest are withheld until
 * they reconcile.
 */
export function flattenModelPickerModels(input: {
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>;
  readonly readyInstanceIds: ReadonlySet<ProviderInstanceId>;
  /**
   * Capacity gating: the raw history usage plus the composer's active model
   * (which is never gated). Absent/null usage ⇒ nothing is disabled.
   */
  readonly usedTokens?: number | null;
  readonly activeInstanceId?: ProviderInstanceId | null;
  readonly activeModelSlug?: string | null;
}): ModelPickerItem[] {
  const { modelOptionsByInstance, entryByInstanceId, readyInstanceIds } = input;
  const usedTokens = input.usedTokens ?? null;
  const out: ModelPickerItem[] = [];
  for (const [instanceId, models] of modelOptionsByInstance) {
    const entry = entryByInstanceId.get(instanceId);
    if (!entry) {
      // Instance disappeared between renders (configuration change). Skip
      // its models — stale options shouldn't appear in the picker.
      continue;
    }
    if (!readyInstanceIds.has(instanceId)) {
      continue;
    }
    for (const model of models) {
      const isActiveModel =
        instanceId === input.activeInstanceId && model.slug === input.activeModelSlug;
      out.push({
        slug: model.slug,
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        ...(model.contextWindowTokens != null
          ? { contextWindowTokens: model.contextWindowTokens }
          : {}),
        ...(model.isLegacy ? { isLegacy: true } : {}),
        disabledByContext: !isActiveModel && !canHoldContext(model, usedTokens),
        instanceId,
        driverKind: entry.driverKind,
        // Carry the instance's brand profile onto the flat row for icons.
        ...(entry.profile ? { instanceProfile: entry.profile } : {}),
        instanceDisplayName: entry.displayName,
        ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
        ...(entry.continuationGroupKey ? { continuationGroupKey: entry.continuationGroupKey } : {}),
      });
    }
  }
  return out;
}

/**
 * Filter models based on search query and selected instance. Searching ranks
 * by the tokenized fuzzy score (favorites boosted, stable tie-break) and only
 * respects the locked provider; otherwise the rail selection (an instance or
 * Favorites) narrows the flat list before the shared ordering.
 */
export function filterModelPickerModels(input: {
  readonly flatModels: ReadonlyArray<ModelPickerItem>;
  readonly searchQuery: string;
  readonly favoriteModelKeys: ReadonlySet<string>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey?: string | null | undefined;
  readonly selectedInstanceId: ProviderInstanceId | "favorites";
  readonly instanceOrder: ReadonlyArray<ProviderInstanceId>;
}): ModelPickerItem[] {
  const {
    flatModels,
    searchQuery,
    favoriteModelKeys,
    lockedProvider,
    lockedContinuationGroupKey,
    selectedInstanceId,
    instanceOrder,
  } = input;
  let result = flatModels;

  // Apply tokenized fuzzy search across the combined provider/model search fields.
  if (searchQuery.trim()) {
    const rankedMatches = result
      .map((model) => ({
        model,
        score: scoreModelPickerSearch(
          {
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: model.driverKind,
            providerDisplayName: model.instanceDisplayName,
            isFavorite: favoriteModelKeys.has(providerModelKey(model.instanceId, model.slug)),
          },
          searchQuery,
        ),
        isFavorite: favoriteModelKeys.has(providerModelKey(model.instanceId, model.slug)),
        tieBreaker: buildModelPickerSearchText({
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          driverKind: model.driverKind,
          providerDisplayName: model.instanceDisplayName,
        }),
      }))
      .filter(
        (
          rankedModel,
        ): rankedModel is {
          model: ModelPickerItem;
          score: number;
          isFavorite: boolean;
          tieBreaker: string;
        } => rankedModel.score !== null,
      );

    // When searching, we only respect locked provider (by driver kind),
    // ignoring sidebar selection so account-scoped searches can find a
    // model before the user chooses a specific instance rail item.
    if (lockedProvider !== null) {
      const lockedProviderMatches: Array<(typeof rankedMatches)[number]> = [];
      for (const rankedModel of rankedMatches) {
        if (matchesLockedProvider(rankedModel.model, lockedProvider, lockedContinuationGroupKey)) {
          lockedProviderMatches.push(rankedModel);
        }
      }
      return lockedProviderMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    return rankedMatches
      .toSorted((a, b) => {
        const scoreDelta = a.score - b.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        if (a.isFavorite !== b.isFavorite) {
          return a.isFavorite ? -1 : 1;
        }
        return a.tieBreaker.localeCompare(b.tieBreaker);
      })
      .map((rankedModel) => rankedModel.model);
  }

  if (lockedProvider !== null) {
    result = result.filter((m) =>
      matchesLockedProvider(m, lockedProvider, lockedContinuationGroupKey),
    );
    if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoriteModelKeys.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }
  } else if (selectedInstanceId === "favorites") {
    result = result.filter((m) => favoriteModelKeys.has(providerModelKey(m.instanceId, m.slug)));
  } else {
    result = result.filter((m) => m.instanceId === selectedInstanceId);
  }

  return sortProviderModelItems(result, {
    favoriteModelKeys,
    groupFavorites: selectedInstanceId !== "favorites",
    instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
  });
}
