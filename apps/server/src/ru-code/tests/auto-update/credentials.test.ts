// ru-code: credential at-rest crypto (D1) + the plaintext model codec + the encrypted file store.
// Covers cipher round-trip / tamper / wrong-key, defensive decode (bad shape → absent, never a
// throw), and the file store's save→load round trip, clear, atomic overwrite, wrong-key isolation,
// and presence redaction (the password appears in NO presence object or error message).
// @effect-diagnostics preferSchemaOverJson:off

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type CredentialKeySource,
  decryptCredential,
  encryptCredential,
} from "../../auto-update/credentials/credentialCipher.ts";
import {
  CredentialStoreError,
  makeCredentialFileStore,
} from "../../auto-update/credentials/credentialFileStore.ts";
import {
  decodeCredentials,
  encodeCredentials,
} from "../../auto-update/credentials/credentialModel.ts";

const keyOf = (seed: string): CredentialKeySource => ({
  derive: () => Buffer.alloc(32, seed.charCodeAt(0)),
});

// A password that exercises quotes, spaces, `$`, and a backslash — the redaction assertions look
// for this exact literal, so any leak is caught.
const PASSWORD = 'p@ss w0rd$ "quote" \\back';

describe("credentialCipher", () => {
  const key = keyOf("A");
  const plaintext = new TextEncoder().encode("super-secret-token");

  it("round-trips through encrypt → decrypt", () => {
    const blob = encryptCredential(plaintext, key);
    expect(new TextDecoder().decode(decryptCredential(blob, key))).toBe("super-secret-token");
  });

  it("produces a fresh IV each time (ciphertext differs, plaintext recovers)", () => {
    const a = new TextDecoder().decode(encryptCredential(plaintext, key));
    const b = new TextDecoder().decode(encryptCredential(plaintext, key));
    expect(a).not.toBe(b);
  });

  it("throws on a tampered blob", () => {
    const blob = encryptCredential(plaintext, key);
    const text = new TextDecoder().decode(blob);
    const tampered = new TextEncoder().encode(text.slice(0, -2) + "ff");
    expect(() => decryptCredential(tampered, key)).toThrow();
  });

  it("throws under a different key", () => {
    const blob = encryptCredential(plaintext, key);
    expect(() => decryptCredential(blob, keyOf("B"))).toThrow();
  });

  it("throws on a malformed blob", () => {
    expect(() => decryptCredential(new TextEncoder().encode("not:a"), key)).toThrow();
  });
});

describe("credentialModel codec", () => {
  it("round-trips the full model (https + ssh + web)", () => {
    const model = {
      https: { username: "u", password: PASSWORD, savedAt: 111 },
      ssh: {
        path: "/home/me/.ssh/ru_code_update_ed25519",
        origin: "generate" as const,
        fingerprint: "SHA256:abc",
        keyType: "ed25519" as const,
        savedAt: 222,
      },
      web: { username: "web-user", password: PASSWORD, savedAt: 333 },
    };
    expect(decodeCredentials(encodeCredentials(model))).toEqual(model);
  });

  it("decodes a pre-web file with the web slot absent → null (additive backcompat)", () => {
    const decoded = decodeCredentials(
      new TextEncoder().encode(
        JSON.stringify({ https: { username: "u", password: "p", savedAt: 1 } }),
      ),
    );
    expect(decoded).toEqual({
      https: { username: "u", password: "p", savedAt: 1 },
      ssh: null,
      web: null,
    });
  });

  it("decodes each branch independently, nulling a bad one", () => {
    const decoded = decodeCredentials(
      new TextEncoder().encode(
        JSON.stringify({
          https: { username: "u" },
          ssh: { path: "/k", origin: "nope" },
          web: { username: 1 },
        }),
      ),
    );
    expect(decoded).toEqual({ https: null, ssh: null, web: null });
  });

  it("degrades a corrupt / non-JSON file to the empty model (never throws)", () => {
    expect(decodeCredentials(new TextEncoder().encode("{not json"))).toEqual({
      https: null,
      ssh: null,
      web: null,
    });
    expect(decodeCredentials(new TextEncoder().encode("null"))).toEqual({
      https: null,
      ssh: null,
      web: null,
    });
  });
});

describe("CredentialStoreError", () => {
  it("never embeds a secret in its message", () => {
    const error = new CredentialStoreError({ operation: "saveHttps" });
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).toContain("saveHttps");
  });
});

type Store = Effect.Success<ReturnType<typeof makeCredentialFileStore>>;

it.layer(NodeServices.layer)("credentialFileStore", (it) => {
  const withStore = <A, E>(
    seed: string,
    body: (input: {
      readonly store: Store;
      readonly filePath: string;
      readonly fs: FileSystem.FileSystem;
    }) => Effect.Effect<A, E, never>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-cred-" });
      const filePath = path.join(dir, "auto-update-credentials.enc");
      const store = yield* makeCredentialFileStore({ filePath, keySource: keyOf(seed) });
      return yield* body({ store, filePath, fs });
    });

  it.effect("returns the empty model when nothing is stored", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* store.load, { https: null, ssh: null, web: null });
        assert.deepStrictEqual(yield* store.presence, { https: null, ssh: null, web: null });
      }),
    ),
  );

  it.effect("round-trips an HTTPS credential through save → load", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        yield* store.saveHttps({ username: "deploy", password: PASSWORD });
        const loaded = yield* store.load;
        assert.strictEqual(loaded.https?.username, "deploy");
        assert.strictEqual(loaded.https?.password, PASSWORD);
        assert.strictEqual(typeof loaded.https?.savedAt, "number");
      }),
    ),
  );

  it.effect("round-trips an SSH credential and preserves the other branch", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        yield* store.saveHttps({ username: "deploy", password: PASSWORD });
        yield* store.saveSsh({
          path: "/home/me/.ssh/ru_code_update_ed25519",
          origin: "generate",
          fingerprint: "SHA256:xyz",
        });
        const loaded = yield* store.load;
        assert.strictEqual(loaded.https?.username, "deploy");
        assert.strictEqual(loaded.ssh?.fingerprint, "SHA256:xyz");
        assert.strictEqual(loaded.ssh?.keyType, "ed25519");
      }),
    ),
  );

  it.effect("round-trips a web basic-auth credential, independent of the git branches", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        yield* store.saveHttps({ username: "deploy", password: "git-pw" });
        yield* store.saveWeb({ username: "web-user", password: PASSWORD });
        const loaded = yield* store.load;
        assert.strictEqual(loaded.web?.username, "web-user");
        assert.strictEqual(loaded.web?.password, PASSWORD);
        assert.strictEqual(loaded.https?.username, "deploy");
        const presence = yield* store.presence;
        assert.strictEqual(presence.web?.username, "web-user");
        assert.strictEqual(JSON.stringify(presence).includes(PASSWORD), false);
        yield* store.clear("web");
        const cleared = yield* store.load;
        assert.strictEqual(cleared.web, null);
        assert.strictEqual(cleared.https?.username, "deploy");
      }),
    ),
  );

  it.effect("clears a single branch, leaving the other intact", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        yield* store.saveHttps({ username: "deploy", password: PASSWORD });
        yield* store.saveSsh({
          path: "/k",
          origin: "file",
          fingerprint: "SHA256:xyz",
        });
        yield* store.clear("https");
        const loaded = yield* store.load;
        assert.strictEqual(loaded.https, null);
        assert.strictEqual(loaded.ssh?.fingerprint, "SHA256:xyz");
      }),
    ),
  );

  it.effect("atomically overwrites the file on a repeat save", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        yield* store.saveHttps({ username: "first", password: "one" });
        yield* store.saveHttps({ username: "second", password: "two" });
        const loaded = yield* store.load;
        assert.strictEqual(loaded.https?.username, "second");
        assert.strictEqual(loaded.https?.password, "two");
      }),
    ),
  );

  it.effect("treats a wrong-key (undecryptable) file as absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-cred-" });
      const filePath = path.join(dir, "auto-update-credentials.enc");
      const writer = yield* makeCredentialFileStore({ filePath, keySource: keyOf("A") });
      yield* writer.saveHttps({ username: "deploy", password: PASSWORD });

      const reader = yield* makeCredentialFileStore({ filePath, keySource: keyOf("B") });
      assert.deepStrictEqual(yield* reader.load, { https: null, ssh: null, web: null });
    }),
  );

  it.effect("treats a corrupt file as absent (never crashes a read)", () =>
    withStore("A", ({ store, filePath, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(filePath, "garbage-not-a-blob");
        assert.deepStrictEqual(yield* store.load, { https: null, ssh: null, web: null });
      }),
    ),
  );

  it.effect("redacts the password from the presence object", () =>
    withStore("A", ({ store }) =>
      Effect.gen(function* () {
        yield* store.saveHttps({ username: "deploy", password: PASSWORD });
        const presence = yield* store.presence;
        assert.strictEqual(presence.https?.username, "deploy");
        assert.strictEqual(typeof presence.https?.savedAt, "number");
        assert.strictEqual(JSON.stringify(presence).includes(PASSWORD), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(presence.https, "password"), false);
      }),
    ),
  );
});
