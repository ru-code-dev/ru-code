// ru-code: unit-tests the pure locale-decision behind cliBootLocale — the pre-parse that pins
// the process locale before any flag description is constructed, so `--lang en` flips `--help`
// to English and the default stays Russian. The rendered-help side is covered by hiddenFlags.test.
import { assert, describe, it } from "@effect/vitest";

import { readLocaleFromArgv, resolveCliLocale } from "../../cliBootLocale.ts";

describe("readLocaleFromArgv", () => {
  it("reads the space form for both the long flag and the alias", () => {
    assert.strictEqual(readLocaleFromArgv(["--language", "en"]), "en");
    assert.strictEqual(readLocaleFromArgv(["--lang", "en"]), "en");
    assert.strictEqual(readLocaleFromArgv(["node", "bin.js", "--lang", "ru"]), "ru");
  });

  it("reads the `=` form for both the long flag and the alias", () => {
    assert.strictEqual(readLocaleFromArgv(["--language=en"]), "en");
    assert.strictEqual(readLocaleFromArgv(["--lang=ru"]), "ru");
  });

  it("ignores a missing or invalid value", () => {
    assert.strictEqual(readLocaleFromArgv(["--lang"]), undefined);
    assert.strictEqual(readLocaleFromArgv(["--lang", "de"]), undefined);
    assert.strictEqual(readLocaleFromArgv(["--lang=fr"]), undefined);
  });

  it("returns undefined when no language flag is present", () => {
    assert.strictEqual(readLocaleFromArgv(["--port", "3000", "start"]), undefined);
  });

  it("lets the last occurrence win", () => {
    assert.strictEqual(readLocaleFromArgv(["--lang", "ru", "--lang", "en"]), "en");
  });
});

describe("resolveCliLocale", () => {
  it("an explicit flag beats the T3CODE_LANG env var", () => {
    assert.strictEqual(resolveCliLocale(["--lang", "en"], { T3CODE_LANG: "ru" }), "en");
  });

  it("falls back to the env var when there is no flag", () => {
    assert.strictEqual(resolveCliLocale([], { T3CODE_LANG: "en" }), "en");
  });

  it("ignores an invalid env value", () => {
    assert.strictEqual(resolveCliLocale([], { T3CODE_LANG: "klingon" }), undefined);
  });

  it("returns undefined when neither is set (the default Russian stands)", () => {
    assert.strictEqual(resolveCliLocale([], {}), undefined);
    assert.strictEqual(resolveCliLocale([], undefined), undefined);
  });
});
