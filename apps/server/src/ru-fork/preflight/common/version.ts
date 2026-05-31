// Numeric version comparison — no semver dependency. Parses the
// `^X.Y || >=X.Y` grammar used by NODE_ENGINE_RANGE.

export type ParsedVersion = readonly [number, number, number];

export const parseVersion = (input: string): ParsedVersion | null => {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(input);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

/** Three-component numeric `actual >= minimum`. */
export const isAtLeast = (actual: string, minimum: string): boolean => {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  const [actualMajor, actualMinor, actualPatch] = actualParts;
  const [minimumMajor, minimumMinor, minimumPatch] = minimumParts;
  if (actualMajor !== minimumMajor) return actualMajor > minimumMajor;
  if (actualMinor !== minimumMinor) return actualMinor > minimumMinor;
  return actualPatch >= minimumPatch;
};

/** Does `actual` satisfy an `^X.Y[.Z] || >=X.Y[.Z]` range? */
export const satisfiesRange = (actual: string, range: string): boolean => {
  const actualParts = parseVersion(actual);
  if (!actualParts) return false;
  const [actualMajor, actualMinor, actualPatch] = actualParts;
  return range.split("||").some((rawDisjunct) => {
    const disjunct = rawDisjunct.trim();

    const caretMatch = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(disjunct);
    if (caretMatch) {
      return actualMajor === Number(caretMatch[1]) && actualMinor >= Number(caretMatch[2]);
    }

    const atLeastMatch = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(disjunct);
    if (atLeastMatch) {
      const targetMajor = Number(atLeastMatch[1]);
      const targetMinor = Number(atLeastMatch[2]);
      const targetPatch = Number(atLeastMatch[3] ?? 0);
      if (actualMajor !== targetMajor) return actualMajor > targetMajor;
      if (actualMinor !== targetMinor) return actualMinor > targetMinor;
      return actualPatch >= targetPatch;
    }

    return false;
  });
};

/**
 * Extract "X.Y[.Z]" from arbitrary output. ASCII digits survive any codepage,
 * so this parses correctly even when surrounding text is mojibake — which is
 * why probing `node cli.js --version` directly is reliable where a PATH shim
 * through cmd.exe was not.
 */
export const extractVersion = (output: string): string | null => {
  const match = /\d+\.\d+(?:\.\d+)?/.exec(output);
  return match ? match[0] : null;
};
