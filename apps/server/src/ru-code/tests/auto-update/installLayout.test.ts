// ru-code: the installed wrapper layout builder — real temp dirs + a real `node` run of the
// emitted wrapper proving the layout boots the pointed version.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off

import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readPointer } from "../../auto-update/apply/pointer.ts";
import { buildInstalledLayout } from "../../auto-update/wrapper/installLayout.ts";

const runNode = (entry: string): Effect.Effect<{ code: number | null; stdout: string }> =>
  Effect.callback((resume) => {
    NodeChildProcess.execFile(process.execPath, [entry], (error, stdout) => {
      resume(
        Effect.succeed({
          code: error === null ? 0 : ((error.code as number | null) ?? 1),
          stdout,
        }),
      );
    });
  });

it.layer(NodeServices.layer)("buildInstalledLayout", (it) => {
  it.effect("installs a payload, writes the wrapper + pointer, and the wrapper boots it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workDir = yield* fs.makeTempDirectory({ prefix: "layout-" });
      const payload = path.join(workDir, "payload");
      const appRoot = path.join(workDir, "app");
      yield* fs.makeDirectory(payload, { recursive: true });
      yield* fs.writeFileString(path.join(payload, "cli.js"), "console.log('BOOTED-1.4.2')\n");
      yield* fs.writeFileString(
        path.join(payload, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.4.2", main: "cli.js" }),
      );

      const layout = yield* buildInstalledLayout({
        appRoot,
        payloadDir: payload,
        version: "1.4.2",
      });

      const pointer = yield* readPointer(appRoot);
      assert.strictEqual(pointer?.version, "1.4.2");
      assert.strictEqual(pointer?.entry, "versions/1.4.2/cli.js");

      const result = yield* runNode(layout.wrapperPath);
      assert.strictEqual(result.code, 0);
      assert.include(result.stdout, "BOOTED-1.4.2");

      // Idempotent re-install of the same version.
      yield* buildInstalledLayout({ appRoot, payloadDir: payload, version: "1.4.2" });
      const again = yield* runNode(layout.wrapperPath);
      assert.include(again.stdout, "BOOTED-1.4.2");
    }),
  );

  // The wrapper is ESM with a `.js` name. Without a declaration beside it Node must detect the
  // module kind from the source on every launch (and warns about it on the node 22 line). The
  // declaration belongs at the ROOT only: `versions/<v>/` ships its own and must keep winning.
  it.effect("declares the wrapper's module type at the bundle root, not in the version dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workDir = yield* fs.makeTempDirectory({ prefix: "layout-type-" });
      const payload = path.join(workDir, "payload");
      const appRoot = path.join(workDir, "app");
      yield* fs.makeDirectory(payload, { recursive: true });
      yield* fs.writeFileString(path.join(payload, "cli.js"), "console.log('BOOTED')\n");
      yield* fs.writeFileString(
        path.join(payload, "package.json"),
        JSON.stringify({ name: "fixture", version: "9.9.9", type: "commonjs" }),
      );

      yield* buildInstalledLayout({ appRoot, payloadDir: payload, version: "9.9.9" });

      const declared: unknown = JSON.parse(
        yield* fs.readFileString(path.join(appRoot, "package.json")),
      );
      assert.deepStrictEqual(declared, { type: "module", private: true });

      // The payload's own declaration is untouched — the nearer file governs the version entry.
      const payloadDeclared: unknown = JSON.parse(
        yield* fs.readFileString(path.join(appRoot, "versions", "9.9.9", "package.json")),
      );
      assert.strictEqual((payloadDeclared as { type: string }).type, "commonjs");

      // And the wrapper still boots with the declaration in place.
      const booted = yield* runNode(path.join(appRoot, "cli.js"));
      assert.strictEqual(booted.code, 0);
      assert.include(booted.stdout, "BOOTED");
    }),
  );
});
