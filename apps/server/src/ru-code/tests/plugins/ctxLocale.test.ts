// ru-code: plugins — `ServerCtx.locale()`, the app's CURRENT language (V2-51).
//
// The seam exists because not every server-side sentence a plugin produces can become a message
// code the web half renders. Some are INPUTS to a string-typed library API the plugin wraps — the
// sentence is already inside a report row by the time it crosses the seam — so that plugin's
// server half still has to say those in the user's language, and only the host knows which one
// that is.
//
// The whole contract is "a function, not a string", and that is what this file pins. `serverSettings.ts`
// calls `setLocale` whenever the user changes the setting; a ctx that captured the language at
// build time would answer the one the server booted with for the life of the process, and nothing
// else in the app would notice — the plugin would just be quietly wrong in one language.
import { afterAll, describe, expect, it } from "vite-plus/test";

import { getLocale, setLocale } from "@ru-code/localization";

import { makeServerCtx } from "../../plugins/ctx.ts";

const ctx = () =>
  makeServerCtx({
    id: "demo",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    storage: {} as never,
    paths: { dataDir: "/tmp/d", cacheDir: "/tmp/c" } as never,
    projects: {} as never,
    // V2-58: the host always supplies the state sink; this suite only reads `locale()`.
    publish: () => {},
  });

const booted = getLocale();
afterAll(() => {
  setLocale(booted);
});

describe("ServerCtx.locale (V2-51)", () => {
  it("answers the app's current language", () => {
    setLocale("ru");
    expect(ctx().locale()).toBe("ru");
    setLocale("en");
    expect(ctx().locale()).toBe("en");
  });

  it("re-reads on EVERY call — a ctx built before the change follows it", () => {
    setLocale("en");
    const built = ctx();
    expect(built.locale()).toBe("en");
    setLocale("ru");
    expect(built.locale()).toBe("ru");
  });

  it("answers one of the two locales the SDK's type admits, never undefined", () => {
    setLocale("ru");
    // `PluginLocale` is `"en" | "ru"`; a plugin branches on it with no default arm.
    expect(["en", "ru"]).toContain(ctx().locale());
  });
});
