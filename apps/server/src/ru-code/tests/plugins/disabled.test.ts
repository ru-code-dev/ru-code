// ru-code (V2-21): the operator's opt-out list.
//
// Every case here is about ONE property: a file the operator hand-edits can never take the app
// down and can never disable something it did not name. So the failure modes — absent, empty,
// not JSON, wrong shape, wrong types — all collapse to the same answer, the empty set, and the
// only thing that varies is whether the operator is told.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import {
  DISABLED_BY_MANIFEST,
  DISABLED_BY_OPERATOR,
  DISABLED_PLUGINS_FILENAME,
  disabledPluginsPath,
  pluginSkipReason,
  readDisabledPlugins,
  readPluginEnablement,
  type PluginEnablementFile,
} from "../../plugins/disabled.ts";

/** A fresh base dir, with `userdata/plugins/disabled.json` written when `content` is given. */
const withList = <A, E>(
  content: string | undefined,
  body: Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* Effect.orDie(
      fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-disabled-" }),
    );
    if (content !== undefined) {
      const dir = path.join(baseDir, "userdata", "plugins");
      yield* Effect.orDie(fs.makeDirectory(dir, { recursive: true }));
      yield* Effect.orDie(fs.writeFileString(path.join(dir, DISABLED_PLUGINS_FILENAME), content));
    }
    return yield* body.pipe(Effect.provide(ServerConfig.layerTest(baseDir, baseDir)));
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("disabledPluginsPath", (it) => {
  // It must NOT be under the plugins directory: `RU_CODE_PLUGINS_DIR` relocates where plugin CODE
  // is read from, and an opt-out that moved with a test fixture would be useless in production.
  it.effect("is <stateDir>/plugins/disabled.json, beside the plugin data folders", () =>
    withList(
      undefined,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        expect(yield* disabledPluginsPath).toBe(`${config.stateDir}/plugins/disabled.json`);
      }),
    ),
  );
});

describe("readDisabledPlugins", () => {
  it.layer(NodeServices.layer)("reads the list", (it) => {
    it.effect("the named ids, trimmed", () =>
      withList(
        JSON.stringify({ disabled: ["analytics", "  catalogs  ", ""] }),
        Effect.gen(function* () {
          expect([...(yield* readDisabledPlugins)].sort()).toEqual(["analytics", "catalogs"]);
        }),
      ),
    );

    it.effect("an empty list disables nothing", () =>
      withList(
        JSON.stringify({ disabled: [] }),
        Effect.gen(function* () {
          expect(yield* readDisabledPlugins).toEqual(new Set());
        }),
      ),
    );

    // An id nobody installed is inert, not an error: the operator may be disabling something ahead
    // of an update that will ship it.
    it.effect("an id that matches no plugin is kept and simply never matches", () =>
      withList(
        JSON.stringify({ disabled: ["not-installed"] }),
        Effect.gen(function* () {
          expect(yield* readDisabledPlugins).toEqual(new Set(["not-installed"]));
        }),
      ),
    );
  });

  it.layer(NodeServices.layer)("never throws and never guesses", (it) => {
    const unreadable: ReadonlyArray<{ readonly label: string; readonly content: string }> = [
      { label: "not JSON at all", content: "{ disabled: [analytics] }" },
      { label: "an array instead of an object", content: `["analytics"]` },
      { label: "the wrong key", content: JSON.stringify({ plugins: ["analytics"] }) },
      { label: "ids that are not strings", content: JSON.stringify({ disabled: [1, true] }) },
      { label: "empty file", content: "" },
      { label: "JSON null", content: "null" },
    ];

    for (const testCase of unreadable) {
      it.effect(`${testCase.label} disables NOTHING`, () =>
        withList(
          testCase.content,
          Effect.gen(function* () {
            expect(yield* readDisabledPlugins).toEqual(new Set());
          }),
        ),
      );
    }

    it.effect("a missing file disables nothing", () =>
      withList(
        undefined,
        Effect.gen(function* () {
          expect(yield* readDisabledPlugins).toEqual(new Set());
        }),
      ),
    );

    // The directory existing but the file not is the shape a fresh install has the moment any
    // plugin writes its first row of data.
    it.effect("a plugins state directory with no list disables nothing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* Effect.orDie(
          fs.makeTempDirectoryScoped({ prefix: "ru-code-plugin-disabled-" }),
        );
        yield* Effect.orDie(
          fs.makeDirectory(path.join(baseDir, "userdata", "plugins", "analytics"), {
            recursive: true,
          }),
        );
        expect(
          yield* readDisabledPlugins.pipe(Effect.provide(ServerConfig.layerTest(baseDir, baseDir))),
        ).toEqual(new Set());
      }).pipe(Effect.scoped),
    );
  });
});

// ru-code S38 (V2-43): the file answers "on" as well as "off", and the user's answer beats the
// manifest in BOTH directions.
describe("readPluginEnablement", () => {
  it.layer(NodeServices.layer)("the two lists", (it) => {
    it.effect("a V2-21 file — `disabled` only — still decodes and still means what it meant", () =>
      withList(
        JSON.stringify({ disabled: ["analytics"] }),
        Effect.gen(function* () {
          const file = yield* readPluginEnablement;
          expect([...file.disabled]).toEqual(["analytics"]);
          expect(
            [...file.enabled],
            "no `enabled` key is not an empty decision, it is none",
          ).toEqual([]);
        }),
      ),
    );

    it.effect("reads both lists, trimmed and blank-free", () =>
      withList(
        JSON.stringify({ disabled: ["analytics", " ", ""], enabled: ["  project-settings  "] }),
        Effect.gen(function* () {
          const file = yield* readPluginEnablement;
          expect([...file.disabled]).toEqual(["analytics"]);
          expect([...file.enabled]).toEqual(["project-settings"]);
        }),
      ),
    );

    it.effect("an unreadable file decides nothing at all", () =>
      withList(
        "{ not json",
        Effect.gen(function* () {
          const file = yield* readPluginEnablement;
          expect(file.disabled).toEqual(new Set());
          expect(file.enabled).toEqual(new Set());
        }),
      ),
    );

    it.effect("an `enabled` of the wrong TYPE is the same as an unreadable file", () =>
      withList(
        JSON.stringify({ disabled: [], enabled: "project-settings" }),
        Effect.gen(function* () {
          const file = yield* readPluginEnablement;
          expect(file.enabled).toEqual(new Set());
        }),
      ),
    );
  });
});

describe("pluginSkipReason (V2-43)", () => {
  const file = (
    disabled: ReadonlyArray<string>,
    enabled: ReadonlyArray<string>,
  ): PluginEnablementFile => ({ disabled: new Set(disabled), enabled: new Set(enabled) });

  it("says nothing about a plugin nobody switched and whose manifest ships it on", () => {
    expect(pluginSkipReason(file([], []), "demo", true)).toBeNull();
  });

  it("a manifest that ships it OFF is a skip, with its own reason", () => {
    expect(pluginSkipReason(file([], []), "demo", false)).toBe(DISABLED_BY_MANIFEST);
  });

  it("the user's OFF beats a manifest that ships it on", () => {
    expect(pluginSkipReason(file(["demo"], []), "demo", true)).toBe(DISABLED_BY_OPERATOR);
  });

  it("the user's ON beats a manifest that ships it off — the whole point of the second list", () => {
    expect(pluginSkipReason(file([], ["demo"]), "demo", false)).toBeNull();
  });

  it("an id in BOTH lists is OFF: the only reading of an ambiguous file that runs no code", () => {
    expect(pluginSkipReason(file(["demo"], ["demo"]), "demo", true)).toBe(DISABLED_BY_OPERATOR);
    expect(pluginSkipReason(file(["demo"], ["demo"]), "demo", false)).toBe(DISABLED_BY_OPERATOR);
  });

  it("is keyed on the id, so one plugin's switch says nothing about another's", () => {
    expect(pluginSkipReason(file(["demo"], []), "catalogs", true)).toBeNull();
    expect(pluginSkipReason(file([], ["demo"]), "catalogs", false)).toBe(DISABLED_BY_MANIFEST);
  });
});
