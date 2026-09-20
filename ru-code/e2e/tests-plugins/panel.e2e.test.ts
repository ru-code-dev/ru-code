// ru-code (A10) — spec 2: the footer icon, the panel, and the note round-trip.
//
// The visible half of the drop-in claim. Four things, each proving a different seam:
//
//  1. the footer icon is ATTACHED WITHIN 3 s of the app being usable, even though a sibling plugin
//     hangs for 10 s. `loadPlugins()` runs below `createRoot` and the registries are reactive
//     (A4 findings H2/M2) — if that regressed, the icon would appear only after the hang's budget
//     expired, and this is the assertion that would notice;
//  2. clicking it opens the panel and the panel's stylesheet is really applied (`.ru-demo-panel`'s
//     own rules, not browser defaults) — i.e. `web/styles.css` was linked and parsed;
//  3. the status line carries locale · theme · connection, all three read from the ctx SIGNALS by a
//     component the plugin owns, through the SDK's `useSignal` — which is `useSyncExternalStore`
//     from the HOST's React. A second React instance would have thrown "Invalid hook call" on
//     mount instead of rendering this line;
//  4. two notes go through `ctx.invoke` → the plugin's own SQLite file → back, survive a full page
//     reload (so they were written to disk, not held in the store), and a remove updates the list.
import {
  addDemoNote,
  clearDemoNotes,
  clickPanelControl,
  closeDemoPanel,
  demoFooterButton,
  demoNoteBodies,
  demoPanel,
  demoStatus,
  expect,
  openDemoPanel,
  state,
  test,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

/** The web loader's per-plugin budget is 10 s; the icon must be up long before the hang blows it. */
const ICON_BUDGET_MS = 3_000;

test.describe("plugins — footer icon, panel and the note round-trip", () => {
  test("the icon appears within 3 s, the panel renders on the host's hooks, notes round-trip and persist", async ({
    page,
  }) => {
    const startedAt = Date.now();
    await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
    // The APP first — it must be interactive without waiting for any plugin.
    await expect(page.getByRole("button", { name: /^(Настройки|Settings)$/ }).first()).toBeAttached(
      {
        timeout: 30_000,
      },
    );
    const appReadyMs = Date.now() - startedAt;
    // …then the plugin's icon, within its own budget measured from the app being ready. The
    // TIMEOUT is the assertion: blowing it is exactly the regression (a boot that waits on
    // `loadPlugins()` would surface the icon only after the hanging sibling's 10 s expires).
    await expect(
      demoFooterButton(page),
      `the demo icon must attach within ${String(ICON_BUDGET_MS)}ms of the app being ready, not after the hanging plugin's 10 s budget`,
    ).toBeAttached({ timeout: ICON_BUDGET_MS });
    const iconMs = Date.now() - startedAt;

    // A CLOSE-UP with the tooltip open: at 1440×900 the footer icons are 16 px and a full-viewport
    // shot cannot show that this one is the plugin's, or that its label is the manifest's.
    await demoFooterButton(page).hover();
    await expect(
      page
        .getByRole("tooltip")
        .filter({ hasText: /^(Демо|Demo)$/ })
        .first(),
    )
      .toBeVisible({ timeout: 10_000 })
      .catch(() => undefined);
    const iconBox = await demoFooterButton(page).boundingBox();
    // ru-code (A13): the options object is BUILT by the conditional rather than spread into a new
    // one — `unicorn/no-useless-spread` (a warning the repo's lint gate counts) flagged the spread,
    // and the two arms are the whole value anyway.
    await saveEvidenceScreenshot(
      page,
      "02-footer-icon",
      iconBox === null
        ? {}
        : {
            clip: {
              x: Math.max(0, iconBox.x - 24),
              y: Math.max(0, iconBox.y - 140),
              width: 420,
              height: 200,
            },
          },
    );
    await page.mouse.move(700, 400);

    // ── the panel ─────────────────────────────────────────────────────────────────────────────
    await openDemoPanel(page);
    const panelFacts = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="demo-panel"]');
      if (element === null) return null;
      const style = getComputedStyle(element);
      return {
        className: element.className,
        display: style.display,
        flexDirection: style.flexDirection,
        gap: style.gap,
        fontSize: style.fontSize,
        backgroundColor: style.backgroundColor,
        stylesheetLinks: [...document.querySelectorAll('link[rel="stylesheet"]')]
          .map((link) => link.getAttribute("href") ?? "")
          .filter((href) => href.includes("/plugins/")),
        right: element.getBoundingClientRect().right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(panelFacts, "the panel rendered").not.toBeNull();
    // `web/styles.css`: `.ru-demo-panel { display:flex; flex-direction:column; gap:10px; font-size:13px }`
    expect(panelFacts?.display).toBe("flex");
    expect(panelFacts?.flexDirection).toBe("column");
    expect(panelFacts?.gap).toBe("10px");
    expect(panelFacts?.fontSize).toBe("13px");
    expect(panelFacts?.stylesheetLinks).toContain("/plugins/demo/web/styles.css");
    // Geometry is recorded, not asserted: where the host docks an overlay panel is the app's
    // layout decision (and it moves with the window), while what this spec owns is that the
    // plugin's OWN stylesheet reached the page and applied.

    // ── the import map, and the ONE React it exists for ───────────────────────────────────────
    //
    // The shipped page must carry exactly ONE `<script type="importmap">` listing exactly the ten
    // shared specifiers — the mechanism that lets a dropped-in folder write `import { useState }
    // from "react"` at all. `sharedModulesDist.test.ts` asserts the same thing on the built file;
    // this is the browser's own view of it, which is the one that decides whether a plugin loads.
    const importMaps = await page.evaluate(() =>
      [...document.querySelectorAll('script[type="importmap"]')].map(
        (node) => node.textContent ?? "",
      ),
    );
    expect(importMaps, "exactly one import map in the shipped page").toHaveLength(1);
    const importedSpecifiers = Object.keys(
      (JSON.parse(importMaps[0] ?? "{}") as { imports?: Record<string, string> }).imports ?? {},
    ).sort();
    expect(importedSpecifiers, "exactly the ten shared specifiers").toEqual([
      // V2-13 added `@base-ui/react` (it does not tree-shake per plugin — every primitive drags the
      // same floating/field/use-render core) and `@pierre/diffs` (it dragged shiki plus 319 lazy
      // grammar chunks into a plugin folder). The app hosts each root barrel once.
      "@base-ui/react",
      "@pierre/diffs",
      "effect",
      // V2-18: effect's modules reach the rest of effect by RELATIVE import, so bundling these two
      // subtrees put a 73-module, 109 kB partial second effect graph inside `plugin-catalogs`.
      "effect/unstable/reactivity",
      "effect/unstable/rpc",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "zustand",
    ]);

    // ONE React, proven by walking the fibers rather than by inference.
    //
    // React tags every host node it owns with a `__reactFiber$<random>` property, and the random
    // suffix is generated ONCE per copy of react-dom's module body. So a node the APP rendered and
    // a node the PLUGIN rendered carrying the SAME key is the whole claim: the plugin's elements
    // were created by the app's React instance. A second copy would have given the plugin's
    // subtree a different suffix — and would have thrown "Invalid hook call" the moment the panel
    // called `useSignal`, which is why the panel rendering at all is the other half of the proof.
    const fiberKeys = await page.evaluate(() => {
      const keysOf = (selector: string): string[] => {
        const node = document.querySelector(selector);
        return node === null
          ? []
          : Object.keys(node).filter((key) => key.startsWith("__reactFiber$"));
      };
      return {
        app: keysOf('[data-slot="sidebar"]'),
        plugin: keysOf('[data-testid="demo-panel"]'),
        allInDocument: [
          ...new Set(
            [...document.querySelectorAll("*")].flatMap((node) =>
              Object.keys(node).filter((key) => key.startsWith("__reactFiber$")),
            ),
          ),
        ],
      };
    });
    expect(fiberKeys.plugin.length, "the plugin's panel is a React host node").toBeGreaterThan(0);
    expect(fiberKeys.app.length, "so is the app's sidebar").toBeGreaterThan(0);
    expect(fiberKeys.plugin, "the plugin's React IS the app's React").toEqual(fiberKeys.app);
    expect(
      fiberKeys.allInDocument,
      "and there is exactly one React instance in the whole document",
    ).toHaveLength(1);

    const statusLine = await demoStatus(page).innerText();
    expect(
      statusLine,
      "the status line carries locale · theme · connection, straight off the ctx signals",
    ).toMatch(/^(en|ru)\s+·\s+(light|dark)\s+·\s+(connecting|ready|lost)$/);
    await saveEvidenceScreenshot(page, "02-panel-open");

    // ── the note round-trip ───────────────────────────────────────────────────────────────────
    await clearDemoNotes(page);
    expect(await demoNoteBodies(page), "the panel starts from an empty database").toEqual([]);
    await addDemoNote(page, "alpha note");
    await addDemoNote(page, "beta note");
    // Newest first — the server's `ORDER BY created_at DESC, id DESC`.
    expect(await demoNoteBodies(page)).toEqual(["beta note", "alpha note"]);
    await saveEvidenceScreenshot(page, "02-notes-two");

    // A full reload proves the round-trip reached the plugin's own SQLite file rather than a store.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(demoFooterButton(page)).toBeAttached({ timeout: 30_000 });
    await openDemoPanel(page);
    await expect
      .poll(() => demoNoteBodies(page), {
        timeout: 30_000,
        message: "the notes survive a reload",
      })
      .toEqual(["beta note", "alpha note"]);
    await saveEvidenceScreenshot(page, "02-notes-after-reload");

    // …and a remove is a real DELETE that the next list reflects.
    const firstRemoveId = await page
      .locator('[data-testid^="demo-remove-"]')
      .first()
      .getAttribute("data-testid");
    await clickPanelControl(page, firstRemoveId ?? "demo-remove-0");
    await expect
      .poll(() => demoNoteBodies(page), { timeout: 20_000, message: "one note was removed" })
      .toEqual(["alpha note"]);
    await saveEvidenceScreenshot(page, "02-notes-after-remove");

    saveEvidenceJson("02-panel", {
      spec: "panel.e2e.test.ts",
      appReadyMs,
      demoIconAttachedMs: iconMs,
      iconBudgetMs: ICON_BUDGET_MS,
      statusLine,
      panel: panelFacts,
      importMapSpecifiers: importedSpecifiers,
      reactFiberKeys: fiberKeys,
      notesAfterRemove: await demoNoteBodies(page),
    });

    await clearDemoNotes(page);

    // ── V2-15: the three new ctx signals reach a plugin component ─────────────────────────────
    //
    // `DemoScopeLine` renders `ctx.activeProject`, `ctx.provider` and `ctx.projects.length` raw.
    // What is asserted is the SHAPE — that the host's bridge pushed real values and the plugin read
    // them through `useSignal` — not the values themselves, which depend on which thread the shared
    // harness app happens to have restored.
    const scopeLine = await page.locator('[data-testid="demo-scope"]').first().innerText();
    expect(scopeLine, "the plugin renders the V2-15 signals").toMatch(
      /(project|проект).*(provider|провайдер).*(projects|проектов)/i,
    );

    // ── V2-15: the panel closes ITSELF through `ctx.closePanel(id)` ───────────────────────────
    //
    // Until this seam existed the app's overlay slot computed an `onClose` and the host dropped it,
    // so every wrapped panel's header X was inert (catalogs Host/SDK request R1) and the only way
    // out was the footer button that opened it.
    await expect(demoPanel(page), "the panel is open before the plugin closes it").toBeVisible();
    await clickPanelControl(page, "demo-close-panel");
    await expect(
      demoPanel(page),
      "the plugin's own button closed its own panel — no footer click involved",
    ).toBeHidden({ timeout: 20_000 });
    await saveEvidenceScreenshot(page, "02-panel-closed-by-the-plugin");

    // …and the app's chrome is untouched: closing a panel is not navigating away.
    await expect(
      page.getByRole("button", { name: /^(Настройки|Settings)$/ }).first(),
    ).toBeVisible();

    // Reopen and close the app's own way, so the next spec finds the state it expects.
    await openDemoPanel(page);
    await closeDemoPanel(page);
    await expect(demoPanel(page)).toBeHidden();
  });
});
