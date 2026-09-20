// ru-code: the plugin scanner's refusal matrix.
//
// The scanner is the host's only filter between "a user copied a folder into
// ~/.ru-code/plugins" and "the server imports and executes code from it", so
// every rule that can reject a folder is pinned here — including the two that
// exist purely for containment (an id that does not match its folder, and an
// entry that resolves outside the plugins root through a symlink).
//
// Every case also asserts the SHAPE of the refusal: a bad folder must come back
// as a reported `{ ok: false, reason }`, never as a dropped row (the UI has to
// be able to say why nothing happened) and never as a throw.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { readPluginManifest, validatePluginRelativePath } from "../../plugins/manifest.ts";
import { scanPluginsDir } from "../../plugins/scan.ts";

const manifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    apiVersion: 2,
    ...overrides,
  });

/** Write `<root>/<name>/<rel>` for every entry. */
const writePlugin = (
  root: string,
  name: string,
  files: Readonly<Record<string, string>>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(root, name);
    yield* Effect.orDie(fs.makeDirectory(dir, { recursive: true }));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      yield* Effect.orDie(fs.makeDirectory(path.dirname(abs), { recursive: true }));
      yield* Effect.orDie(fs.writeFileString(abs, content));
    }
    return dir;
  });

const makeRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "ru-code-plugins-scan-" }));
});

describe("validatePluginRelativePath", () => {
  it("accepts a plain relative entry", () => {
    expect(validatePluginRelativePath("server", "server/index.mjs")).toBeUndefined();
  });

  it("rejects absolute, parent-escaping, NUL and empty values", () => {
    expect(validatePluginRelativePath("server", "/etc/passwd")).toContain("relative");
    expect(validatePluginRelativePath("server", "C:\\windows\\evil")).toContain("relative");
    expect(validatePluginRelativePath("server", "../../etc/passwd")).toContain("escapes");
    expect(validatePluginRelativePath("web", "web/../../x.mjs")).toContain("escapes");
    expect(validatePluginRelativePath("web", "web\\..\\..\\x.mjs")).toContain("escapes");
    expect(validatePluginRelativePath("styles", "a\0b.css")).toContain("NUL");
    expect(validatePluginRelativePath("styles", "")).toContain("empty");
  });
});

it.layer(NodeServices.layer)("scanPluginsDir", (it) => {
  it.effect("a missing plugins directory is not an error, it is no plugins", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      expect(yield* scanPluginsDir(path.join(root, "does-not-exist"))).toEqual([]);
    }),
  );

  it.effect("an empty plugins directory yields no entries", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      expect(yield* scanPluginsDir(root)).toEqual([]);
    }),
  );

  it.effect("a well-formed folder decodes", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", {
        "plugin.json": manifest({ server: "server/index.mjs", web: "web/index.mjs" }),
        "server/index.mjs": "export default {};",
        "web/index.mjs": "export default {};",
      });
      const entries = yield* scanPluginsDir(root);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (entry === undefined || !entry.ok) {
        throw new Error(`expected an ok entry, got ${String(entries.length)} bad rows`);
      }
      expect(entry.manifest.id).toBe("demo");
      expect(entry.manifest.server).toBe("server/index.mjs");
    }),
  );

  it.effect("malformed plugin.json is REPORTED as skipped, not dropped", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", { "plugin.json": "{ not json" });
      const entries = yield* scanPluginsDir(root);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ok).toBe(false);
      expect(entries[0]?.ok === false ? entries[0].reason : "").toContain("not valid JSON");
    }),
  );

  it.effect("a missing plugin.json is reported", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", { "readme.md": "hello" });
      const entries = yield* scanPluginsDir(root);
      expect(entries[0]?.ok === false ? entries[0].reason : "").toContain("missing or unreadable");
    }),
  );

  it.effect("D8: manifest id must equal the folder name", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "other", { "plugin.json": manifest() });
      const entries = yield* scanPluginsDir(root);
      expect(entries[0]?.ok === false ? entries[0].reason : "").toContain(
        'does not match folder name "other"',
      );
    }),
  );

  it.effect("an unsupported apiVersion is skipped", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", { "plugin.json": manifest({ apiVersion: 3 }) });
      const entries = yield* scanPluginsDir(root);
      expect(entries[0]?.ok === false ? entries[0].reason : "").toContain("apiVersion 3");
    }),
  );

  // ── v2: the shared-runtime contract (architecture.md §1) ─────────────────────────────────────
  it.effect("a plugin built against a different SHARED major is skipped, with the reason", () =>
    Effect.gen(function* () {
      // The failure this prevents: a plugin compiled against React 18 is handed React 19's chunk
      // by the import map and fails with hooks that do not exist and no message naming the cause.
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", {
        "plugin.json": manifest({ web: "web/index.mjs", shared: { react: "18.3.1" } }),
        "web/index.mjs": "export default {};",
      });
      const entries = yield* scanPluginsDir(root);
      const reason = entries[0]?.ok === false ? entries[0].reason : "";
      expect(reason).toContain("shared package major mismatch");
      expect(reason).toContain("react");
      expect(reason).toContain("19");
    }),
  );

  it.effect("a MINOR difference inside the same major is accepted", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", {
        "plugin.json": manifest({
          web: "web/index.mjs",
          shared: { react: "19.0.0", zustand: "5.0.1" },
        }),
        "web/index.mjs": "export default {};",
      });
      expect((yield* scanPluginsDir(root))[0]?.ok).toBe(true);
    }),
  );

  it.effect("a manifest with NO shared stamp is accepted — nothing to check", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", {
        "plugin.json": manifest({ web: "web/index.mjs" }),
        "web/index.mjs": "export default {};",
      });
      expect((yield* scanPluginsDir(root))[0]?.ok).toBe(true);
    }),
  );

  it.effect("a declared entry that does not exist is skipped", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writePlugin(root, "demo", {
        "plugin.json": manifest({ server: "server/index.mjs" }),
      });
      const entries = yield* scanPluginsDir(root);
      expect(entries[0]?.ok === false ? entries[0].reason : "").toContain("does not exist");
    }),
  );

  // Two layers refuse this and the OUTER one wins: the SDK's `PluginRelativePath`
  // rejects `..` at decode time, so `validatePluginRelativePath` (asserted directly
  // above) never sees it. That ordering is the point — the manifest is refused
  // before any of its paths are resolved against the disk.
  it.effect("an escaping entry path is skipped even though the target exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      yield* Effect.orDie(fs.writeFileString(path.join(root, "outside.mjs"), "export default {};"));
      yield* writePlugin(root, "demo", {
        "plugin.json": manifest({ server: "../outside.mjs" }),
      });
      const entries = yield* scanPluginsDir(root);
      const reason = entries[0]?.ok === false ? entries[0].reason : "";
      expect(entries[0]?.ok).toBe(false);
      expect(reason).toContain('["server"]');
    }),
  );

  it.effect("a subdirectory symlinked outside the plugins root is ignored entirely", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const elsewhere = yield* Effect.orDie(
        fs.makeTempDirectoryScoped({ prefix: "ru-code-plugins-outside-" }),
      );
      yield* writePlugin(elsewhere, "demo", { "plugin.json": manifest() });
      yield* writePlugin(root, "good", { "plugin.json": manifest({ id: "good" }) });
      yield* Effect.orDie(fs.symlink(path.join(elsewhere, "demo"), path.join(root, "demo")));

      const entries = yield* scanPluginsDir(root);
      // Not skipped-with-reason: an escaping link is not an installed plugin at
      // all, and echoing its target back to the UI would leak a filesystem path.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ok === true ? entries[0].manifest.id : "").toBe("good");
    }),
  );

  it.effect("plain files in the plugins directory are ignored", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      yield* Effect.orDie(fs.writeFileString(path.join(root, "notes.txt"), "hi"));
      expect(yield* scanPluginsDir(root)).toEqual([]);
    }),
  );

  it.effect("entries come back in directory-name order", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      for (const id of ["zeta", "alpha", "mid"]) {
        yield* writePlugin(root, id, { "plugin.json": manifest({ id }) });
      }
      const entries = yield* scanPluginsDir(root);
      expect(entries.map((entry) => (entry.ok ? entry.manifest.id : "?"))).toEqual([
        "alpha",
        "mid",
        "zeta",
      ]);
    }),
  );

  // ru-code (A5, A4 finding M1): the entry-level counterpart of the case above.
  // The FOLDER containment check was already right; the check on a manifest's
  // declared `server`/`web`/`styles` used `path.resolve` only, which is string
  // arithmetic and does not follow links — so A4 dropped in a `server/index.mjs`
  // symlinked to a module outside the plugins tree and watched the host import
  // and EXECUTE it (status `loaded`). Both halves of the pair are pinned here so
  // a future refactor cannot silently lose one.
  it.effect("an entry symlinked out of the plugin folder is skipped, not executed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const elsewhere = yield* Effect.orDie(
        fs.makeTempDirectoryScoped({ prefix: "ru-code-plugins-outside-" }),
      );
      const target = path.join(elsewhere, "evil.mjs");
      yield* Effect.orDie(fs.writeFileString(target, "export default { activate() {} };"));

      const dir = yield* writePlugin(root, "symtest", {
        "plugin.json": manifest({ id: "symtest", server: "server/index.mjs" }),
      });
      yield* Effect.orDie(fs.makeDirectory(path.join(dir, "server"), { recursive: true }));
      yield* Effect.orDie(fs.symlink(target, path.join(dir, "server", "index.mjs")));

      const entries = yield* scanPluginsDir(root);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry?.ok).toBe(false);
      expect(entry?.ok === false ? entry.reason : "").toContain("escapes the plugin folder");
      // The reason names the FIELD, never the link target: echoing an arbitrary
      // filesystem path back to the UI is the leak `scan.ts` avoids for folders.
      expect(entry?.ok === false ? entry.reason : "").not.toContain(elsewhere);
    }),
  );

  it.effect("a symlinked entry that stays inside the plugin folder is still accepted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const dir = yield* writePlugin(root, "inlink", {
        "plugin.json": manifest({ id: "inlink", server: "server/index.mjs" }),
        "real/entry.mjs": "export default { activate() {} };",
      });
      yield* Effect.orDie(fs.makeDirectory(path.join(dir, "server"), { recursive: true }));
      yield* Effect.orDie(
        fs.symlink(path.join(dir, "real", "entry.mjs"), path.join(dir, "server", "index.mjs")),
      );

      const entries = yield* scanPluginsDir(root);
      expect(entries[0]?.ok).toBe(true);
    }),
  );

  it.effect("readPluginManifest never throws on a directory that is not a plugin", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const dir = yield* writePlugin(root, "empty", {});
      const entry = yield* readPluginManifest(dir);
      expect(entry.ok).toBe(false);
    }),
  );
});
