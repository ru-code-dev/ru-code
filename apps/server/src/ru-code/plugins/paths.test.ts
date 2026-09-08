// ru-code: the two path derivations everything else in the plugin system agrees on.
//
// `resolvePluginsDir` is pure on purpose (A0) so the test-only override can be
// exercised without mutating `process.env`. The case that matters most is the
// empty override: an env var set to "" must NOT be read as "scan the filesystem
// root" — that would hand the loader every directory on the machine.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import { PLUGIN_DB_FILENAME, pluginDbPath, pluginStateDir, resolvePluginsDir } from "./paths.ts";

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
