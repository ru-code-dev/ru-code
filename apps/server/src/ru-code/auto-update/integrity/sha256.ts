// ru-code: sha256 helpers for update integrity (B8). Pure sync functions the Effect layer wraps.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";

/** Lowercase hex sha256 of the given bytes. */
export const sha256Hex = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Constant-time check that `bytes` hash to `expectedHex`. Returns false on any length/format
 * mismatch rather than throwing, so a bad digest is a clean "verify failed", never a crash.
 */
export const verifySha256 = (bytes: Uint8Array, expectedHex: string): boolean => {
  const expected = expectedHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const actual = Buffer.from(sha256Hex(bytes), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && NodeCrypto.timingSafeEqual(actual, wanted);
};
