// ru-fork: improvements-branch-3 #4 — RED test for encrypting secrets at rest. Today the
// ServerSecretStore writes plaintext bytes to `${secretsDir}/<name>.bin`; the fix encrypts them
// (scrypt + AES-GCM). This asserts the on-disk bytes are NOT the plaintext. No production logic touched.

import { afterEach, describe, expect, it } from "vitest";

import { makeDeciderSystem } from "./branch3Helpers.ts";

describe("branch-3 #4 — secrets encrypted at rest", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("does NOT store a secret as plaintext on disk (RED until encrypted)", async () => {
    system = makeDeciderSystem();
    const plaintext = "super-secret-token-value-9c1f";
    const name = "branch3-at-rest";
    await system.secretSet(name, new TextEncoder().encode(plaintext));
    const onDisk = new TextDecoder().decode(await system.readRawSecretBytes(name));
    expect(onDisk).not.toBe(plaintext);
    expect(onDisk).not.toContain(plaintext);
  });
});
