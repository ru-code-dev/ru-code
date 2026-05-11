/**
 * Numeric semver comparison for the startup-gate preflight.
 *
 * Two operations:
 *   - `isAtLeast(actual, minimum)` — three-component numeric ">="
 *   - `satisfiesRange(actual, range)` — npm-style range parser for the
 *     `^X.Y || >=X.Y` grammar used by `NODE_ENGINE_RANGE`
 *
 * Hand-rolled (no `semver` dep). Same algorithm mirrored in
 * `install` (bash) as `version_at_least` and `version_satisfies_range`.
 * See `ru-fork-instrumental/changes/deamon/startap-checks.md`.
 */

export type ParsedVersion = readonly [number, number, number];

export const parseVersion = (input: string): ParsedVersion | null => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(input);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
};

export const isAtLeast = (actual: string, minimum: string): boolean => {
  const a = parseVersion(actual);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  const [aMaj, aMin, aPat] = a;
  const [bMaj, bMin, bPat] = b;
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
};

export const satisfiesRange = (actual: string, range: string): boolean => {
  const parsed = parseVersion(actual);
  if (!parsed) return false;
  const [aMaj, aMin, aPat] = parsed;
  return range.split("||").some((raw) => {
    const disjunct = raw.trim();
    let m = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(disjunct);
    if (m) {
      // ^X.Y[.Z]: major matches X, minor >= Y. We deliberately ignore
      // semver's special `^0.x.y` rule because the current
      // NODE_ENGINE_RANGE doesn't use it.
      return aMaj === Number(m[1]) && aMin >= Number(m[2]);
    }
    m = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(disjunct);
    if (m) {
      const tMaj = Number(m[1]);
      const tMin = Number(m[2]);
      const tPat = Number(m[3] ?? 0);
      if (aMaj !== tMaj) return aMaj > tMaj;
      if (aMin !== tMin) return aMin > tMin;
      return aPat >= tPat;
    }
    return false;
  });
};
