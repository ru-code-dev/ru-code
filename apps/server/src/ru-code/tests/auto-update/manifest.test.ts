// ru-code: pure manifest parse + semver comparison (schema v2, latest-only). No I/O — the
// classification the checker leans on: corrupt/old-shaped/missing-required manifest → null;
// defensive null-tolerance of sizeBytes/releasedAt; required minNode; and newer/older/equal
// ordering incl. prerelease + v-prefix.

import { describe, expect, it } from "@effect/vitest";

import {
  compareSemver,
  isNewer,
  isValidVersion,
  parseManifest,
  satisfiesMinNode,
} from "../../auto-update/manifest.ts";

describe("parseManifest", () => {
  it("parses a well-formed latest-only v2 manifest", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: "1.4.2",
        sha256: "a".repeat(64),
        sizeBytes: 12345,
        releasedAt: "2026-07-23T00:00:00Z",
        minNode: ">=22",
      }),
    );
    expect(parsed).toEqual({
      version: "1.4.2",
      sha256: "a".repeat(64),
      sizeBytes: 12345,
      releasedAt: "2026-07-23T00:00:00Z",
      minNode: ">=22",
      signature: null,
    });
  });

  it("has no rollbackSafe field on the parsed result (v2 dropped it)", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: "1.0.0",
        sha256: "c".repeat(64),
        minNode: ">=20",
        // A stray rollbackSafe on the wire is ignored — the schema no longer carries it.
        rollbackSafe: true,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("rollbackSafe");
  });

  it("trims version / sha256 / minNode", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: " 2.0.0 ",
        sha256: ` ${"b".repeat(64)} `,
        minNode: " ^22.16 || >=24.10 ",
      }),
    );
    expect(parsed?.version).toBe("2.0.0");
    expect(parsed?.sha256).toBe("b".repeat(64));
    expect(parsed?.minNode).toBe("^22.16 || >=24.10");
  });

  // G25: the tarball is the manifest's sibling and its name is a convention, so the manifest
  // carries no address at all. A release published by an OLDER prepare-release still parses —
  // the retired field is simply not read.
  it("ignores a legacy tarballUrl field instead of rejecting the manifest", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: "3.0.0",
        sha256: "d".repeat(64),
        minNode: ">=20",
        tarballUrl: "https://example.com/ru-code-3.0.0.tgz",
      }),
    );
    expect(parsed?.version).toBe("3.0.0");
    expect(parsed).not.toHaveProperty("tarballUrl");
  });

  // …and a manifest that never had the field is equally valid: it is not required any more.
  it("accepts a manifest with no tarballUrl at all", () => {
    const parsed = parseManifest(
      JSON.stringify({ version: "3.1.0", sha256: "e".repeat(64), minNode: ">=20" }),
    );
    expect(parsed?.version).toBe("3.1.0");
  });

  it("is null-tolerant for sizeBytes / releasedAt (old persisted manifests never crash)", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: "1.0.0",
        sha256: "c".repeat(64),
        minNode: ">=20",
      }),
    );
    expect(parsed?.sizeBytes).toBeNull();
    expect(parsed?.releasedAt).toBeNull();
  });

  it("coerces non-number sizeBytes and blank releasedAt to null", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: "1.0.0",
        sha256: "c".repeat(64),
        minNode: ">=20",
        sizeBytes: "not-a-number",
        releasedAt: "   ",
      }),
    );
    expect(parsed?.sizeBytes).toBeNull();
    expect(parsed?.releasedAt).toBeNull();
  });

  it("REJECTS a manifest missing the required minNode field", () => {
    expect(
      parseManifest(
        JSON.stringify({
          version: "1.0.0",
          sha256: "c".repeat(64),
        }),
      ),
    ).toBeNull();
    // Blank / non-string minNode is also rejected.
    expect(
      parseManifest(
        JSON.stringify({
          version: "1.0.0",
          sha256: "c".repeat(64),
          minNode: "   ",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for invalid JSON, non-objects, and missing/blank required fields", () => {
    expect(parseManifest("{not json")).toBeNull();
    expect(parseManifest("null")).toBeNull();
    expect(parseManifest("42")).toBeNull();
    expect(parseManifest(JSON.stringify({ sha256: "x", minNode: ">=20" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: "", sha256: "x", minNode: ">=20" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: "1.0.0", minNode: ">=20" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 5, sha256: "x", minNode: ">=20" }))).toBeNull();
  });
});

describe("compareSemver / isNewer / isValidVersion", () => {
  it("orders release versions numerically, not lexically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("2.0.0", "10.0.0")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("ranks a release above its prerelease and orders prerelease identifiers", () => {
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
  });

  it("strips a leading v and ignores build metadata", () => {
    expect(compareSemver("v1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("1.2.0+build.9", "1.2.0")).toBe(0);
  });

  it("treats unparseable versions as not-newer (equal)", () => {
    expect(compareSemver("garbage", "1.0.0")).toBe(0);
    expect(isNewer("garbage", "1.0.0")).toBe(false);
  });

  it("isNewer is strict", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });

  it("isValidVersion accepts semver, rejects garbage", () => {
    expect(isValidVersion("1.4.2")).toBe(true);
    expect(isValidVersion("v2.0.0-rc.1")).toBe(true);
    expect(isValidVersion("latest")).toBe(false);
    expect(isValidVersion("")).toBe(false);
  });
});

describe("satisfiesMinNode", () => {
  it("passes when the running major meets the requirement", () => {
    expect(satisfiesMinNode(">=20", "22.16.0")).toBe(true);
    expect(satisfiesMinNode(">=22", "v22.0.1")).toBe(true);
  });
  it("fails when the running major is below the requirement", () => {
    expect(satisfiesMinNode(">=99", "22.16.0")).toBe(false);
  });
  it("never blocks on unparseable inputs (lenient, mirrors the wrapper)", () => {
    expect(satisfiesMinNode("latest", "22.16.0")).toBe(true);
    expect(satisfiesMinNode(">=20", "weird")).toBe(true);
  });
});
