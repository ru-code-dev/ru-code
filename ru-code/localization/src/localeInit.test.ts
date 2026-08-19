// ru-code: MODULE-INIT locale correctness — the guard for the frozen-const class of bugs.
//
// A module-level `const x = L(en, ru)` evaluates ONCE, at the first evaluation of the module
// that defines it — which, under production chunking, can be BEFORE the app entry's
// bootLocale() runs: Rollup concatenates the locale module and its co-located consumers into
// one shared chunk, and importing ANYTHING from that chunk evaluates EVERYTHING in it, ahead
// of the entry chunk's own statements. (Real instance: `CLI_PROFILES.description` in
// @ru-code/branding rendered Russian in an all-English UI.)
//
// The only ordering that IS guaranteed: the server stamps `window.__RU_LOCALE__` into the
// served HTML before any module script executes. Therefore the locale module itself must read
// the stamp at ITS OWN init — then a frozen const is correct in every chunk layout, and the
// entry's bootLocale() is merely a backstop. These tests fresh-import the module under a
// stubbed `window` and assert the very-first-evaluation locale — exactly what a module-level
// const captures.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("locale module INIT reads the server-stamped window.__RU_LOCALE__", () => {
  it("RU stamp wins over the vitest EN default at first evaluation (module-const case)", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { __RU_LOCALE__: "ru" });
    const fresh = await import("./locale.ts");
    // Exactly what `const description = L(en, ru)` at module scope would capture:
    expect(fresh.getLocale()).toBe("ru");
    expect(
      fresh.L("Uses the CLI detected at startup.", "Использует CLI, обнаруженный при запуске."),
    ).toBe("Использует CLI, обнаруженный при запуске.");
  });

  it("EN stamp wins over the production RU default (the reported bug: EN UI, Russian consts)", async () => {
    vi.resetModules();
    vi.stubEnv("VITEST", ""); // simulate a production (non-test) process
    vi.stubGlobal("window", { __RU_LOCALE__: "en" });
    const fresh = await import("./locale.ts");
    expect(fresh.getLocale()).toBe("en");
    expect(
      fresh.L("Uses the CLI detected at startup.", "Использует CLI, обнаруженный при запуске."),
    ).toBe("Uses the CLI detected at startup.");
  });

  it("no / garbage stamp → existing defaults unchanged (vitest → en; production → ru)", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { __RU_LOCALE__: "de" }); // not a Locale — must be ignored
    const underVitest = await import("./locale.ts");
    expect(underVitest.getLocale()).toBe("en"); // vitest EN-identity default preserved

    vi.resetModules();
    vi.stubEnv("VITEST", "");
    const production = await import("./locale.ts");
    expect(production.getLocale()).toBe("ru"); // shipped RU default preserved
  });
});
