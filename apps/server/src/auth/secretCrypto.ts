// ru-fork #4: at-rest encryption for the ServerSecretStore `.bin` files. Mirrors qwen-code 0.13.1's
// headless file scheme (file-token-storage.ts): scrypt(host+user) → aes-256-gcm, format
// `ivHex:authTagHex:cipherHex`. Host+user-derived key matches qwen's threat model (protects a
// copied-off-host file, not a local same-user attacker). The MCP feature has never shipped, so there
// is no legacy plaintext to migrate.
import * as Crypto from "node:crypto";
import * as os from "node:os";

const deriveKey = (): Buffer => {
  const salt = `${os.hostname()}-${os.userInfo().username}-qwen-code`;
  return Crypto.scryptSync("qwen-code-oauth", salt, 32);
};

// Derived once per process (scrypt is intentionally slow); host/user don't change at runtime.
const KEY = deriveKey();

export function encryptSecret(plaintext: Uint8Array): Uint8Array {
  const iv = Crypto.randomBytes(16);
  const cipher = Crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  return new TextEncoder().encode(blob);
}

// ru-fork #4: a blob that isn't our `ivHex:authTagHex:cipherHex` shape — i.e. a LEGACY plaintext secret
// written BEFORE at-rest encryption existed (e.g. a `server-signing-key` from an older build). Kept
// distinct from a GCM auth failure (tampered / wrong host-key) so the store can self-heal a legacy key
// by treating it as absent WITHOUT silently dropping a real encrypted secret that fails to authenticate.
export const LEGACY_SECRET_FORMAT_ERROR = "Invalid encrypted secret format";

export const isLegacySecretFormatError = (cause: unknown): boolean =>
  cause instanceof Error && cause.message === LEGACY_SECRET_FORMAT_ERROR;

export function decryptSecret(blob: Uint8Array): Uint8Array {
  const parts = new TextDecoder().decode(blob).split(":");
  if (parts.length !== 3) {
    throw new Error(LEGACY_SECRET_FORMAT_ERROR);
  }
  const iv = Buffer.from(parts[0]!, "hex");
  const authTag = Buffer.from(parts[1]!, "hex");
  const decipher = Crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(authTag);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(parts[2]!, "hex")), decipher.final()]));
}
