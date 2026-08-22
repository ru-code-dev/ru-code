// ru-code: pure changelog parse + accumulation (W28). Proves the defensive parser (garbage
// skipped, never fatal) and the accumulation policy: strictly-newer, newest-first, capped +
// truncation flag. Output must stay structurally assignable to the contracts wire types.

import type { ChangelogVersionWire } from "@t3tools/contracts";

import { describe, expect, it } from "@effect/vitest";

import { accumulateChangelog, parseChangelog } from "../../auto-update/changelog.ts";

describe("parseChangelog", () => {
  it("parses plain-string and typed entries; unknown kinds decay to null", () => {
    const parsed = parseChangelog(
      JSON.stringify({
        "1.4.2": [
          "plain string entry",
          { kind: "fix", text: "fixed a thing" },
          { kind: "feat", text: "new thing" },
          { kind: "wat", text: "unknown kind decays" },
        ],
      }),
    );
    expect(parsed).toEqual([
      {
        version: "1.4.2",
        notes: [
          { kind: null, text: "plain string entry" },
          { kind: "fix", text: "fixed a thing" },
          { kind: "feat", text: "new thing" },
          { kind: null, text: "unknown kind decays" },
        ],
      },
    ]);
  });

  it("skips garbage entries but keeps the rest of a version's notes", () => {
    const parsed = parseChangelog(
      JSON.stringify({
        "1.0.0": [
          "good",
          42,
          null,
          { kind: "fix" },
          { kind: "fix", text: 7 },
          { text: "no kind is fine" },
        ],
      }),
    );
    expect(parsed).toEqual([
      {
        version: "1.0.0",
        notes: [
          { kind: null, text: "good" },
          { kind: null, text: "no kind is fine" },
        ],
      },
    ]);
  });

  it("skips versions whose value is not an array, and invalid-semver keys", () => {
    const parsed = parseChangelog(
      JSON.stringify({
        "1.2.0": ["kept"],
        "2.0.0": "not an array",
        latest: ["invalid semver key"],
        "not.a.version": ["also skipped"],
      }),
    );
    expect(parsed).toEqual([{ version: "1.2.0", notes: [{ kind: null, text: "kept" }] }]);
  });

  it("returns [] on invalid JSON, arrays, and non-object roots", () => {
    expect(parseChangelog("{not json")).toEqual([]);
    expect(parseChangelog("[]")).toEqual([]);
    expect(parseChangelog("null")).toEqual([]);
    expect(parseChangelog("42")).toEqual([]);
  });
});

describe("accumulateChangelog", () => {
  const sample = parseChangelog(
    JSON.stringify({
      "1.4.0": [{ kind: "feat", text: "v1.4.0" }],
      "1.4.2": [{ kind: "fix", text: "v1.4.2" }],
      "1.4.1": [{ kind: "perf", text: "v1.4.1" }],
      "1.3.0": [{ kind: "ui", text: "old, filtered out" }],
    }),
  );

  it("keeps only strictly-newer versions, newest-first", () => {
    const result = accumulateChangelog(sample, "1.4.0");
    expect(result.versions.map((v) => v.version)).toEqual(["1.4.2", "1.4.1"]);
    expect(result.truncated).toBe(false);
  });

  it("excludes the current version itself (strictly newer)", () => {
    const result = accumulateChangelog(sample, "1.4.2");
    expect(result.versions).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("caps at `cap` versions and flags truncation", () => {
    const many = parseChangelog(
      JSON.stringify({
        "1.0.1": [{ kind: "fix", text: "a" }],
        "1.0.2": [{ kind: "fix", text: "b" }],
        "1.0.3": [{ kind: "fix", text: "c" }],
        "1.0.4": [{ kind: "fix", text: "d" }],
      }),
    );
    const result = accumulateChangelog(many, "1.0.0", 2);
    expect(result.versions.map((v) => v.version)).toEqual(["1.0.4", "1.0.3"]);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation at exactly the cap", () => {
    const result = accumulateChangelog(sample, "1.4.0", 2);
    expect(result.versions.map((v) => v.version)).toEqual(["1.4.2", "1.4.1"]);
    expect(result.truncated).toBe(false);
  });

  it("produces output assignable to the contracts wire type", () => {
    const result = accumulateChangelog(sample, "1.4.0");
    const asWire: ReadonlyArray<ChangelogVersionWire> = result.versions;
    expect(asWire[0]?.notes[0]?.text).toBe("v1.4.2");
  });
});
