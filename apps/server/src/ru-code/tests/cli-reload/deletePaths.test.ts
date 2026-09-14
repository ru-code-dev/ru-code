// ru-code (cli-reload): the delete step, owner ruling R3.
//
// What this proves — and it is the whole contract, nothing decorative:
//   · a plain entry, a NESTED entry spelled with a posix `/`, and a DIRECTORY entry all go;
//   · the posix spelling is JOINED as segments, not concatenated — the nested entry has to
//     land on `<dir>/b/c.ext` on this platform's separator;
//   · a control file beside them survives (the step removes entries, never the dir);
//   · a missing entry is ignored (no failure, and the surviving files stay);
//   · NOTHING outside the dir is ever the target: an entry that is only separators, and an
//     entry with a `..` segment (which `path.join` resolves UPWARD — on `<home>/.qwen` that is
//     the user's whole home directory), are both refused. The earlier version of this header
//     called the separator-only case "the one way this step could destroy everything"; that was
//     false, and `..` was the case it missed;
//   · every dir in the list is processed (multi-instance, research G11).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { removeCliResetEntries } from "../../cli-reload/deletePaths.ts";

const seedProfileDir = Effect.fn("seedProfileDir")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, "profile");
  yield* fs.makeDirectory(path.join(dir, "b"), { recursive: true });
  yield* fs.makeDirectory(path.join(dir, "d", "nested"), { recursive: true });
  yield* fs.writeFileString(path.join(dir, "a"), "session token");
  yield* fs.writeFileString(path.join(dir, "b", "c.ext"), "nested state");
  yield* fs.writeFileString(path.join(dir, "d", "nested", "deep.json"), "{}");
  yield* fs.writeFileString(path.join(dir, "keep.json"), "user data");
  // An entry whose NAME begins with two dots. It resolves INSIDE the dir, so it must be
  // removable — "starts with `..`" is not a containment test (adversary R2-3).
  yield* fs.writeFileString(path.join(dir, "..cache"), "dot-dot-named, but inside");
  return dir;
});

it.effect("removes every entry under every dir, keeps everything else", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-cli-reset-" });
    const dirOne = yield* seedProfileDir(path.join(root, "one"));
    const dirTwo = yield* seedProfileDir(path.join(root, "two"));

    yield* removeCliResetEntries({
      dirs: [dirOne, dirTwo],
      // `b/c.ext` is the posix-spelled nested entry; `d/` is the directory spelling;
      // `missing/gone.json` never existed; `/` and `` must leave the dir alone.
      entries: [
        "a",
        "b/c.ext",
        "d/",
        "missing/gone.json",
        "/",
        "",
        "..",
        "../..",
        "b/../../escape",
        // Inside the dir despite the leading dots — must be REMOVED, not refused.
        "..cache",
      ],
    });

    for (const dir of [dirOne, dirTwo]) {
      assert.isFalse(yield* fs.exists(path.join(dir, "a")), `${dir}: plain entry removed`);
      assert.isFalse(
        yield* fs.exists(path.join(dir, "b", "c.ext")),
        `${dir}: posix-spelled nested entry joined natively and removed`,
      );
      assert.isFalse(
        yield* fs.exists(path.join(dir, "d")),
        `${dir}: directory entry removed recursively`,
      );
      assert.isTrue(yield* fs.exists(path.join(dir, "b")), `${dir}: the parent dir survives`);
      assert.isTrue(
        yield* fs.exists(path.join(dir, "keep.json")),
        `${dir}: an unlisted file is never touched`,
      );
      assert.isFalse(
        yield* fs.exists(path.join(dir, "..cache")),
        `${dir}: a listed entry named "..cache" resolves INSIDE the dir and must be removed`,
      );
      assert.isTrue(yield* fs.exists(dir), `${dir}: the profile dir itself survives`);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an entry that escapes the profile dir is refused — the parent survives", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-cli-reset-" });
    // The production shape: the profile dir sits INSIDE a home that must never be touched.
    const home = path.join(root, "home");
    const dir = yield* seedProfileDir(home);
    yield* fs.writeFileString(path.join(home, "Documents.txt"), "the user's data");

    yield* removeCliResetEntries({
      dirs: [dir],
      // `path.join(dir, "..")` resolves to `home`; `../..` to `root`. Both would be removed
      // recursive+force without the containment check (adversary A-4).
      entries: ["..", "../..", "b/../../Documents.txt", "./.."],
    });

    assert.isTrue(yield* fs.exists(home), "the profile dir's PARENT survives");
    assert.isTrue(
      yield* fs.exists(path.join(home, "Documents.txt")),
      "a file beside the profile dir survives",
    );
    assert.isTrue(yield* fs.exists(root), "the grandparent survives");
    assert.isTrue(yield* fs.exists(dir), "the profile dir itself survives");
    assert.isTrue(yield* fs.exists(path.join(dir, "a")), "and nothing inside it was touched");
    assert.isTrue(
      yield* fs.exists(path.join(dir, "..cache")),
      "an inside-the-dir entry is not collateral damage of refusing the escapes",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an empty dir list and an empty entry list are both no-ops", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ru-code-cli-reset-" });
    const dir = yield* seedProfileDir(root);

    // Ships EMPTY (owner ruling R10): the whole feature must be inert with no entries.
    yield* removeCliResetEntries({ dirs: [dir], entries: [] });
    // A dir that resolved to "" (the CLI left on its own default) is skipped, not joined.
    yield* removeCliResetEntries({ dirs: [""], entries: ["a"] });

    assert.isTrue(yield* fs.exists(path.join(dir, "a")));
    assert.isTrue(yield* fs.exists(path.join(dir, "b", "c.ext")));
    assert.isTrue(yield* fs.exists(path.join(dir, "keep.json")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
