// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the "can this installation update itself?" verdict — layout detection (pure, injected
// `exists`) and the write probe (real fs), plus the facts projection that carries both onto the
// wire. This is what stops a press from failing halfway: a dev checkout or a read-only system
// install says so up front.

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";

import {
  detectLayout,
  makeFactsReader,
  probeAppRootWritable,
} from "../../auto-update/engine/envFacts.ts";

const pathOps = {
  dirname: (p: string) => NodePath.dirname(p),
  basename: (p: string) => NodePath.basename(p),
  join: (...parts: ReadonlyArray<string>) => NodePath.join(...parts),
};

describe("detectLayout", () => {
  it("an installed wrapper (cli.js beside current.json) is updatable", () => {
    const layout = detectLayout({
      entry: "/home/u/.ru-code/bin/cli.js",
      envAppRoot: undefined,
      ...pathOps,
      exists: (p) => p === "/home/u/.ru-code/bin/current.json",
    });
    assert.isTrue(layout.updatable);
    assert.strictEqual(layout.appRoot, "/home/u/.ru-code/bin");
  });

  it("cli.js WITHOUT a pointer beside it is not updatable", () => {
    const layout = detectLayout({
      entry: "/home/u/.ru-code/bin/cli.js",
      envAppRoot: undefined,
      ...pathOps,
      exists: () => false,
    });
    assert.isFalse(layout.updatable);
    assert.strictEqual(layout.appRoot, null);
  });

  it("a dev/bundle entry (bin.mjs) is not updatable even beside a pointer", () => {
    const layout = detectLayout({
      entry: "/repo/apps/server/dist/bin.mjs",
      envAppRoot: undefined,
      ...pathOps,
      exists: () => true,
    });
    assert.isFalse(layout.updatable);
  });
});

it.layer(NodeServices.layer)("apply-possible facts", (it) => {
  // The `read-only` verdict, tested WITHOUT depending on permission bits. The chmod-based spec
  // below cannot exercise it under root — where `chmod 0o500` stops nothing, so the probe
  // legitimately succeeds and the test asserts the opposite of its own title — and root is the
  // default in most containers, so on most machines this branch had no coverage at all while
  // `refusePress("read-only", …)` has no other server-side test. `makeFactsReader` takes the
  // writability as a plain input, so the verdict is testable on its own terms.
  it.effect("an unwritable wrapper layout reports blockReason 'read-only'", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "envfacts-ro-input-" });
      const reader = yield* makeFactsReader({
        layout: { updatable: true, appRoot, entryJs: `${appRoot}/cli.js` },
        sentinelPath: `${appRoot}/does-not-exist.json`,
        appRootWritable: false,
      });
      const facts = yield* reader;
      assert.isFalse(facts.canApply);
      assert.strictEqual(facts.blockReason, "read-only");
    }),
  );

  // The probe covers every directory an install writes, not just the root: a root-owned
  // `versions/` or `updates/` (one sudo-run install is enough) used to pass the boot gate and then
  // fail mid-install as a generic "not a valid release".
  it.effect("the probe covers the install's subtrees, not only the appRoot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "envfacts-subtree-" });
      const versionsDir = NodePath.join(appRoot, "versions");
      // A pre-existing unwritable versions/ — the appRoot itself stays writable.
      yield* fs.makeDirectory(versionsDir, { recursive: true });
      yield* fs.chmod(versionsDir, 0o500);
      const writable = yield* probeAppRootWritable(appRoot);
      yield* fs.chmod(versionsDir, 0o700); // restore so the temp dir can be cleaned up
      // Under root the permission bits stop nothing and the probe legitimately succeeds — the
      // same guard the chmod spec below uses.
      const rootProbe = yield* Effect.sync(
        () => typeof process.getuid === "function" && process.getuid() === 0,
      );
      if (!rootProbe) assert.isFalse(writable);
    }),
  );

  it.effect("the probe materialises the canonical subdirs on a fresh layout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "envfacts-fresh-" });
      const writable = yield* probeAppRootWritable(appRoot);
      assert.isTrue(writable);
      // The dirs an install writes now exist — probing them is what proved they are writable.
      assert.isTrue(yield* fs.exists(NodePath.join(appRoot, "versions")));
      assert.isTrue(yield* fs.exists(NodePath.join(appRoot, "updates", "tmp")));
    }),
  );

  it.effect("a writable wrapper layout reports canApply with no reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "envfacts-ok-" });
      const writable = yield* probeAppRootWritable(appRoot);
      assert.isTrue(writable);
      const reader = yield* makeFactsReader({
        layout: { updatable: true, appRoot, entryJs: `${appRoot}/cli.js` },
        sentinelPath: `${appRoot}/does-not-exist.json`,
        appRootWritable: writable,
      });
      const facts = yield* reader;
      assert.isTrue(facts.canApply);
      assert.strictEqual(facts.blockReason, null);
      assert.strictEqual(facts.installDir, appRoot);
      // No sentinel yet ⇒ the port is reported as unknown rather than guessed.
      assert.strictEqual(facts.port, 0);
    }),
  );

  it.effect("a non-wrapper layout reports blockReason 'layout'", () =>
    Effect.gen(function* () {
      const reader = yield* makeFactsReader({
        layout: { updatable: false, appRoot: null, entryJs: "/repo/apps/server/dist/bin.mjs" },
        sentinelPath: "/nowhere.json",
        appRootWritable: false,
      });
      const facts = yield* reader;
      assert.isFalse(facts.canApply);
      assert.strictEqual(facts.blockReason, "layout");
      // Without an appRoot the install dir falls back to the running entry's folder.
      assert.strictEqual(facts.installDir, "/repo/apps/server/dist");
    }),
  );

  it.effect("a read-only wrapper layout reports blockReason 'read-only'", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "envfacts-ro-" });
      yield* fs.chmod(appRoot, 0o500);
      const writable = yield* probeAppRootWritable(appRoot);
      const reader = yield* makeFactsReader({
        layout: { updatable: true, appRoot, entryJs: `${appRoot}/cli.js` },
        sentinelPath: `${appRoot}/x.json`,
        appRootWritable: writable,
      });
      const facts = yield* reader;
      yield* fs.chmod(appRoot, 0o700); // restore so the temp dir can be cleaned up
      // Running as root defeats permission bits entirely — then the probe legitimately succeeds.
      if (writable) {
        assert.isTrue(facts.canApply);
        return;
      }
      assert.isFalse(facts.canApply);
      assert.strictEqual(facts.blockReason, "read-only");
    }),
  );
});
