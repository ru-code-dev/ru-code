// ru-fork: spec for the at-rest key derivation. ru-fork #4 salted scrypt with hostname+username, which
// breaks on non-persistent Citrix/VDI: the roaming profile lands on a different pooled hostname each
// logon, so a previously-written secret no longer authenticates (GCM failure). Fix: salt with the
// USERNAME ONLY — it roams with the profile and is stable across pooled hosts. These tests pin (a) the
// cipher still round-trips and (b) the salt formula contains NO hostname, so a re-introduced hostname
// term goes RED here instead of silently re-breaking VDI.
import * as Crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptSecret, deriveKey, encryptSecret } from "../../src/auth/secretCrypto.ts";

describe("secretCrypto", () => {
  it("round-trips encrypt → decrypt (cipher unchanged)", () => {
    const plaintext = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const restored = decryptSecret(encryptSecret(plaintext));
    expect(Array.from(restored)).toEqual(Array.from(plaintext));
  });

  // The exact salt vector — username-only, hostname EXCLUDED. Any salt that re-adds os.hostname() (the
  // Citrix/VDI regression) produces different bytes and fails this. `equals` is a constant-time-ish
  // Buffer compare; here it's just byte-equality of two 32-byte scrypt outputs.
  it("derives the key from username only — salt excludes hostname", () => {
    const usernameOnly = Crypto.scryptSync("qwen-code-oauth", "16718229-qwen-code", 32);
    expect(deriveKey("16718229").equals(usernameOnly)).toBe(true);
  });

  it("is deterministic for a given username", () => {
    expect(deriveKey("16718229").equals(deriveKey("16718229"))).toBe(true);
  });

  it("still binds to the username — different users derive different keys", () => {
    expect(deriveKey("alice").equals(deriveKey("bob"))).toBe(false);
  });
});
