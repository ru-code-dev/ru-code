// ru-code: at-rest encryption for stored update credentials (D1). AES-256-GCM with a PLUGGABLE key
// source; the default key derives from the OS username via scrypt. This is OBFUSCATION, not
// security: it protects a credentials file copied off-host, but a local same-user process can
// re-derive the key. The user accepted this for v1 with honest labeling. A keychain-backed key
// source can be swapped in later with no schema change. Blob format: `ivHex:authTagHex:cipherHex`
// (UTF-8 encoded bytes).
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

// 12-byte IV = the GCM standard nonce size. The blob carries its own IV, so older
// blobs written with a different IV length still decrypt.
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Pluggable key source. `derive` returns a 32-byte key. */
export interface CredentialKeySource {
  readonly derive: () => Buffer;
}

/**
 * Default key source: scrypt over the OS username (roams with the profile; not host-bound). This is
 * an obfuscation key, not a secret-grade one — see the file header.
 *
 * Derived ONCE per process and kept. scrypt is deliberately expensive and fully SYNCHRONOUS, and
 * `derive()` sits on every credential read and write — which means every scheduled tick, every
 * probe and every install re-resolve, in a server that is simultaneously proxying WebSocket chat
 * traffic and CLI children. The input (the OS username) cannot change inside a process, so
 * re-deriving produced the identical 32 bytes every time; caching it changes nothing but the
 * stall. Cached in a module-scoped variable rather than at construction so every existing
 * `usernameScryptKeySource` reference keeps working unchanged.
 */
let cachedUsernameKey: Buffer | null = null;
export const usernameScryptKeySource: CredentialKeySource = {
  derive: () => {
    cachedUsernameKey ??= NodeCrypto.scryptSync(
      "ru-code-update",
      `${NodeOS.userInfo().username}-ru-code-update`,
      KEY_BYTES,
    );
    return cachedUsernameKey;
  },
};

/** Encrypt plaintext bytes into the `iv:tag:cipher` blob (returned as UTF-8 bytes). */
export const encryptCredential = (
  plaintext: Uint8Array,
  keySource: CredentialKeySource,
): Uint8Array => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", keySource.derive(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  return new TextEncoder().encode(blob);
};

/** Decrypt an `iv:tag:cipher` blob. Throws on tamper / wrong key / malformed input. */
export const decryptCredential = (blob: Uint8Array, keySource: CredentialKeySource): Uint8Array => {
  const text = new TextDecoder().decode(blob);
  const parts = text.split(":");
  if (parts.length !== 3) throw new Error("malformed credential blob");
  const [ivHex, tagHex, cipherHex] = parts;
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    keySource.derive(),
    Buffer.from(ivHex ?? "", "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex ?? "", "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex ?? "", "hex")),
    decipher.final(),
  ]);
  return new Uint8Array(decrypted);
};
