// ru-code: `ModelSelection.model` allows "" ("not selected" — the live resolver
// owns the default; nothing is seeded). Old persisted data must keep decoding:
// non-empty selections verbatim, rollout-era `{provider, model}` promoted.
import { describe, expect, it } from "vite-plus/test";
import { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(ModelSelection);
const encode = Schema.encodeSync(ModelSelection);

describe("ModelSelection — empty model ('not selected')", () => {
  it("decodes an empty model", () => {
    const decoded = decode({ instanceId: "qwen", model: "" });
    expect(decoded.instanceId).toBe("qwen");
    expect(decoded.model).toBe("");
  });

  it("trims whitespace-only to empty", () => {
    expect(decode({ instanceId: "qwen", model: "   " }).model).toBe("");
  });

  it("round-trips an empty model through encode", () => {
    const encoded = encode(decode({ instanceId: "qwen", model: "" }));
    expect(encoded).toMatchObject({ instanceId: "qwen", model: "" });
  });

  it("old persisted non-empty selections decode unchanged", () => {
    const decoded = decode({ instanceId: "qwen", model: "qwen3-coder-plus" });
    expect(decoded.model).toBe("qwen3-coder-plus");
  });

  it("legacy {provider, model} payloads still promote to instanceId", () => {
    const decoded = decode({ provider: "qwen", model: "legacy-model" });
    expect(decoded.instanceId).toBe("qwen");
    expect(decoded.model).toBe("legacy-model");
  });
});
