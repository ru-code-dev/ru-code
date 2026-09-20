// ru-code v2 — spec 4: the three composer menus (`/`, `$`, `#`) and the ASYNC seam.
//
// `composer.items(trigger, query, ctx)` is ONE seam for all three menus, and static and dynamic
// contributions are the same call. What has to be true, and what each assertion pins:
//
//  · the rows EXIST in the right menu — `/` shows the command row, `$` the skill row, `#` the
//    agent row; picking the wrong menu's row would be an invisible mis-wiring of the grouper;
//  · with an EMPTY `/` the plugin's rows sit under a section labelled with the manifest `name`
//    ("Demo"). Typing collapses the grouping — a pre-existing `ChatComposer` behaviour that
//    `/summary` shares — so the section is checked on the empty menu, not on `/demo`;
//  · the `/` row is the ASYNC half of the seam: its `insert` is built by the plugin's SERVER half
//    while the menu is opening, so it carries this database's note count and bodies and a
//    client-side placeholder cannot pass;
//  · the insert is VERBATIM and idempotent: typing immediately after choosing a row never leaves a
//    second paste behind. v1 resolved the text AFTER the click and needed `expectedText` to make a
//    late arrival a no-op; v2 resolves it before the row is shown, so the guard has nothing to
//    catch — and this assertion is what proves that rather than assuming it.
import {
  addDemoNote,
  clearComposer,
  clearDemoNotes,
  closeDemoPanel,
  commandMenu,
  composer,
  DEMO_AGENT_LABEL,
  DEMO_CONTEXT_LABEL,
  DEMO_SKILL_LABEL,
  expect,
  fetchManifests,
  openChat,
  openDemoPanel,
  test,
  typeTrigger,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const NOTE = "composer-spec note";

test.describe("plugins — composer.items in the /, $ and # menus", () => {
  test("each trigger lists the plugin's row, the async one inserts the server-built text, and a fast keystroke never duplicates", async ({
    page,
  }) => {
    await openChat(page);
    await openDemoPanel(page);
    await clearDemoNotes(page);
    await addDemoNote(page, NOTE);
    await closeDemoPanel(page);

    const evidence: Record<string, unknown> = { spec: "composerItems.e2e.test.ts", note: NOTE };

    // ── the section label, on the EMPTY `/` menu ───────────────────────────────────────────────
    await typeTrigger(page, "/");
    const emptyMenuText = await commandMenu(page).innerText();
    expect(
      emptyMenuText,
      // S38 step 11: the manifest `name` may be `{ en, ru }`, and the section is named in the
      // language the APP is running in — «ДЕМО» here, because this suite runs in Russian.
      "the plugin's rows sit under a section named after the manifest `name`, localized",
    ).toMatch(/DEMO|ДЕМО/i);
    expect(emptyMenuText, "and the row itself is there").toMatch(/Демо-контекст|Demo context/);
    evidence["emptySlashMenu"] = emptyMenuText;
    await saveEvidenceScreenshot(page, "04-slash-menu-empty");

    // ── `/demo` → the ASYNC, server-built prompt ───────────────────────────────────────────────
    await typeTrigger(page, "/demo");
    const slashRow = commandMenu(page).getByText(DEMO_CONTEXT_LABEL).first();
    await expect(slashRow, "the /-menu lists the command item").toBeVisible({ timeout: 20_000 });
    await saveEvidenceScreenshot(page, "04-slash-menu");
    await slashRow.click();

    await expect
      .poll(() => composer(page).innerText(), {
        timeout: 30_000,
        message: "the async prompt resolves into the composer",
      })
      .toContain(NOTE);
    const inserted = await composer(page).innerText();
    // The SERVER built it: the version banner and this database's note count/bodies.
    // The version is the demo plugin's OWN banner (`DEMO_PLUGIN_VERSION`, which its test pins to
    // `plugin.json`); S38 step 11 moved the four shipped plugins to 1.0.0. Matched loosely on the
    // shape rather than on one literal, so the next version bump is not a spec edit.
    expect(inserted, "the inserted text is the server-built context").toMatch(
      /Demo v\d+\.\d+\.\d+ — \d+ note/,
    );
    expect(inserted, "it quotes the note this spec added").toContain(NOTE);
    expect(inserted, "the trigger token itself is gone").not.toContain("/demo");
    evidence["slashInserted"] = inserted;
    await saveEvidenceScreenshot(page, "04-slash-inserted");

    // ── `$demo-skill` → a static prompt ────────────────────────────────────────────────────────
    await typeTrigger(page, "$demo");
    const skillRow = commandMenu(page).getByText(DEMO_SKILL_LABEL).first();
    await expect(skillRow, "the $-menu lists the skill item").toBeVisible({ timeout: 20_000 });
    await saveEvidenceScreenshot(page, "04-skill-menu");
    await skillRow.click();
    await expect
      .poll(() => composer(page).innerText(), {
        timeout: 20_000,
        message: "the skill prompt lands in the composer",
      })
      .toMatch(/заметки демо-плагина|demo plugin's notes/i);
    evidence["skillInserted"] = await composer(page).innerText();

    // ── `#demo-agent` → a static prompt ────────────────────────────────────────────────────────
    await typeTrigger(page, "#demo");
    const agentRow = commandMenu(page).getByText(DEMO_AGENT_LABEL).first();
    await expect(agentRow, "the #-menu lists the agent item").toBeVisible({ timeout: 20_000 });
    await saveEvidenceScreenshot(page, "04-agent-menu");
    await agentRow.click();
    await expect
      .poll(() => composer(page).innerText(), {
        timeout: 20_000,
        message: "the agent prompt lands in the composer",
      })
      .toMatch(/ассистент демо-плагина|demo plugin's assistant/i);
    evidence["agentInserted"] = await composer(page).innerText();

    // ── one insert, once: type INTO the window a late resolution would have landed in ──────────
    await clearComposer(page);
    await typeTrigger(page, "/demo");
    await commandMenu(page).getByText(DEMO_CONTEXT_LABEL).first().click();
    await composer(page).click();
    await page.keyboard.type("typed right after choosing the row", { delay: 10 });
    // Long enough that anything the seam still had in flight would have landed by now.
    await page.waitForTimeout(6_000);
    const raced = await composer(page).innerText();
    const bannerCount = (raced.match(/Demo v\d+\.\d+\.\d+/g) ?? []).length;
    expect(bannerCount, "the row's text is pasted exactly once, never twice").toBe(1);
    expect(raced, "and it never throws away what the user typed").toContain(
      "typed right after choosing the row",
    );
    evidence["racedComposer"] = raced;
    evidence["racedBannerCount"] = bannerCount;
    await saveEvidenceScreenshot(page, "04-async-race");

    saveEvidenceJson("04-composer-items", evidence);

    await clearComposer(page);
    await openDemoPanel(page);
    await clearDemoNotes(page);
    await closeDemoPanel(page);
  });
  // S5, step 5 — the determinism S4-parity §2.2 found missing.
  //
  // The loader maps `manifests.json` CONCURRENTLY, and until S5 each plugin joined the registry
  // when its OWN `activate` settled. Every rendered surface therefore came out in COMPLETION order,
  // which varies with how long each activate takes: parity captured the `#` menu as
  // «DEMO → ВСТРОЕННЫЕ» in one run and «ГЛОБАЛЬНЫЕ → ВСТРОЕННЫЕ → DEMO» in the next, off the same
  // install, and the DOM's `[data-plugin-root]` order flipped with it. Nothing was LOST either way,
  // which is why no other assertion in this suite caught it — the menu is simply shuffled.
  //
  // `addLoadedPlugin` sorts on the manifest index now, so this reads the two orders TWICE, across a
  // real reload, and requires them identical and consistent with `manifests.json`.
  test("plugin order is manifest order, and identical across two reloads", async ({ page }) => {
    test.setTimeout(180_000);
    const manifestOrder = (await fetchManifests()).map((row) => row.id);
    expect(manifestOrder.length, "the harness seeds several plugins").toBeGreaterThan(1);

    /** Every plugin the page has actually mounted a surface for, in DOM order. */
    const domOrder = async (): Promise<ReadonlyArray<string>> =>
      await page.$$eval("[data-plugin-root]", (nodes) => [
        ...new Set(
          nodes
            .map((node) => node.getAttribute("data-plugin-root") ?? "")
            .filter((id) => id !== ""),
        ),
      ]);

    const capture = async (): Promise<{
      readonly roots: ReadonlyArray<string>;
      readonly menu: string;
    }> => {
      await openChat(page);
      await expect
        .poll(async () => (await domOrder()).length, {
          timeout: 60_000,
          intervals: [500],
          message: "at least two plugins have mounted a surface",
        })
        .toBeGreaterThan(1);
      await typeTrigger(page, "#");
      const menu = await commandMenu(page).innerText();
      await clearComposer(page);
      return { roots: await domOrder(), menu };
    };

    const first = await capture();
    await page.reload({ waitUntil: "domcontentloaded" });
    const second = await capture();

    // 1. Manifest order, both times: the mounted plugins are a SUBSEQUENCE of manifests.json.
    for (const roots of [first.roots, second.roots]) {
      const positions = roots.map((id) => manifestOrder.indexOf(id));
      expect(
        positions,
        `every mounted plugin is in manifests.json: ${roots.join(", ")}`,
      ).not.toContain(-1);
      expect(
        [...positions].sort((a, b) => a - b),
        `[data-plugin-root] order follows manifests.json: ${roots.join(", ")}`,
      ).toEqual(positions);
    }

    // 2. STABLE: the same order, and the same menu, after a full reload.
    expect(second.roots, "the DOM order survives a reload").toEqual(first.roots);
    expect(second.menu, "the # menu's sections survive a reload").toBe(first.menu);

    saveEvidenceJson("04-plugin-order", {
      spec: "composerItems.e2e.test.ts",
      claim: "loaded-plugin order is manifests.json order, stable across reloads",
      manifestOrder,
      firstRoots: first.roots,
      secondRoots: second.roots,
      menusIdentical: second.menu === first.menu,
    });
  });
});
