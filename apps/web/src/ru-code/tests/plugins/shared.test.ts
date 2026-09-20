// ru-code v2: `shared.json` is the ONE place the shared-runtime list lives on the host side, and
// `SHARED_PACKAGES` in the SDK is its mirror (rules.md §2.8). The two sit in different repositories
// and are read by different machines — the app's build emits the import map from this file, a
// plugin's build marks the SDK's copy external — so this is the only place both are reachable, and
// therefore the only place the drift between them can be caught.
import { SHARED_PACKAGES } from "@smart-tools/plugin-sdk/contracts";
import { describe, expect, it } from "vite-plus/test";

import sharedJson from "../../plugins/shared.json";

describe("shared.json", () => {
  it("is exactly the SDK's SHARED_PACKAGES, specifier for specifier and major for major", () => {
    expect(sharedJson).toEqual(
      Object.fromEntries(SHARED_PACKAGES.map((entry) => [entry.specifier, entry.major])),
    );
  });

  it("keeps the React family, which is the one MANDATORY membership", () => {
    // Two React copies in one tree break hooks silently — no error, a panel that renders nothing.
    // Every other entry is a policy call; these four are why the mechanism exists at all.
    for (const specifier of ["react", "react/jsx-runtime", "react-dom", "react-dom/client"]) {
      expect(Object.keys(sharedJson)).toContain(specifier);
    }
  });

  it("stays under the cap — adding an entry is a decisions.md entry, not a code edit", () => {
    // 8 through S4; V2-18 raised it to 10 for the two `effect/unstable` barrels.
    expect(Object.keys(sharedJson).length).toBeLessThanOrEqual(10);
  });

  it("does NOT publish the libraries a plugin is expected to bundle", () => {
    // `lucide-react` is installed here and deliberately absent: hosting its root barrel would pin
    // the whole library (≈ 1 MB) into every user's dist, installed plugins or not, while it
    // tree-shakes to a few KB inside a plugin's own bundle. The ui-kit is a packages-only library
    // (V2-16), not app infrastructure, so it is bundled too.
    expect(Object.keys(sharedJson)).not.toContain("lucide-react");
    expect(Object.keys(sharedJson)).not.toContain("@smart-tools/qwen-cli-ui-kit");
    expect(Object.keys(sharedJson)).not.toContain("recharts");
  });

  it("publishes the two V2-13 additions as ROOT barrels only", () => {
    // `@base-ui/react` does NOT tree-shake per plugin — every primitive drags the same
    // floating/field/use-render core, measured at 150–185 KB apiece — and `@pierre/diffs` dragged
    // shiki plus 319 lazy grammar chunks (10.4 MB) into `plugin-catalogs/dist`. The app ships both
    // already, so it hosts each ONCE and the SDK folds base-ui's subpaths onto the root.
    expect(Object.keys(sharedJson)).toContain("@base-ui/react");
    expect(Object.keys(sharedJson)).toContain("@pierre/diffs");
    expect(Object.keys(sharedJson).filter((key) => key.startsWith("@base-ui/"))).toEqual([
      "@base-ui/react",
    ]);
    expect(Object.keys(sharedJson).filter((key) => key.startsWith("@pierre/"))).toEqual([
      "@pierre/diffs",
    ]);
  });

  it("stamps the MAJOR each library is actually installed at", () => {
    // The host refuses a plugin whose `shared` majors differ from its own, so a major written here
    // that the app does not really ship would skip every plugin with no way to tell why.
    expect(sharedJson["@base-ui/react"]).toBe("1");
    expect(sharedJson["@pierre/diffs"]).toBe("1");
  });

  it("shares effect as BARRELS — three of them, and no module below one", () => {
    // An import map maps concrete specifiers; enumerating effect's ~200 modules is the 50-entry
    // mistake v1 made. The SDK build redirects `effect/<Module>` onto the root, and (V2-18)
    // `effect/unstable/<group>/<Module>` onto its group barrel.
    expect(Object.keys(sharedJson).filter((key) => key.startsWith("effect"))).toEqual([
      "effect",
      "effect/unstable/reactivity",
      "effect/unstable/rpc",
    ]);
    // Every effect entry carries the SAME major: they are one installed package.
    for (const key of Object.keys(sharedJson).filter((k) => k.startsWith("effect"))) {
      expect(sharedJson[key as keyof typeof sharedJson]).toBe("4");
    }
  });

  it("publishes the two V2-18 additions because they are NOT plugin-local", () => {
    // The S4 theory was that `effect/unstable/*` exchanges no identity with the host and can be
    // bundled per plugin. Measured, it is not local at all: effect's modules reach the rest of
    // effect by RELATIVE import, so `import { AtomRegistry } from "effect/unstable/reactivity"`
    // pulled 73 effect modules (109 kB, a partial second effect graph) into `plugin-catalogs`.
    // The app ships both subtrees itself, so hosting them costs it nothing new.
    expect(Object.keys(sharedJson)).toContain("effect/unstable/reactivity");
    expect(Object.keys(sharedJson)).toContain("effect/unstable/rpc");
    // …and only those two: `effect/unstable/http`, `…/sql` and the rest stay bundled.
    expect(
      Object.keys(sharedJson).filter((key) => key.startsWith("effect/unstable/")),
    ).toHaveLength(2);
  });
});
