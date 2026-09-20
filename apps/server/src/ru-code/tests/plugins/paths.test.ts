// ru-code: the two path derivations everything else in the plugin system agrees on.
//
// `resolvePluginsDir` is pure on purpose (A0) so the test-only override can be
// exercised without mutating `process.env`. The case that matters most is the
// empty override: an env var set to "" must NOT be read as "scan the filesystem
// root" — that would hand the loader every directory on the machine.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import {
  PLUGIN_DB_FILENAME,
  pluginDbPath,
  pluginStateDir,
  resolvePluginsDir,
  resolveShippedPluginsDir,
  SHIPPED_PLUGINS_DIR_ENV_VAR,
  SHIPPED_PLUGINS_DIR_PROBES,
  shippedPluginsDirCandidates,
} from "../../plugins/paths.ts";

/**
 * Run `body` with `RU_CODE_SHIPPED_PLUGINS_DIR` set, and restore it afterwards.
 *
 * `resolveShippedPluginsDir` reads `process.env` the same way `pluginsDir` does — the env read is
 * the one impure edge, and everything in front of it (`shippedPluginsDirCandidates`) is pure so it
 * can be tested without this.
 */
const withShippedEnv = <A, E, R>(
  dir: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
      process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = dir;
      return previous;
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[SHIPPED_PLUGINS_DIR_ENV_VAR];
        else process.env[SHIPPED_PLUGINS_DIR_ENV_VAR] = previous;
      }),
  );

it.layer(NodeServices.layer)("resolvePluginsDir", (it) => {
  it.effect("defaults to <baseDir>/plugins", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolvePluginsDir({ path, baseDir: "/home/u/.ru-code", override: undefined })).toBe(
        "/home/u/.ru-code/plugins",
      );
    }),
  );

  it.effect("an empty or whitespace override is treated as unset", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      for (const override of ["", "   "]) {
        expect(resolvePluginsDir({ path, baseDir: "/home/u/.ru-code", override })).toBe(
          "/home/u/.ru-code/plugins",
        );
      }
    }),
  );

  it.effect("a real override wins and is resolved to an absolute path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        resolvePluginsDir({ path, baseDir: "/home/u/.ru-code", override: "/tmp/fixtures" }),
      ).toBe("/tmp/fixtures");
    }),
  );
});

it.layer(NodeServices.layer)("plugin state paths", (it) => {
  it.effect("live under stateDir, not under the plugin folder (D2/D11)", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const dir = yield* pluginStateDir("demo");
      const dbPath = yield* pluginDbPath("demo");
      expect(dir).toBe(`${config.stateDir}/plugins/demo`);
      expect(dbPath).toBe(`${config.stateDir}/plugins/demo/${PLUGIN_DB_FILENAME}`);
      // Deleting the dropped-in folder must never reach this path.
      expect(dbPath.startsWith(config.baseDir)).toBe(true);
      expect(dbPath).not.toBe(config.dbPath);
    }).pipe(
      Effect.provide(ServerConfig.layerTest("/tmp/cwd", { prefix: "ru-code-plugin-paths-" })),
    ),
  );
});

// ru-code (V2-20/V2-21): the SECOND root — the shipped set inside the version payload.
//
// `resolveShippedPluginsDir` is the only thing in the plugin system that is resolved relative to
// the CODE rather than to `baseDir`, because "this version's payload" is not something a config
// value can name. The probe ORDER is the whole contract, so it is pinned on the pure function; the
// effectful wrapper is then only about which candidate exists.
it.layer(NodeServices.layer)("shippedPluginsDirCandidates", (it) => {
  it.effect("probes the payload sibling first, then the dev dist", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const candidates = shippedPluginsDirCandidates({
        path,
        moduleDir: "/app/bin/versions/1.2.3",
        override: undefined,
      });
      expect(candidates).toEqual([
        // The payload sibling — the one that matters in a release, in `dist/` and on the desktop.
        "/app/bin/versions/1.2.3/plugins",
        // The dev probe, three directories up: meaningful only when this module runs from
        // `apps/server/src/ru-code/plugins/` (see the next case), nonsense anywhere else — which
        // is why it is second and why the resolver requires a real directory.
        "/app/dist/plugins",
      ]);
      expect(candidates).toHaveLength(SHIPPED_PLUGINS_DIR_PROBES.length);
    }),
  );

  it.effect("resolves the dev probe to <apps/server>/dist/plugins", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const candidates = shippedPluginsDirCandidates({
        path,
        moduleDir: "/repo/apps/server/src/ru-code/plugins",
        override: undefined,
      });
      expect(candidates[1]).toBe("/repo/apps/server/dist/plugins");
    }),
  );

  // An override must not fall through to the developer's real `dist/plugins`: a test that points
  // the shipped root at an empty fixture is asking for "no shipped plugins", not "whatever is
  // lying around".
  it.effect("an override wins outright — one candidate, no probes behind it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        shippedPluginsDirCandidates({
          path,
          moduleDir: "/app/bin/versions/1.2.3",
          override: "/tmp/fixture-shipped",
        }),
      ).toEqual(["/tmp/fixture-shipped"]);
    }),
  );

  it.effect("an empty or whitespace override is treated as unset", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      for (const override of ["", "   "]) {
        expect(shippedPluginsDirCandidates({ path, moduleDir: "/app/x", override })).toEqual([
          "/app/x/plugins",
          "/dist/plugins",
        ]);
      }
    }),
  );
});

it.layer(NodeServices.layer)("resolveShippedPluginsDir", (it) => {
  it.effect("undefined when this build ships no plugins — a normal answer, not a failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* Effect.orDie(
        fs.makeTempDirectoryScoped({ prefix: "ru-code-shipped-absent-" }),
      );
      const absent = path.join(root, "nothing-here");
      yield* withShippedEnv(
        absent,
        Effect.gen(function* () {
          expect(yield* resolveShippedPluginsDir).toBeUndefined();
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("returns the override when it is a real directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "ru-code-shipped-" }));
      const shipped = path.join(root, "plugins");
      yield* Effect.orDie(fs.makeDirectory(shipped, { recursive: true }));
      yield* withShippedEnv(
        shipped,
        Effect.gen(function* () {
          expect(yield* resolveShippedPluginsDir).toBe(shipped);
        }),
      );
    }).pipe(Effect.scoped),
  );

  // A file named `plugins` beside the bundle would otherwise be handed to `scanPluginsDir`, which
  // reads a missing/unreadable root as "no plugins" — hiding the mistake instead of ignoring it.
  it.effect("ignores a candidate that is a file rather than a directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* Effect.orDie(
        fs.makeTempDirectoryScoped({ prefix: "ru-code-shipped-file-" }),
      );
      const notADir = path.join(root, "plugins");
      yield* Effect.orDie(fs.writeFileString(notADir, "not a directory"));
      yield* withShippedEnv(
        notADir,
        Effect.gen(function* () {
          expect(yield* resolveShippedPluginsDir).toBeUndefined();
        }),
      );
    }).pipe(Effect.scoped),
  );
});
