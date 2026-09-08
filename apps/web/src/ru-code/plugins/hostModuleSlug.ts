// ru-code: specifier → file/URL slug for the host-provided module entries (D13).
//
// WHY a slug at all: `HOST_PROVIDED_MODULES` specifiers contain `@` and `/`
// (`@base-ui/react/dialog`), which are legal in an import-map KEY but not in a
// Rollup entry NAME or a source filename. The slug is the stable name of the
// generated entry module, of its Rollup entry, and of its emitted chunk — the
// import map is what puts the real specifier back in front of it.
//
// The mapping is deliberately trivial and total (drop the leading `@`, `/` → `__`)
// so a human can read `assets/host-modules/base-ui__react__dialog-<hash>.js` and
// know which package it is. `hostModuleSlugs()` asserts injectivity, so a future
// specifier that would collide fails the generator and the drift test rather than
// silently overwriting another module's entry.

/** `@base-ui/react/dialog` → `base-ui__react__dialog`. */
export function hostModuleSlug(specifier: string): string {
  return specifier.replace(/^@/, "").replaceAll("/", "__");
}

/** Every slug for the given specifiers, in contract order. Throws on a collision. */
export function hostModuleSlugs(specifiers: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Map<string, string>();
  for (const specifier of specifiers) {
    const slug = hostModuleSlug(specifier);
    const previous = seen.get(slug);
    if (previous !== undefined) {
      throw new Error(
        `host-modules: slug collision — "${specifier}" and "${previous}" both map to "${slug}"`,
      );
    }
    seen.set(slug, specifier);
  }
  return [...seen.keys()];
}

/** Where the generated entry module for a specifier lives, relative to this file's directory. */
export const HOST_MODULES_DIR = "hostModules";

/** The Rollup entry name (and therefore the `assets/<name>-<hash>.js` path) for a specifier. */
export function hostModuleEntryName(specifier: string): string {
  return `host-modules/${hostModuleSlug(specifier)}`;
}
