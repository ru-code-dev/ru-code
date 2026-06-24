// ru-fork: spec for the legacy-plaintext AUTOHEAL of ServerSecretStore.
//
// Problem: ru-fork #4 added at-rest encryption (`decryptSecret`) to the WHOLE secret store, but
// `server-signing-key` predates it and shipped as RAW plaintext. On an upgrading machine `get()` now
// throws "Invalid encrypted secret format" (the 3-part `iv:tag:cipher` split fails), and because
// `getOrCreateRandom` calls `get()` first, it never reaches its regenerate path ⇒ the server can't boot.
//
// Fix: `get()` must treat an UNPARSEABLE / legacy blob as ABSENT (null) so the key self-heals
// (regenerated encrypted; only sessions reset). BUT it must do so ONLY for the *format* failure — a
// VALID-format blob that fails GCM authentication (tampered / wrong host-key / a real MCP credential
// that can't be unwrapped) must STILL error, never silently vanish.
//
// Test map:
//   #1, #2  RED now → GREEN after the fix   (legacy plaintext ⇒ null / autoheal)
//   #3      GREEN now and after             (proper round-trip still works — no regression)
//   #4      GREEN now; stays GREEN ONLY for the SCOPED fix; a blanket `orElseSucceed(null)` turns it
//           RED — this is the guardrail that forces "swallow the format error, not the GCM error."

import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../../src/config.ts";
import { encryptSecret } from "../../../src/auth/secretCrypto.ts";
import { SecretStoreError, ServerSecretStore } from "../../../src/auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../../../src/auth/Layers/ServerSecretStore.ts";

// ServerConfig is provideMerge'd so the test body can read `secretsDir` (to plant a raw .bin file) AND
// resolve the SAME store — a fresh `{prefix}` temp dir is minted once and shared by both.
const makeSharedLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-autoheal-test-" })),
  );

// A pre-encryption key on disk: raw bytes with NO 0x3a (":"), so the `iv:tag:cipher` split yields one
// part ⇒ `decryptSecret` throws the FORMAT error (not a GCM error). Mirrors a real legacy signing key.
const LEGACY_PLAINTEXT_KEY = new Uint8Array(32).fill(7);

// A VALID-format blob whose ciphertext has been flipped ⇒ GCM authentication fails at decrypt time.
// Stands in for a tampered file / wrong-host key / an MCP credential that genuinely can't be unwrapped.
function makeTamperedEncryptedBlob(): Uint8Array {
  const text = new TextDecoder().decode(encryptSecret(Uint8Array.from([9, 8, 7, 6, 5])));
  const [ivHex, tagHex, cipherHex] = text.split(":");
  const lastChar = cipherHex!.at(-1);
  const flippedCipher = cipherHex!.slice(0, -1) + (lastChar === "a" ? "b" : "a");
  return new TextEncoder().encode(`${ivHex}:${tagHex}:${flippedCipher}`);
}

const plantSecretFile = (name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
    yield* fileSystem.writeFile(join(config.secretsDir, `${name}.bin`), bytes);
  });

it.layer(NodeServices.layer)("ServerSecretStore autoheal (legacy plaintext)", (it) => {
  it.effect("#1 RED→GREEN: get() returns null for a legacy plaintext (unparseable) secret file", () =>
    Effect.gen(function* () {
      yield* plantSecretFile("server-signing-key", LEGACY_PLAINTEXT_KEY);
      const secretStore = yield* ServerSecretStore;

      // Today this THROWS SecretStoreError("Invalid encrypted secret format") ⇒ test fails.
      // After the fix it must read the legacy blob as "absent".
      const result = yield* secretStore.get("server-signing-key");
      expect(result).toBeNull();
    }).pipe(Effect.provide(makeSharedLayer())),
  );

  it.effect("#2 RED→GREEN: getOrCreateRandom self-heals over a legacy plaintext signing key", () =>
    Effect.gen(function* () {
      yield* plantSecretFile("server-signing-key", LEGACY_PLAINTEXT_KEY);
      const secretStore = yield* ServerSecretStore;

      // Must succeed by minting a FRESH encrypted key (not crash on the legacy blob).
      const key = yield* secretStore.getOrCreateRandom("server-signing-key", 32);
      expect(key.length).toBe(32);
      expect(Array.from(key)).not.toEqual(Array.from(LEGACY_PLAINTEXT_KEY)); // a new key, not the legacy bytes

      // The regenerated key is now persisted encrypted-at-rest and reads back identically + stably.
      const reread = yield* secretStore.get("server-signing-key");
      expect(reread).not.toBeNull();
      expect(Array.from(reread ?? new Uint8Array())).toEqual(Array.from(key));
      const again = yield* secretStore.getOrCreateRandom("server-signing-key", 32);
      expect(Array.from(again)).toEqual(Array.from(key)); // healed once, then stable
    }).pipe(Effect.provide(makeSharedLayer())),
  );

  it.effect("#3 GUARDRAIL (no regression): a properly encrypted secret still round-trips", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore;
      const value = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

      yield* secretStore.set("mcp-credential-good", value);
      const roundTripped = yield* secretStore.get("mcp-credential-good");

      expect(roundTripped).not.toBeNull();
      expect(Array.from(roundTripped ?? new Uint8Array())).toEqual(Array.from(value));
    }).pipe(Effect.provide(makeSharedLayer())),
  );

  it.effect("#4 GUARDRAIL (scoped fix): a tampered/wrong-key (GCM auth) secret STILL errors, never null", () =>
    Effect.gen(function* () {
      yield* plantSecretFile("mcp-credential", makeTamperedEncryptedBlob());
      const secretStore = yield* ServerSecretStore;

      // Valid `iv:tag:cipher` shape but the GCM tag no longer matches ⇒ this is NOT the format error.
      // It must surface as a typed failure — a blanket swallow-to-null would silently drop a real
      // MCP credential, which this test forbids.
      const error = yield* Effect.flip(secretStore.get("mcp-credential"));
      expect(error).toBeInstanceOf(SecretStoreError);
      expect(error.message).toContain("Failed to decrypt secret mcp-credential");
    }).pipe(Effect.provide(makeSharedLayer())),
  );

  // ru-fork: VDI/Citrix migration self-heal for the REGENERABLE signing key.
  // ru-fork #4 bound the at-rest key to hostname+username. On non-persistent Citrix the user profile
  // (and this .bin) roams onto a DIFFERENT pooled hostname each logon ⇒ a VALID-format blob that fails
  // GCM auth ⇒ boot crashed with "Failed to decrypt secret server-signing-key". Now the salt is username
  // ONLY (roams with the profile), and any EXISTING hostname-bound blob — un-authenticatable under the
  // new key — must SELF-HEAL: the signing key is regenerable (loss only resets sessions), so a GCM
  // failure is treated as ABSENT and re-minted. A tampered blob stands in for that stale wrong-host file.
  // The contrast with #4 (same shape, mcp name ⇒ STILL errors) is the guardrail: the heal is scoped to
  // the regenerable signing key, NOT a blanket swallow that would silently drop a real MCP credential.
  it.effect("#5 RED→GREEN: get() heals a GCM-unauthenticatable signing-key blob to null", () =>
    Effect.gen(function* () {
      yield* plantSecretFile("server-signing-key", makeTamperedEncryptedBlob());
      const secretStore = yield* ServerSecretStore;

      // Today this THROWS SecretStoreError (GCM auth). After the fix the regenerable signing key reads
      // as absent so getOrCreateRandom can re-mint it.
      const result = yield* secretStore.get("server-signing-key");
      expect(result).toBeNull();
    }).pipe(Effect.provide(makeSharedLayer())),
  );

  it.effect("#6 RED→GREEN: getOrCreateRandom() self-heals over a stale (wrong-host) signing key", () =>
    Effect.gen(function* () {
      yield* plantSecretFile("server-signing-key", makeTamperedEncryptedBlob());
      const secretStore = yield* ServerSecretStore;

      const key = yield* secretStore.getOrCreateRandom("server-signing-key", 32);
      expect(key.length).toBe(32);

      // Re-minted, persisted encrypted-at-rest under the new key, and stable on re-read.
      const reread = yield* secretStore.get("server-signing-key");
      expect(reread).not.toBeNull();
      expect(Array.from(reread ?? new Uint8Array())).toEqual(Array.from(key));
      const again = yield* secretStore.getOrCreateRandom("server-signing-key", 32);
      expect(Array.from(again)).toEqual(Array.from(key)); // healed once, then stable
    }).pipe(Effect.provide(makeSharedLayer())),
  );
});
