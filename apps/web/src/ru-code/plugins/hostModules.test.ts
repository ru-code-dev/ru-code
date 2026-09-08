// @effect-diagnostics nodeBuiltinImport:off -- this suite reads the generated entry files off disk
// ru-code: DRIFT GUARD for the host-provided module entries (mvp-plan D13).
//
// `HOST_PROVIDED_MODULES` is the single source of truth for what a plugin may import by name
// (SDK contracts; the check is EXACT-match since A1 phase 2). Three things must agree with it:
// the generated entry modules on disk, the Rollup inputs the Vite plugin declares, and the
// import map in the built html (`hostModulesDist.test.ts` covers the last one). If the SDK
// list grows and nobody re-runs `scripts/gen-host-modules.mjs`, a plugin externalises a
// specifier, builds green, and dies in the page with an unresolvable import — so the
// disagreement has to fail HERE, in T0, not there.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HOST_PROVIDED_MODULES } from "@smart-tools/plugin-sdk/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hostModuleEntryName, hostModuleSlug, hostModuleSlugs } from "./hostModuleSlug";
import { hostModuleInputs } from "./hostModulesVitePlugin";

const pluginsDir = NodePath.dirname(new URL(import.meta.url).pathname);
const webRoot = NodePath.resolve(pluginsDir, "../../..");
const generatedDir = NodePath.join(pluginsDir, "hostModules");

const specifiers = HOST_PROVIDED_MODULES.map((entry) => entry.specifier);

describe("slug", () => {
  it("drops the scope's @ and flattens subpaths, readably", () => {
    expect(hostModuleSlug("react")).toBe("react");
    expect(hostModuleSlug("react/jsx-runtime")).toBe("react__jsx-runtime");
    expect(hostModuleSlug("@base-ui/react/dialog")).toBe("base-ui__react__dialog");
    expect(hostModuleSlug("@smart-tools/qwen-cli-ui-kit")).toBe("smart-tools__qwen-cli-ui-kit");
  });

  it("is injective over the whole contract", () => {
    expect(() => hostModuleSlugs(specifiers)).not.toThrow();
    expect(new Set(specifiers.map(hostModuleSlug)).size).toBe(specifiers.length);
  });

  it("refuses a collision instead of silently overwriting an entry", () => {
    expect(() => hostModuleSlugs(["a/b", "@a/b"])).toThrow(/slug collision/);
  });
});

describe("generated entries", () => {
  const files = NodeFS.readdirSync(generatedDir).filter((name) => name.endsWith(".ts"));

  it("is exactly one file per contract specifier — no extras, no gaps", () => {
    expect([...files].sort()).toEqual(specifiers.map((s) => `${hostModuleSlug(s)}.ts`).sort());
  });

  it.each(specifiers)("%s re-exports its own specifier and nothing else", (specifier) => {
    const source = NodeFS.readFileSync(
      NodePath.join(generatedDir, `${hostModuleSlug(specifier)}.ts`),
      "utf8",
    );
    const quoted = [...source.matchAll(/ from "([^"]+)";/g)].map((match) => match[1]);
    expect(quoted.length).toBeGreaterThan(0);
    expect(new Set(quoted)).toEqual(new Set([specifier]));
    // Either the ESM star form or the explicit CJS-interop name list, never neither.
    expect(/export \* from|export \{/.test(source)).toBe(true);
  });
});

describe("rollup inputs", () => {
  const inputs = hostModuleInputs(webRoot);

  it("declares one entry per specifier, named so the chunk lands under assets/host-modules/", () => {
    expect(Object.keys(inputs).sort()).toEqual(specifiers.map(hostModuleEntryName).sort());
    for (const name of Object.keys(inputs)) {
      expect(name.startsWith("host-modules/")).toBe(true);
    }
  });

  it("points every entry at a file that exists", () => {
    for (const file of Object.values(inputs)) {
      expect(NodeFS.existsSync(file)).toBe(true);
    }
  });
});

// ru-code: A4 finding L3 — the five CJS entries pin an EXPLICIT list of named exports
// (`export *` from a CommonJS package re-exports nothing, measured on the first build). That
// list is a snapshot of a runtime fact, so it drifts silently: a React minor that adds an
// export leaves it unimportable by every plugin, and one that removes an export makes the
// generated entry fail to build. Assert the list against the real module instead of trusting
// the generator's last run.
describe("generated CJS entries agree with the real module (A4 L3)", () => {
  /** The names a generated entry re-exports, and whether it forwards a default. */
  const readGeneratedExports = (
    specifier: string,
  ): { names: ReadonlyArray<string>; hasDefault: boolean } | null => {
    const source = NodeFS.readFileSync(
      NodePath.join(generatedDir, `${hostModuleSlug(specifier)}.ts`),
      "utf8",
    );
    if (source.includes("export * from")) return null; // an ESM entry — nothing to pin
    const names: string[] = [];
    let hasDefault = false;
    for (const block of source.matchAll(/export \{([^}]*)\} from "[^"]+";/g)) {
      for (const raw of (block[1] ?? "").split(",")) {
        const name = raw.trim();
        if (name === "") continue;
        if (name === "default") hasDefault = true;
        else names.push(name);
      }
    }
    return { names, hasDefault };
  };

  const cjsSpecifiers = specifiers.filter((specifier) => readGeneratedExports(specifier) !== null);

  it("finds the CJS entries the generator wrote explicit lists for", () => {
    // If this set ever empties, the assertions below would pass vacuously.
    expect(cjsSpecifiers.length).toBeGreaterThan(0);
    expect(cjsSpecifiers).toContain("react");
  });

  it.each(cjsSpecifiers)(
    "%s re-exports exactly the names the module really has",
    async (specifier) => {
      const generated = readGeneratedExports(specifier);
      expect(generated).not.toBeNull();
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      // Vite's interop namespace carries the CJS named exports plus `default` (and, in dev,
      // `__esModule`); neither belongs in the generated NAME list.
      const runtimeNames = Object.keys(module)
        .filter((name) => name !== "default" && name !== "__esModule")
        .sort();
      expect([...generated!.names].sort()).toEqual(runtimeNames);
      expect(generated!.hasDefault).toBe("default" in module);
    },
  );
});
