// ru-code: the QWEN_MODELS_AUTO_DISCOVERY kill-switch's serving half. With the
// flag off, serveQwenModels must ignore a NON-EMPTY discovered store wholesale
// (a previously persisted set may still exist on disk) — profile + custom
// models only. Own file because the flag is a module constant: it is flipped
// via vi.mock at module scope, which would poison the flag-on suite next door.
import { describe, expect, it, vi } from "vite-plus/test";
import { QwenSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

vi.mock("@ru-code/qwen/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ru-code/qwen/constants")>();
  return { ...actual, QWEN_MODELS_AUTO_DISCOVERY: false };
});

import { serveQwenModels } from "../../../qwen/discovery/serveQwenModels.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

const DISCOVERED = [
  {
    slug: "giga/coder-xl-256k",
    authMethod: "openai",
    name: "Giga Coder Xl 256K",
    nTokens: 256_000,
  },
];

describe("serveQwenModels — QWEN_MODELS_AUTO_DISCOVERY = false", () => {
  it("ignores a non-empty discovered store: profile models stick", () => {
    const served = serveQwenModels(decodeQwenSettings({ profile: "custom" }), DISCOVERED);
    expect(served.map((model) => model.slug)).toEqual([
      "qwen/qwen3.6-35b-a3b",
      "qwen3-coder-flash",
    ]);
  });

  it("stock qwen (empty profile) + custom models ⇒ custom only; none ⇒ empty list (CLI-defaults mode)", () => {
    const withCustom = serveQwenModels(
      decodeQwenSettings({
        profile: "qwen",
        customModels: [{ slug: "my/custom-64k", authMethod: "openai" }],
      }),
      DISCOVERED,
    );
    expect(withCustom.map((model) => model.slug)).toEqual(["my/custom-64k"]);
    expect(withCustom[0]?.isCustom).toBe(true);

    const bare = serveQwenModels(decodeQwenSettings({ profile: "qwen" }), DISCOVERED);
    expect(bare).toEqual([]);
  });
});
