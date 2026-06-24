// ru-fork #4: at-rest encryption for the ServerSecretStore `.bin` files. Mirrors qwen-code 0.13.1's
// headless file scheme (file-token-storage.ts): scrypt(user) → aes-256-gcm, format
// `ivHex:authTagHex:cipherHex`. The user-derived key matches qwen's threat model (protects a
// copied-off-host file, not a local same-user attacker). The MCP feature has never shipped, so there
// is no legacy plaintext to migrate.
//
// ru-fork: the salt was originally `host+user`, but `os.hostname()` is UNSTABLE on non-persistent
// Citrix/VDI — the roaming profile (and these `.bin` files) lands on a different pooled host each logon,
// so a prior secret no longer authenticates (GCM failure) and the server crashed on boot. `username`
// roams WITH the profile and is stable across pooled hosts, so the salt is now username-only. An
// existing host-bound blob can't be unwrapped under the new key; the regenerable signing key self-heals
// over it (see `isRegenerableSecret` + ServerSecretStore.get).
import * as Crypto from "node:crypto";
import * as os from "node:os";

export const deriveKey = (username: string): Buffer =>
  Crypto.scryptSync("qwen-code-oauth", `${username}-qwen-code`, 32);

// Derived once per process (scrypt is intentionally slow); the login user doesn't change at runtime.
const KEY = deriveKey(os.userInfo().username);

// ru-fork: a secret that is safe to discard-and-regenerate — losing it only invalidates existing
// sessions (users re-login), unlike an MCP/OAuth credential which must NEVER silently vanish. Only these
// may self-heal over a GCM-auth failure (e.g. a host-bound blob left by the pre-username-salt build, or
// a wrong-host VDI file); every other secret keeps erroring so a real credential is never dropped.
export const isRegenerableSecret = (name: string): boolean => name.endsWith("signing-key");

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
