// ru-code: qwen custom-model + auth config-shape helpers, extracted verbatim from
// ProviderInstanceCard so the upstream component keeps only a seam that calls them (R6).
// Behaviour identical to the pre-extraction inline definitions.

export interface CustomModelEntry {
  readonly slug: string;
  readonly authMethod: string;
}

/**
 * ru-code: custom-model entries as `{ slug, authMethod }`, tolerating both the
 * plain-slug `string[]` shape (most drivers) and qwen's `{ slug, authMethod }[]`
 * shape. `authMethod` is `""` for a plain slug (⇒ instance default on the server).
 */
export function readCustomModelEntries(config: unknown): ReadonlyArray<CustomModelEntry> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>).customModels;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ slug: entry, authMethod: "" }];
    if (entry !== null && typeof entry === "object" && typeof entry.slug === "string") {
      return [
        {
          slug: entry.slug,
          authMethod: typeof entry.authMethod === "string" ? entry.authMethod : "",
        },
      ];
    }
    return [];
  });
}

/** ru-code: read the instance's stored session-start auth override (`""` ⇒ Auto). */
export function readDefaultAuthMethod(config: unknown): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>).defaultAuthMethod;
  return typeof value === "string" ? value : "";
}

/**
 * ru-code: map a next slug list back to `{ slug, authMethod }` objects, PRESERVING
 * each surviving slug's stored auth method (remove/reorder come through as slugs).
 * A slug with no prior entry defaults to `""` (⇒ instance default on the server).
 */
export function reconcileCustomModelEntries(
  entries: ReadonlyArray<CustomModelEntry>,
  nextSlugs: ReadonlyArray<string>,
): ReadonlyArray<CustomModelEntry> {
  return nextSlugs.map(
    (slug) => entries.find((entry) => entry.slug === slug) ?? { slug, authMethod: "" },
  );
}

/** ru-code: append (or replace) a custom-model entry with its chosen auth method. */
export function appendCustomModelEntry(
  entries: ReadonlyArray<CustomModelEntry>,
  slug: string,
  authMethod: string,
): ReadonlyArray<CustomModelEntry> {
  return [...entries.filter((entry) => entry.slug !== slug), { slug, authMethod }];
}

/**
 * ru-code: normalize a raw customModels array (plain slugs OR `{ slug, authMethod }`
 * objects) to just the slugs. One shared helper so the composer's two read sites
 * (instance blob + legacy per-kind bucket) can't drift.
 */
export function customModelSlugs(entries: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { slug?: unknown }).slug === "string"
    ) {
      return [(entry as { slug: string }).slug];
    }
    return [];
  });
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike provider
 * settings field updates, does not drop empty-looking values — the caller decides
 * whether an empty array/object should be stored explicitly (e.g. `customModels: []`
 * is a meaningful "user cleared their custom list" state distinct from "driver default").
 */
export function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

/**
 * ru-code: set `key` when `value` is truthy, else delete it (the session-start
 * auth override's "`""` ⇒ Auto removes the key" behaviour, hoisted out of the card).
 */
export function setOrDeleteConfigKey(
  config: unknown,
  key: string,
  value: string,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  if (value) base[key] = value;
  else delete base[key];
  return base;
}
