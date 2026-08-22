// ru-code: SSH deploy-key file lifecycle. A pasted key is written 0600 (asserted on POSIX). The
// ssh-keygen-backed paths (generate + fingerprint round-trip) run against a real temp dir when
// ssh-keygen is on PATH, and are cleanly skipped otherwise so the suite stays green on hosts
// without it.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { layer as processRunnerLayer } from "../../../processRunner.ts";
import {
  discardStagedKey,
  generateDeployKey,
  promoteStagedKey,
  readPublicInfo,
  stagingKeyPath,
  writePastedKey,
} from "../../auto-update/gitAuth/sshKeyFile.ts";

const layer = Layer.provideMerge(processRunnerLayer, NodeServices.layer);

const sshKeygenAvailable =
  NodeChildProcess.spawnSync("ssh-keygen", ["-l", "-f", "/nonexistent-ru-code-probe"]).error ===
  undefined;

// oxlint-disable-next-line t3code/no-global-process-runtime -- test-only guard for POSIX file-mode assertions; no Effect runtime here
const isPosix = NodeOS.platform() !== "win32";

it.layer(layer)("sshKeyFile", (it) => {
  it.effect("writes a pasted key at 0600", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-key-" });
      const keyPath = path.join(dir, "ru_code_update_ed25519");

      const result = yield* writePastedKey("-----BEGIN KEY-----\nAAAA\n-----END KEY-----", keyPath);
      assert.strictEqual(result.path, keyPath);
      assert.strictEqual(NodeFS.existsSync(keyPath), true);
      assert.strictEqual(NodeFS.readFileSync(keyPath, "utf8").endsWith("\n"), true);
      if (isPosix) {
        assert.strictEqual(NodeFS.statSync(keyPath).mode & 0o777, 0o600);
      }
    }),
  );

  if (sshKeygenAvailable) {
    it.effect("generates an ed25519 deploy key and round-trips its fingerprint", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-gen-" });
        const keyPath = path.join(dir, "ru_code_update_ed25519");

        const generated = yield* generateDeployKey(keyPath);
        assert.strictEqual(generated.path, keyPath);
        assert.strictEqual(generated.publicKey.startsWith("ssh-ed25519 "), true);
        assert.strictEqual(generated.fingerprint.startsWith("SHA256:"), true);
        assert.strictEqual(NodeFS.existsSync(`${keyPath}.pub`), true);
        if (isPosix) {
          assert.strictEqual(NodeFS.statSync(keyPath).mode & 0o777, 0o600);
        }

        const info = yield* readPublicInfo(keyPath);
        assert.strictEqual(info.fingerprint, generated.fingerprint);
      }),
    );

    it.effect("fails cleanly reading a non-key file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-bad-" });
        const keyPath = path.join(dir, "not-a-key");
        yield* fs.writeFileString(keyPath, "definitely not a key");

        const exit = yield* Effect.exit(readPublicInfo(keyPath));
        assert.strictEqual(exit._tag, "Failure");
      }),
    );
  } else {
    // A skipped test, not a passing empty one — see the note in gitChannel.test.ts.
    it.skip("key generation specs require ssh-keygen on PATH", () => undefined);
  }

  // ── AU-06: a key under consideration must never be the key in use ──────────
  // `generateDeployKey` removes its target before running ssh-keygen (it must — ssh-keygen would
  // block on an overwrite prompt), and the wizard fires generate on ENTERING the step. Aimed at the
  // live path, that destroyed a working key before the user had tested or saved anything; the
  // stored fingerprint still described the old one, so every scheduled check then authenticated
  // with a key the host had never seen, and two failures later the source persisted `paused`.
  it.effect("staging is a different file from the live key", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const live = path.join("/keys", "ru_code_update_ed25519");
      assert.notStrictEqual(stagingKeyPath(live), live);
      assert.strictEqual(stagingKeyPath(live).startsWith(live), true);
    }),
  );

  it.effect("promote replaces the live key and its public half in one move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-promote-" });
      const keyPath = path.join(dir, "ru_code_update_ed25519");
      yield* fs.writeFileString(keyPath, "OLD");
      yield* fs.writeFileString(`${keyPath}.pub`, "OLD-PUB");
      yield* fs.writeFileString(stagingKeyPath(keyPath), "NEW");
      yield* fs.writeFileString(`${stagingKeyPath(keyPath)}.pub`, "NEW-PUB");

      yield* promoteStagedKey(keyPath);

      assert.strictEqual(yield* fs.readFileString(keyPath), "NEW");
      assert.strictEqual(yield* fs.readFileString(`${keyPath}.pub`), "NEW-PUB");
      // Nothing is left behind to be promoted twice.
      assert.strictEqual(NodeFS.existsSync(stagingKeyPath(keyPath)), false);
    }),
  );

  it.effect("promote fails, and leaves the live key alone, when nothing was staged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-promote-none-" });
      const keyPath = path.join(dir, "ru_code_update_ed25519");
      yield* fs.writeFileString(keyPath, "OLD");

      const exit = yield* Effect.exit(promoteStagedKey(keyPath));

      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(yield* fs.readFileString(keyPath), "OLD");
    }),
  );

  // Abandoning the wizard — ✕, navigating away, a dropped connection — must leave the live key
  // exactly as it was, and must not leave a private key lying around either.
  it.effect("discard removes only the staged pair", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-discard-" });
      const keyPath = path.join(dir, "ru_code_update_ed25519");
      yield* fs.writeFileString(keyPath, "OLD");
      yield* fs.writeFileString(stagingKeyPath(keyPath), "NEW");
      yield* fs.writeFileString(`${stagingKeyPath(keyPath)}.pub`, "NEW-PUB");

      yield* discardStagedKey(keyPath);

      assert.strictEqual(yield* fs.readFileString(keyPath), "OLD");
      assert.strictEqual(NodeFS.existsSync(stagingKeyPath(keyPath)), false);
      assert.strictEqual(NodeFS.existsSync(`${stagingKeyPath(keyPath)}.pub`), false);
    }),
  );

  it.effect("discard is safe when there is nothing staged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "ru-au-discard-none-" });
      const keyPath = path.join(dir, "ru_code_update_ed25519");
      yield* fs.writeFileString(keyPath, "OLD");

      yield* discardStagedKey(keyPath);

      assert.strictEqual(yield* fs.readFileString(keyPath), "OLD");
    }),
  );
});
