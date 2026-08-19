// ru-code: the model picker's instance-visibility decisions as pure composites, so
// ModelPickerContent stays a thin seam (R6) that renders what these return. The whole
// "which instances appear in the rail / contribute models / are disabled under a locked
// provider, and which rail item is primed on open" decision is unit-testable as a
// composite (MEMORY "test composites not fragments"), not a scatter of DOM fragments.
// Mirrors the inline useMemos in ModelPickerContent verbatim.
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * Whether an instance is selectable while the picker is locked to a driver kind
 * (message-edit / continuation). `lockedProvider === null` ⇒ everything matches.
 * When a `lockedContinuationGroupKey` is present the instance must ALSO share that
 * continuation group, so a locked codex edit can still switch between codex
 * instances but not into a different continuation lineage.
 */
export function matchesLockedProvider(
  entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  lockedProvider: ProviderDriverKind | null,
  lockedContinuationGroupKey?: string | null,
): boolean {
  if (lockedProvider === null) return true;
  if (entry.driverKind !== lockedProvider) return false;
  if (!lockedContinuationGroupKey) return true;
  return entry.continuationGroupKey === lockedContinuationGroupKey;
}

export interface ModelPickerInstanceView {
  /**
   * Rail buttons, one per ENABLED instance. Unlocked: enabled order as-is.
   * Locked: instances matching the locked provider first, the rest (rendered
   * disabled) after.
   */
  readonly sidebarInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /**
   * Instance ids to render as disabled rail buttons — the ones that don't match
   * the locked provider. `undefined` when nothing is locked (no disabling).
   */
  readonly disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  /**
   * Instances that may currently contribute models to the list — enabled AND
   * available AND probe-ready. A visible-but-not-ready instance shows in the rail
   * but its models are withheld until it reconciles.
   */
  readonly readyInstanceIds: ReadonlySet<ProviderInstanceId>;
}

/**
 * The full instance-visibility projection the picker renders from. Split from the
 * component so the enabled/ready/locked interplay is one testable decision.
 */
export function resolveModelPickerInstanceView(input: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey?: string | null | undefined;
}): ModelPickerInstanceView {
  const { instanceEntries, lockedProvider, lockedContinuationGroupKey } = input;
  const isLocked = lockedProvider !== null;

  const readyInstanceIds = new Set<ProviderInstanceId>();
  for (const entry of instanceEntries) {
    if (isProviderInstancePickerReady(entry)) {
      readyInstanceIds.add(entry.instanceId);
    }
  }

  const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);

  if (!isLocked) {
    return {
      sidebarInstanceEntries: enabledEntries,
      disabledInstanceIds: undefined,
      readyInstanceIds,
    };
  }

  const available: ProviderInstanceEntry[] = [];
  const disabled: ProviderInstanceEntry[] = [];
  for (const entry of enabledEntries) {
    if (matchesLockedProvider(entry, lockedProvider, lockedContinuationGroupKey)) {
      available.push(entry);
    } else {
      disabled.push(entry);
    }
  }

  // Locked-out ids are computed over ALL entries (not just enabled) so a disabled
  // instance still resolves a tooltip if it somehow renders.
  const disabledInstanceIds = new Set<ProviderInstanceId>();
  for (const entry of instanceEntries) {
    if (!matchesLockedProvider(entry, lockedProvider, lockedContinuationGroupKey)) {
      disabledInstanceIds.add(entry.instanceId);
    }
  }

  return {
    sidebarInstanceEntries: [...available, ...disabled],
    disabledInstanceIds,
    readyInstanceIds,
  };
}

/**
 * Which rail item the picker primes when it opens. Locked ⇒ the currently-active
 * instance stays focused; otherwise Favorites when the user has any, else the
 * active instance.
 */
export function resolveInitialModelPickerInstance(input: {
  readonly lockedProvider: ProviderDriverKind | null;
  readonly activeInstanceId: ProviderInstanceId;
  readonly hasFavorites: boolean;
}): ProviderInstanceId | "favorites" {
  if (input.lockedProvider !== null) {
    return input.activeInstanceId;
  }
  return input.hasFavorites ? "favorites" : input.activeInstanceId;
}
