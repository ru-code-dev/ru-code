// ru-code (A10) — spec 4: the three composer menus (`/`, `$`, `#`) and the async insert.
//
// `composer.registerItem` puts one row in each of the app's existing trigger menus. What has to be
// true, and what each assertion here pins:
//
//  · the rows EXIST in the right menu — `/` shows the `command` item, `$` the `skill`, `#` the
//    `agent`; picking the wrong menu's row would be an invisible mis-wiring of the grouper;
//  · with an EMPTY `/` the plugin's rows sit under a section labelled with the manifest `name`
//    ("Demo"). Typing collapses the grouping — a pre-existing `ChatComposer` behaviour A7
//    documented and `/summary` shares — so the section is checked on the empty menu, not on
//    `/demo`;
//  · selecting the ASYNC one (`prompt: async () => host.invoke("context.build")`) inserts the
//    text the SERVER built: it carries this database's note count and bodies, so a client-side
//    placeholder cannot pass;
//  · typing IMMEDIATELY after selecting the async one does not duplicate. The insert resolves after
//    the keystrokes land, and `applyPromptReplacement`'s `expectedText` guard is what makes the late
//    arrival a NO-OP instead of a second paste (mvp-plan §6 risk 2).
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
  openChat,
  openDemoPanel,
  test,
  typeTrigger,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const NOTE = "composer-spec note";

test.describe("plugins — composer.registerItem in the /, $ and # menus", () => {
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
      "the plugin's rows sit under a section named after the manifest `name`",
    ).toMatch(/DEMO/i);
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
    expect(inserted, "the inserted text is the server-built context").toMatch(
      /Demo v0\.1\.0 — (сохранено заметок|\d+ note)/,
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

    // ── the stale-insert guard: type INTO the window the async prompt is still open in ──────────
    await typeTrigger(page, "/demo");
    await commandMenu(page).getByText(DEMO_CONTEXT_LABEL).first().click();
    // No await on the insert: these keystrokes race it on purpose.
    await composer(page).click();
    await page.keyboard.type("typed while the async prompt was still resolving", { delay: 10 });
    // Give the late resolution every chance to land (the round trip is a `plugin.invoke`).
    await page.waitForTimeout(6_000);
    const raced = await composer(page).innerText();
    const bannerCount = (raced.match(/Demo v0\.1\.0/g) ?? []).length;
    expect(
      bannerCount,
      "a stale async insert is a no-op, never a second paste (expectedText guard)",
    ).toBeLessThanOrEqual(1);
    expect(raced, "and it never throws away what the user typed").toContain(
      "typed while the async prompt was still resolving",
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
});
