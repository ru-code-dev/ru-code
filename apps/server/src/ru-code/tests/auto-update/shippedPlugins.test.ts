// ru-code (V2-20): what the AUTO-UPDATE channel does with the shipped plugin set.
//
// The updater takes `versions/<v>/` out of the archive WHOLESALE — `findVersionPayload` locates the
// directory, `verifyExtractedChecksums` checks every file in it against the embedded
// `__checksums.json`, and the whole tree is renamed into place — so a new `plugins/` subdirectory
// inside the payload needs no updater change at all. Three things follow, and all three are pinned
// here rather than argued:
//
//   1. a new version's shipped set lands under ITS version dir and the old one is untouched until
//      GC drops it with the rest of the old code — which is what makes a rollback restore the
//      shipped set that matches the code it runs with;
//   2. the plugin bytes are INSIDE the integrity map, not beside it: tampering with
//      `plugins/<id>/web/index.mjs` after the checksums were written is refused by name. From now
//      on those bytes change on every app update, so this is the gate that protects them;
//   3. `<baseDir>/plugins` (user plugins) and `<stateDir>/plugins` (plugin data) are outside
//      `appRoot` entirely — the updater only ever touches `versions/`, `updates/` and
//      `current.json` — so "an update never eats a user plugin" is a property of the layout.
//
// No engine change was made for any of this. These specs exist to keep it that way.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CHECKSUMS_FILENAME } from "../../auto-update/apply/checksums.ts";
import {
  fetchVersionToDisk,
  VERSION_ENTRY_FILENAME,
} from "../../auto-update/apply/fetchVersion.ts";
import { collectVersionGarbage, VERSIONS_DIRNAME } from "../../auto-update/apply/gc.ts";

const sha256Hex = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** `versions/<v>/plugins/<id>/web/index.mjs`, so "which build is this" is a readable fact. */
const pluginWebSource = (id: string, version: string): string =>
  `export const id = ${JSON.stringify(id)};\nexport const built = ${JSON.stringify(version)};\n`;

/**
 * A shipping-shaped bundle carrying a shipped plugin set, tarred, returned as bytes.
 *
 * Mirrors `fetchVersion.test.ts:buildTarball` — the archive root carries the wrapper decoy and the
 * pointer, because the fetcher must take `versions/<v>/` and never the root.
 */
const buildTarball = (params: {
  readonly version: string;
  readonly plugins: ReadonlyArray<string>;
  readonly tamperPlugin?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workDir = yield* fs.makeTempDirectory({ prefix: "shipped-fixture-" });
    const bundle = path.join(workDir, "bundle");
    const payload = path.join(bundle, VERSIONS_DIRNAME, params.version);
    yield* fs.makeDirectory(payload, { recursive: true });
    yield* fs.writeFileString(
      path.join(bundle, VERSION_ENTRY_FILENAME),
      "// FROZEN launcher decoy — must never be landed as a version\n",
    );
    yield* fs.writeFileString(
      path.join(payload, VERSION_ENTRY_FILENAME),
      `console.log(${JSON.stringify(params.version)})\n`,
    );

    const relatives: Array<string> = [VERSION_ENTRY_FILENAME];
    for (const id of params.plugins) {
      yield* fs.makeDirectory(path.join(payload, "plugins", id, "web"), { recursive: true });
      yield* fs.writeFileString(
        path.join(payload, "plugins", id, "plugin.json"),
        `${JSON.stringify({ id, name: id, version: params.version, apiVersion: 2, web: "web/index.mjs" })}\n`,
      );
      yield* fs.writeFileString(
        path.join(payload, "plugins", id, "web", "index.mjs"),
        pluginWebSource(id, params.version),
      );
      relatives.push(`plugins/${id}/plugin.json`, `plugins/${id}/web/index.mjs`);
    }

    // The per-file map, exactly as `prepare-release` bakes it — walked recursively, so `plugins/**`
    // is covered by construction rather than by an allow-list.
    const files: Record<string, string> = {};
    for (const relative of relatives) {
      files[relative] = sha256Hex(yield* fs.readFile(path.join(payload, relative)));
    }
    yield* fs.writeFileString(
      path.join(payload, CHECKSUMS_FILENAME),
      JSON.stringify({ algo: "sha256", files }),
    );

    // AFTER the map was written: the bytes a man-in-the-middle would swap.
    if (params.tamperPlugin !== undefined) {
      yield* fs.writeFileString(
        path.join(payload, "plugins", params.tamperPlugin, "web", "index.mjs"),
        "export const id = 'evil';\n",
      );
    }

    const tarballPath = path.join(workDir, `release-${params.version}.tgz`);
    yield* Effect.callback<void>((resume) => {
      const child = NodeChildProcess.spawn("tar", ["-czf", tarballPath, "-C", bundle, "."], {
        stdio: "ignore",
      });
      child.on("close", () => resume(Effect.void));
      child.on("error", () => resume(Effect.void));
    });
    return tarballPath;
  });

/** `<baseDir>` with an updater `appRoot` at `bin/`, a user plugin and a plugin's data seeded. */
const makeInstalledTree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectory({ prefix: "shipped-update-" });
  const appRoot = path.join(baseDir, "bin");
  yield* fs.makeDirectory(appRoot, { recursive: true });
  // A user plugin, beside bin/ — the updater has no path that reaches it.
  yield* fs.makeDirectory(path.join(baseDir, "plugins", "mine"), { recursive: true });
  yield* fs.writeFileString(
    path.join(baseDir, "plugins", "mine", "plugin.json"),
    `{"id":"mine"}\n`,
  );
  // A SHIPPED plugin's data, under stateDir — D11: it outlives its code.
  yield* fs.makeDirectory(path.join(baseDir, "userdata", "plugins", "analytics"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(baseDir, "userdata", "plugins", "analytics", "data.sqlite"),
    "PRETEND-SQLITE-BYTES",
  );
  return { baseDir, appRoot };
});

const userStateIntact = (baseDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    assert.strictEqual(
      yield* fs.readFileString(path.join(baseDir, "plugins", "mine", "plugin.json")),
      `{"id":"mine"}\n`,
    );
    assert.strictEqual(
      yield* fs.readFileString(
        path.join(baseDir, "userdata", "plugins", "analytics", "data.sqlite"),
      ),
      "PRETEND-SQLITE-BYTES",
    );
  });

it.layer(NodeServices.layer)("auto-update — shipped plugins in the payload (V2-20)", (it) => {
  it.effect("an update lands the NEW shipped set under its own version dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, appRoot } = yield* makeInstalledTree;

      // Version 1 is already installed, with `analytics` shipped.
      const installed = path.join(
        appRoot,
        VERSIONS_DIRNAME,
        "1.0.0",
        "plugins",
        "analytics",
        "web",
      );
      yield* fs.makeDirectory(installed, { recursive: true });
      yield* fs.writeFileString(
        path.join(installed, "index.mjs"),
        pluginWebSource("analytics", "1.0.0"),
      );

      // Version 2 ships NEW analytics bytes plus a plugin that did not exist before.
      const tarball = yield* buildTarball({
        version: "2.0.0",
        plugins: ["analytics", "catalogs"],
      });
      const bytes = yield* fs.readFile(tarball);
      const fetched = yield* fetchVersionToDisk({
        appRoot,
        version: "2.0.0",
        source: { kind: "file", path: tarball },
        expectedSha256: sha256Hex(bytes),
      });
      assert.strictEqual(fetched.entryRelative, `versions/2.0.0/${VERSION_ENTRY_FILENAME}`);

      const read = (version: string, id: string) =>
        fs.readFileString(
          path.join(appRoot, VERSIONS_DIRNAME, version, "plugins", id, "web", "index.mjs"),
        );
      assert.include(yield* read("2.0.0", "analytics"), `"2.0.0"`);
      assert.include(yield* read("2.0.0", "catalogs"), `"catalogs"`);
      // The OLD version's shipped set is still on disk and still the old bytes: a version dir is
      // self-contained, which is what lets the wrapper fall back to it and a rollback restore the
      // shipped set that matches its code.
      assert.include(yield* read("1.0.0", "analytics"), `"1.0.0"`);

      // Boot-confirm GC: the old tree goes with its code, the new shipped set stays.
      yield* collectVersionGarbage({ appRoot, keepVersions: ["2.0.0"] });
      assert.deepStrictEqual(
        [...(yield* fs.readDirectory(path.join(appRoot, VERSIONS_DIRNAME)))].sort(),
        ["2.0.0"],
      );
      assert.isTrue(
        yield* fs.exists(
          path.join(appRoot, VERSIONS_DIRNAME, "2.0.0", "plugins", "analytics", "plugin.json"),
        ),
      );

      // And the two directories the updater must never reach.
      yield* userStateIntact(baseDir);
    }),
  );

  it.effect("a plugin dropped from the shipped set disappears with its version, data kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, appRoot } = yield* makeInstalledTree;

      const tarball = yield* buildTarball({ version: "3.0.0", plugins: ["analytics"] });
      const bytes = yield* fs.readFile(tarball);
      yield* fetchVersionToDisk({
        appRoot,
        version: "3.0.0",
        source: { kind: "file", path: tarball },
        expectedSha256: sha256Hex(bytes),
      });

      const payload = path.join(appRoot, VERSIONS_DIRNAME, "3.0.0", "plugins");
      assert.deepStrictEqual([...(yield* fs.readDirectory(payload))].sort(), ["analytics"]);
      // Its data is untouched by the removal — there is nothing in either channel that could.
      yield* userStateIntact(baseDir);
    }),
  );

  // R5: `web/index.mjs` keeps its name across versions and its bytes now change on every update, so
  // the integrity map is what stands between a user and swapped plugin code.
  it.effect("tampered plugin bytes are refused by name — the set is INSIDE __checksums.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, appRoot } = yield* makeInstalledTree;

      const tarball = yield* buildTarball({
        version: "4.0.0",
        plugins: ["analytics"],
        tamperPlugin: "analytics",
      });
      const bytes = yield* fs.readFile(tarball);
      const failure = yield* fetchVersionToDisk({
        appRoot,
        version: "4.0.0",
        source: { kind: "file", path: tarball },
        expectedSha256: sha256Hex(bytes),
      }).pipe(Effect.flip);

      assert.strictEqual(failure._tag, "FetchFileIntegrityError");
      assert.include(String(failure.detail), "plugins/analytics/web/index.mjs");
      // Nothing landed, and nothing outside appRoot moved.
      assert.isFalse(
        yield* fs
          .exists(path.join(appRoot, VERSIONS_DIRNAME, "4.0.0"))
          .pipe(Effect.orElseSucceed(() => true)),
      );
      yield* userStateIntact(baseDir);
    }),
  );
});
