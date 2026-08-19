// ru-code: pin the `autoCompactContext` settings contract. The server-side
// auto-compaction (hidden `/compress` at ≥75% context) must default ON — old
// persisted settings objects without the key decode to `true` — and an explicit
// opt-out must round-trip through encode/decode unchanged.
import { describe, expect, it } from "vite-plus/test";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(ServerSettings);
const encode = Schema.encodeSync(ServerSettings);

describe("ServerSettings.autoCompactContext — ru-code schema delta", () => {
  it("defaults to true when the key is absent", () => {
    expect(decode({}).autoCompactContext).toBe(true);
  });

  it("decodes an explicit false", () => {
    expect(decode({ autoCompactContext: false }).autoCompactContext).toBe(false);
  });

  it("round-trips false through encode/decode", () => {
    const roundTripped = decode(encode(decode({ autoCompactContext: false })));
    expect(roundTripped.autoCompactContext).toBe(false);
  });
});
