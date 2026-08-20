// ru-code: improvements-branch-3 #4 — MCP var secrets are encrypted at rest. The cipher is a
// PACKAGE guarantee (McpSecrets.writeMcpSecret/readMcpSecret, above the McpManagerSecretStore
// port; the host adapter and upstream ServerSecretStore stay plain byte stores) — a deliberate
// scope decision: only MCP secrets are ours to protect. The cipher unit contract is pinned in
// the package suite (tests/secretCrypto.test.ts); THESE tests prove the wired host path — the
// package helpers riding the REAL adapter over the real on-disk store:
//   1. the on-disk bytes are ciphertext (never the plaintext),
//   2. the round-trip returns the original bytes,
//   3. a blob that fails to decode/authenticate surfaces as an ERROR — a credential is never
//      silently dropped (MCP never shipped, so there is no legacy plaintext to self-heal).

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeDeciderSystem } from "./branch3Helpers.ts";

describe("branch-3 #4 — MCP secrets encrypted at rest (port adapter)", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("does NOT store a secret as plaintext on disk", async () => {
    system = makeDeciderSystem();
    const plaintext = "super-secret-token-value-9c1f";
    const name = "branch3-at-rest";
    await system.secretSet(name, new TextEncoder().encode(plaintext));
    const onDisk = new TextDecoder().decode(await system.readRawSecretBytes(name));
    expect(onDisk).not.toBe(plaintext);
    expect(onDisk).not.toContain(plaintext);
  });

  it("round-trips: get returns the exact bytes set", async () => {
    system = makeDeciderSystem();
    const plaintext = "round-trip-value-тест";
    const name = "branch3-round-trip";
    await system.secretSet(name, new TextEncoder().encode(plaintext));
    const back = await system.secretGet(name);
    expect(back).not.toBeNull();
    expect(new TextDecoder().decode(back!)).toBe(plaintext);
  });

  it("a corrupt/undecryptable blob ERRORS on get — never silently absent", async () => {
    system = makeDeciderSystem();
    const name = "branch3-corrupt";
    // Seed raw bytes that are not our `ivHex:authTagHex:cipherHex` blob (bypasses the cipher).
    await system.secretSetRaw(name, new TextEncoder().encode("not-an-encrypted-blob"));
    await expect(system.secretGet(name)).rejects.toThrow();
  });

  it("a missing secret is null (absent), not an error", async () => {
    system = makeDeciderSystem();
    expect(await system.secretGet("branch3-never-written")).toBeNull();
  });
});
