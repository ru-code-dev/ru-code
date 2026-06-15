import { describe, expect, it } from "vitest";

import { generateDesignerId } from "../src/ui/key.ts";

describe("generateDesignerId", () => {
  it("produces a dz_-prefixed uuid", () => {
    const id = generateDesignerId();
    expect(id).toMatch(
      /^dz_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("produces distinct ids", () => {
    expect(generateDesignerId()).not.toBe(generateDesignerId());
  });
});
