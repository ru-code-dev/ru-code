// ru-code: whether a provider snapshot is the AUTHORITATIVE, complete model list.
//
// Most drivers discover models incrementally (a probe reports a delta), so the
// registry merges additively — a model absent from the newest probe is kept, on
// the assumption the probe just didn't re-list it. The qwen provider is the
// opposite: its models come wholesale from the instance's settings + brand
// profile (and, in the future, from qwen's own ACP model detection), so every
// snapshot is the FULL, current set. For it, "absent from the new snapshot"
// means "removed" — carrying the old model forward would resurrect a ghost the
// user just deleted (and survive restart via the on-disk status cache).
//
// This predicate is the single gate both merge sites (ProviderRegistry's live
// merge + providerStatusCache's boot hydrate) consult to switch off the
// keep-absent union for qwen while leaving every other driver's additive merge
// untouched. Threaded off the snapshot's own `driver`, so it is correct for
// every qwen instance (any profile / any instanceId) and nothing else.

import { QWEN_KIND } from "@ru-code/branding";
import { ProviderDriverKind } from "@t3tools/contracts";

const QWEN_DRIVER_KIND = ProviderDriverKind.make(QWEN_KIND);

export const isModelsAuthoritative = (driver: ProviderDriverKind | undefined): boolean =>
  driver === QWEN_DRIVER_KIND;
