import { describe, expect, it } from "@effect/vitest";

import {
  isAtLeast,
  parseVersion,
  satisfiesRange,
} from "../../../src/ru-fork/startup/versionRange.ts";

describe("parseVersion", () => {
  it.each([
    ["v22.18.0", [22, 18, 0]],
    ["22.16.0", [22, 16, 0]],
    ["0.13.1", [0, 13, 1]],
    ["0.0.1", [0, 0, 1]],
    ["git version 2.45.1", [2, 45, 1]],
    ["git version 2.45.1.windows.1", [2, 45, 1]],
    ["cli-code v0.13.1", [0, 13, 1]],
    ["22.16", [22, 16, 0]],
  ])("parses %s → %j", (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });

  it.each([[""], ["not a version"], ["v"], ["22"]])("returns null for %s", (input) => {
    expect(parseVersion(input)).toBeNull();
  });
});

describe("isAtLeast", () => {
  it.each<[string, string, boolean]>([
    ["0.13.1", "0.13.1", true],
    ["0.13.0", "0.13.1", false],
    ["0.13.2", "0.13.1", true],
    ["0.14.0", "0.13.1", true],
    ["0.12.99", "0.13.1", false],
    ["0.0.1", "0.0.0", true],
    ["0.0.0", "0.0.1", false],
    ["0.0.1", "0.13.1", false],
    ["1.0.0", "0.13.1", true],
    ["26.5.13", "0.13.1", true],
    ["0.13.1", "26.5.13", false],
    ["26.5.13", "26.5.12", true],
    ["26.5.12", "26.5.13", false],
  ])("isAtLeast(%s, %s) === %s", (actual, minimum, expected) => {
    expect(isAtLeast(actual, minimum)).toBe(expected);
  });
});

describe("satisfiesRange against '^22.16 || ^23.11 || >=24.10'", () => {
  const RANGE = "^22.16 || ^23.11 || >=24.10";

  it.each<[string, boolean, string]>([
    ["22.15.99", false, "minor below 16 in ^22.16 arm"],
    ["22.16.0", true, "boundary of ^22.16"],
    ["22.16.99", true, "patch wildcard"],
    ["22.99.0", true, "minor unbounded in ^22.X"],
    ["23.0.0", false, "wrong major for both ^22 and ^23.11"],
    ["23.10.99", false, "minor below 11 in ^23.11 arm"],
    ["23.11.0", true, "boundary of ^23.11"],
    ["23.99.99", true, "upper end of ^23.11 arm"],
    ["24.9.0", false, "below >=24.10"],
    ["24.9.99", false, "patch doesn't help below the minor floor"],
    ["24.10.0", true, "boundary of >=24.10"],
    ["25.0.0", true, "above >=24.10"],
    ["100.0.0", true, "far above"],
    ["0.13.1", false, "far below"],
  ])("satisfiesRange(%s) === %s (%s)", (version, expected, _reason) => {
    expect(satisfiesRange(version, RANGE)).toBe(expected);
  });
});

describe("satisfiesRange returns false for unparseable input", () => {
  it("empty actual", () => {
    expect(satisfiesRange("", "^22.16")).toBe(false);
  });
  it("unparseable disjunct in range is ignored", () => {
    // Range with only a bogus disjunct → no match.
    expect(satisfiesRange("22.18.0", "garbage || nonsense")).toBe(false);
  });
});
