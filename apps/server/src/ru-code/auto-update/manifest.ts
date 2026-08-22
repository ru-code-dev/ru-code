// ru-code: pure manifest parsing + semver comparison for auto-update (schema v2, latest-only).
// No I/O, no Effect runtime — trivially unit-testable. A corrupt or old-shaped manifest
// yields `null` (a classified "unavailable"), never a throw that would wedge a check.
// @effect-diagnostics preferSchemaOverJson:off

// ── manifest schema (v2: pointer/wrapper apply, no rollback) ─────────────────────

/**
 * The latest-only release manifest served on the update channel (schema v2):
 *   { version, sha256, minNode, sizeBytes, releasedAt }
 * v2 changes vs the retired W28 shape: `rollbackSafe` is GONE (no rollback exists in the
 * pointer/wrapper apply design), and `minNode` (a semver range from the release's
 * package.json `engines.node`) is a REQUIRED field the wrapper's node-version gate reads.
 * `sizeBytes` / `releasedAt` stay null-tolerant; `version` / `sha256` / `minNode` are required.
 *
 * The manifest carries NO address. The tarball is always its sibling and its name is a
 * convention (`releaseTarballName(version)` in branding), so the web channel resolves it against the
 * manifest's own directory and the git channel as a path beside it in the repo. A manifest published
 * with the retired `tarballUrl` field still parses — the field is simply ignored.
 */
export interface Manifest {
  readonly version: string;
  readonly sha256: string;
  readonly minNode: string;
  readonly sizeBytes: number | null;
  readonly releasedAt: string | null;
  readonly signature: string | null;
}

/**
 * Parse a raw manifest JSON string defensively. Returns a typed `Manifest` or `null`
 * on any JSON / shape error (the "old error style" — a null is a clean "unavailable",
 * never a throw). Decoding is field-by-field so a partial or wrong-shaped manifest cannot
 * crash the parser: the required string fields (`version`, `sha256`, `minNode`) must be
 * present and non-blank — a manifest missing any of them is REJECTED (→ null);
 * `sizeBytes` / `releasedAt` fall back to null. Unknown fields are ignored.
 */
export const parseManifest = (text: string): Manifest | null => {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;

  const version = record["version"];
  const sha256 = record["sha256"];
  const minNode = record["minNode"];
  if (typeof version !== "string" || version.trim() === "") return null;
  if (typeof sha256 !== "string" || sha256.trim() === "") return null;
  if (typeof minNode !== "string" || minNode.trim() === "") return null;

  const sizeValue = record["sizeBytes"];
  const releasedValue = record["releasedAt"];
  const signatureValue = record["signature"];

  return {
    version: version.trim(),
    sha256: sha256.trim(),
    minNode: minNode.trim(),
    sizeBytes: typeof sizeValue === "number" && Number.isFinite(sizeValue) ? sizeValue : null,
    releasedAt:
      typeof releasedValue === "string" && releasedValue.trim() !== "" ? releasedValue : null,
    signature:
      typeof signatureValue === "string" && signatureValue.trim() !== "" ? signatureValue : null,
  };
};

// ── semver comparison ────────────────────────────────────────────────────────────

interface SemverParts {
  readonly release: ReadonlyArray<number>;
  readonly prerelease: ReadonlyArray<string>;
}

const parseSemver = (raw: string): SemverParts | null => {
  const cleaned = raw.trim().replace(/^v/i, "").split("+")[0] ?? "";
  // Split at the FIRST hyphen and keep the whole remainder: `split("-", 2)` discards everything
  // after the second one, so `1.0.0-rc-1` parsed as prerelease `rc` — making `rc-1` and `rc-2`
  // compare EQUAL, `isNewer` false, and an update between them invisible (the press is refused
  // `no-update`). Semver puts no such limit on the prerelease field.
  const hyphen = cleaned.indexOf("-");
  const core = hyphen === -1 ? cleaned : cleaned.slice(0, hyphen);
  const pre = hyphen === -1 ? undefined : cleaned.slice(hyphen + 1);
  const release = core.split(".").map((part) => Number.parseInt(part, 10));
  if (release.length === 0 || release.some((n) => Number.isNaN(n))) return null;
  return { release, prerelease: pre === undefined || pre === "" ? [] : pre.split(".") };
};

/** True when the string is a parseable semver (used to skip invalid changelog keys). */
export const isValidVersion = (raw: string): boolean => parseSemver(raw) !== null;

const compareRelease = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

const comparePrerelease = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  // A version WITHOUT prerelease outranks one WITH (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = Number.parseInt(x, 10);
    const yn = Number.parseInt(y, 10);
    const xIsNum = !Number.isNaN(xn) && String(xn) === x;
    const yIsNum = !Number.isNaN(yn) && String(yn) === y;
    if (xIsNum && yIsNum) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xIsNum !== yIsNum) {
      return xIsNum ? -1 : 1; // numeric identifiers rank lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

/** -1 if a<b, 0 if equal, 1 if a>b. Unparseable inputs compare as equal (treated as "not newer"). */
export const compareSemver = (a: string, b: string): number => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return 0;
  const releaseDiff = compareRelease(pa.release, pb.release);
  if (releaseDiff !== 0) return releaseDiff;
  return comparePrerelease(pa.prerelease, pb.prerelease);
};

/** True when `candidate` is a strictly higher semver than `current`. */
export const isNewer = (candidate: string, current: string): boolean =>
  compareSemver(candidate, current) > 0;

/**
 * True when the RUNNING node satisfies the release's `minNode` range. Minimal
 * major-only parse (mirrors the frozen wrapper's check — the two must agree):
 * the first integer in the range is the required major; an unparseable range
 * never blocks (same lenient rule as the wrapper).
 */
export const satisfiesMinNode = (minNode: string, nodeVersion: string): boolean => {
  const required = /(\d+)/.exec(minNode);
  if (required === null) return true;
  const running = /^v?(\d+)/.exec(nodeVersion);
  if (running === null) return true;
  return Number(running[1]) >= Number(required[1]);
};
