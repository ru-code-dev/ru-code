// ru-code (V2-20): what the INSTALL channel does with the shipped plugin set.
//
// The whole design rests on one claim about the installer: it has no per-file knowledge. `remove_bin`
// deletes `<APP_ROOT>/bin` and `install_files` is `cp -R "$EXTRACTED_DIR/." "$BIN_DIR/"`, so a new
// subdirectory inside the version payload rides along for free — and everything BESIDE `bin/`
// (`<APP_ROOT>/plugins`, `<APP_ROOT>/userdata`) is out of its reach entirely.
//
// That claim is exactly what must never regress, so it is asserted from both sides:
// the shipped set lands under `bin/versions/<v>/plugins`, and a user plugin plus a plugin's data
// are BYTE-IDENTICAL after a re-install that wiped bin/ first. No installer change was made for any
// of this; these specs exist to keep it that way.
import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval, writeFakeRelease, type Sandbox } from "./harness.ts";

const EXTRACT_AND_INSTALL = `extract_archive\ninstall_files`;

function baseGlobals(sb: Sandbox, tarball: string): Record<string, string> {
  return {
    ARCHIVE_PATH: tarball,
    TEMP_DIR: sb.path("tmp"),
    BIN_DIR: sb.path("app/.ru-code/bin"),
    APP_BIN: "ru-code",
    NODE_PATH: process.execPath,
  };
}

/** The two things beside `bin/` that must survive every install: a user plugin and plugin DATA. */
function seedUserState(sb: Sandbox): void {
  sb.write("app/.ru-code/plugins/mine/plugin.json", `{"id":"mine","name":"mine"}\n`);
  sb.write("app/.ru-code/plugins/mine/web/index.mjs", "export const mine = true;\n");
  sb.write("app/.ru-code/userdata/plugins/analytics/data.sqlite", "PRETEND-SQLITE-BYTES");
  sb.write("app/.ru-code/userdata/plugins/disabled.json", `{"disabled":["catalogs"]}\n`);
}

function expectUserStateIntact(sb: Sandbox): void {
  expect(sb.read("app/.ru-code/plugins/mine/plugin.json")).toBe(`{"id":"mine","name":"mine"}\n`);
  expect(sb.read("app/.ru-code/plugins/mine/web/index.mjs")).toBe("export const mine = true;\n");
  expect(sb.read("app/.ru-code/userdata/plugins/analytics/data.sqlite")).toBe(
    "PRETEND-SQLITE-BYTES",
  );
  expect(sb.read("app/.ru-code/userdata/plugins/disabled.json")).toBe(
    `{"disabled":["catalogs"]}\n`,
  );
}

describe("install — shipped plugins ride inside the version payload (V2-20)", () => {
  it("lands versions/<v>/plugins/<id> and leaves user plugins and plugin data untouched", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb, { shippedPlugins: ["analytics", "catalogs"] });
      sb.write("tmp/.keep", "");
      seedUserState(sb);

      const r = sourceEval(sb, EXTRACT_AND_INSTALL, { globals: baseGlobals(sb, tarball) });
      expect(r.status).toBe(0);

      // The shipped set, a sibling of client/ inside the payload.
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/plugins/analytics/plugin.json")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/plugins/analytics/web/index.mjs")).toBe(
        true,
      );
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/plugins/catalogs/plugin.json")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/client/index.html")).toBe(true);

      // …and nothing beside bin/ was touched. This is the "never delete a user plugin" proof.
      expectUserStateIntact(sb);
    } finally {
      sb.cleanup();
    }
  });

  // The repair/update path: `remove_bin` wipes `<APP_ROOT>/bin` wholesale before the copy, which is
  // what makes "the shipped set is replaced, never merged" true — and what makes it dangerous if it
  // ever grew a second target.
  it("a re-install replaces the shipped set wholesale and still spares everything beside bin/", () => {
    const sb = makeSandbox();
    try {
      const first = writeFakeRelease(sb, {
        version: "1.0.0",
        shippedPlugins: ["analytics", "catalogs"],
      });
      sb.write("tmp/.keep", "");
      seedUserState(sb);
      expect(sourceEval(sb, EXTRACT_AND_INSTALL, { globals: baseGlobals(sb, first) }).status).toBe(
        0,
      );
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/plugins/catalogs")).toBe(true);

      // A later release drops `catalogs` from the shipped set and bumps the rest.
      const second = writeFakeRelease(sb, { version: "1.1.0", shippedPlugins: ["analytics"] });
      // A FRESH extract dir: reusing the first run's would leave `versions/1.0.0` lying in it and
      // `cp -R "$EXTRACTED_DIR/."` would copy both versions forward — a fixture artefact, not the
      // installer's behaviour.
      sb.write("tmp2/.keep", "");
      const r = sourceEval(sb, `remove_bin\n${EXTRACT_AND_INSTALL}`, {
        globals: {
          ...baseGlobals(sb, second),
          TEMP_DIR: sb.path("tmp2"),
          APP_DIR_NAME: ".ru-code",
        },
      });
      expect(r.status).toBe(0);

      expect(sb.exists("app/.ru-code/bin/versions/1.1.0/plugins/analytics/plugin.json")).toBe(true);
      // Gone with its version, not merged forward.
      expect(sb.exists("app/.ru-code/bin/versions/1.1.0/plugins/catalogs")).toBe(false);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0")).toBe(false);
      // The removed plugin's DATA stays (D11) — as does the user's own plugin.
      expectUserStateIntact(sb);
    } finally {
      sb.cleanup();
    }
  });

  // A release need not ship plugins (a fork, a minimal build, a clone with no packages checkout):
  // `validate_archive` must not have grown `plugins/` as a required member.
  it("a payload with no plugins/ still validates and installs", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `extract_archive\nvalidate_archive\ninstall_files`, {
        globals: { ...baseGlobals(sb, tarball), APP_VERSION: "1.0.0" },
      });
      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/cli.js")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/plugins")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});
