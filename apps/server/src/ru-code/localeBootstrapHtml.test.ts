import { assert, describe, it } from "@effect/vitest";

import { setLocale } from "@ru-code/localization";

import { injectLocaleBootstrap } from "./localeBootstrapHtml.ts";

describe("injectLocaleBootstrap", () => {
  it("stamps the effective locale as a synchronous global at the top of <head>", () => {
    setLocale("en");
    const html =
      '<!doctype html><html lang="en"><head>\n<title>Ru Code</title></head><body></body></html>';
    const out = injectLocaleBootstrap(html);

    assert.include(out, '<head><script>window.__RU_LOCALE__="en";</script>');
    // The seed must run before anything else in the document (before the app bundle),
    // otherwise the frozen module-level L() constants evaluate at the default locale.
    assert.isBelow(out.indexOf("__RU_LOCALE__"), out.indexOf("<title>"));
  });

  it("reflects the current server locale (this is what makes the switch land)", () => {
    setLocale("ru");
    assert.include(injectLocaleBootstrap("<head></head>"), 'window.__RU_LOCALE__="ru"');
    setLocale("en");
    assert.include(injectLocaleBootstrap("<head></head>"), 'window.__RU_LOCALE__="en"');
  });

  it("leaves the document untouched when there is no <head> to anchor to", () => {
    setLocale("en");
    const html = "<html><body></body></html>";
    assert.equal(injectLocaleBootstrap(html), html);
  });
});
