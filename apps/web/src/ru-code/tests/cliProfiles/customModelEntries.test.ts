// ru-code: the provider card's custom-model persistence logic for qwen's object
// shape `{ slug, authMethod }` — reading either shape, reconciling a remove/reorder
// (which arrives as slugs) WITHOUT losing each survivor's auth method, and appending
// a new model with its chosen method. These back updateCustomModels /
// addCustomModelWithAuth on the card; pinning them here proves auth isn't dropped.
import { describe, expect, it } from "vite-plus/test";

import {
  appendCustomModelEntry,
  readCustomModelEntries,
  readDefaultAuthMethod,
  reconcileCustomModelEntries,
} from "../../cliProfiles/customModelEntries";

describe("readCustomModelEntries — tolerate both shapes", () => {
  it("reads qwen's { slug, authMethod } objects", () => {
    expect(
      readCustomModelEntries({
        customModels: [
          { slug: "a", authMethod: "openai" },
          { slug: "b", authMethod: "" },
        ],
      }),
    ).toEqual([
      { slug: "a", authMethod: "openai" },
      { slug: "b", authMethod: "" },
    ]);
  });

  it("reads plain slug strings (other drivers) as authMethod ''", () => {
    expect(readCustomModelEntries({ customModels: ["x", "y"] })).toEqual([
      { slug: "x", authMethod: "" },
      { slug: "y", authMethod: "" },
    ]);
  });

  it("ignores malformed entries and non-object config", () => {
    expect(readCustomModelEntries({ customModels: [42, { authMethod: "openai" }, null] })).toEqual(
      [],
    );
    expect(readCustomModelEntries(null)).toEqual([]);
    expect(readCustomModelEntries({})).toEqual([]);
  });
});

describe("readDefaultAuthMethod", () => {
  it("reads the stored override, or '' (Auto) when unset/non-string", () => {
    expect(readDefaultAuthMethod({ defaultAuthMethod: "qwen-oauth" })).toBe("qwen-oauth");
    expect(readDefaultAuthMethod({})).toBe("");
    expect(readDefaultAuthMethod({ defaultAuthMethod: 5 })).toBe("");
    expect(readDefaultAuthMethod(null)).toBe("");
  });
});

describe("reconcileCustomModelEntries — remove/reorder preserves auth", () => {
  const entries = [
    { slug: "a", authMethod: "openai" },
    { slug: "b", authMethod: "anthropic" },
    { slug: "c", authMethod: "" },
  ];

  it("removing a slug keeps the survivors' auth methods", () => {
    expect(reconcileCustomModelEntries(entries, ["a", "c"])).toEqual([
      { slug: "a", authMethod: "openai" },
      { slug: "c", authMethod: "" },
    ]);
  });

  it("reordering preserves each slug's auth method", () => {
    expect(reconcileCustomModelEntries(entries, ["b", "a"])).toEqual([
      { slug: "b", authMethod: "anthropic" },
      { slug: "a", authMethod: "openai" },
    ]);
  });

  it("a slug with no prior entry defaults to '' (⇒ instance default on the server)", () => {
    expect(reconcileCustomModelEntries(entries, ["a", "new"])).toEqual([
      { slug: "a", authMethod: "openai" },
      { slug: "new", authMethod: "" },
    ]);
  });
});

describe("appendCustomModelEntry", () => {
  it("appends a new model with its auth method", () => {
    expect(appendCustomModelEntry([{ slug: "a", authMethod: "openai" }], "b", "anthropic")).toEqual(
      [
        { slug: "a", authMethod: "openai" },
        { slug: "b", authMethod: "anthropic" },
      ],
    );
  });

  it("replaces (dedupes) an existing slug rather than duplicating it", () => {
    expect(appendCustomModelEntry([{ slug: "a", authMethod: "openai" }], "a", "gemini")).toEqual([
      { slug: "a", authMethod: "gemini" },
    ]);
  });
});
