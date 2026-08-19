// ru-code: coverage for the server bootstrap default model selection — the single-source
// default instance with model "" ("not selected"); the live resolver owns the model default.
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PROVIDER_INSTANCE_ID } from "@ru-code/branding";
import { getAutoBootstrapDefaultModelSelection } from "../../../serverRuntimeStartup.ts";

describe("getAutoBootstrapDefaultModelSelection", () => {
  it("uses the single-source default instance with an unseeded (empty) model", () => {
    const sel = getAutoBootstrapDefaultModelSelection();
    expect(sel.instanceId).toBe(DEFAULT_PROVIDER_INSTANCE_ID);
    expect(sel.model).toBe("");
  });
});
