// ru-code v2: the pure halves of the import-map plugin — entry naming, the map's text, and where
// it is inserted. The BUILT artefact is asserted by `sharedModulesDist.test.ts`; this suite is the
// part that can fail without a build, and the two together replace v1's 300-line drift test.
import { describe, expect, it } from "vite-plus/test";

import {
  SHARED_SPECIFIERS,
  injectImportMap,
  renderImportMap,
  sharedEntryName,
} from "../../plugins/sharedModulesVitePlugin";

describe("sharedEntryName", () => {
  it("turns a specifier into a file-ish, injective entry name", () => {
    expect(sharedEntryName("react")).toBe("shared-react");
    expect(sharedEntryName("react/jsx-runtime")).toBe("shared-react__jsx-runtime");
    expect(sharedEntryName("react-dom/client")).toBe("shared-react-dom__client");
  });

  it("is injective over the whole shared list", () => {
    // A collision would silently point two specifiers at one chunk, and one of them would resolve
    // to the wrong module with no error anywhere.
    const names = SHARED_SPECIFIERS.map(sharedEntryName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("renderImportMap", () => {
  it("emits one script tag mapping every specifier to its chunk", () => {
    const script = renderImportMap([
      { specifier: "react", url: "/assets/shared-react-abc.js" },
      { specifier: "zustand", url: "/assets/shared-zustand-def.js" },
    ]);
    expect(script).toBe(
      '<script type="importmap">{"imports":{"react":"/assets/shared-react-abc.js","zustand":"/assets/shared-zustand-def.js"}}</script>',
    );
  });
});

describe("injectImportMap", () => {
  const script = '<script type="importmap">{}</script>';

  it("puts the map immediately after <head>, ahead of every module script and preload", () => {
    const html =
      '<!doctype html><html><head><link rel="modulepreload" href="/a.js"><script type="module" src="/b.js"></script></head><body></body></html>';
    const out = injectImportMap(html, script);
    expect(out.indexOf(script)).toBeLessThan(out.indexOf("modulepreload"));
    expect(out.indexOf(script)).toBeLessThan(out.indexOf('type="module"'));
  });

  it("handles a <head> with attributes", () => {
    const out = injectImportMap('<html><head lang="ru"><title>x</title></head></html>', script);
    expect(out).toContain('<head lang="ru">');
    expect(out.indexOf(script)).toBeLessThan(out.indexOf("<title>"));
  });

  it("still emits the map when there is no <head> at all", () => {
    // Never silently drop it: a document with no head is a build we do not recognise, and a
    // missing map is a plugin that fails in the page with no build-time signal.
    expect(injectImportMap("<html><body></body></html>", script).startsWith(script)).toBe(true);
  });
});
