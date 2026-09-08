// ru-code (A10) — spec 3: `composer.attach` (the "+" path, D7) and DELIVERY.
//
// The seam under test is the pixso context-card path reused by a plugin: the panel's "+" builds its
// text on the SERVER (`host.invoke("context.build")` → the plugin's own SQLite) and attaches it to
// the ACTIVE draft through `useComposerDraftStore.addReviewComment`.
//
// Two halves, and the second is the one that matters:
//
//  · ATTACHED — a context card chip appears in the composer, carrying the plugin's title, and it
//    survives closing the panel (it lives on the draft, not in the panel's render);
//  · DELIVERED — after a real send through the fake CLI, the app's OWN projection
//    (`projection_thread_messages.text`) contains the message text followed by the plugin's
//    `<review_comment sectionId="plugin:demo" …>` block with the server-built body inside it.
//
// The projection is read rather than the DOM on purpose. A card is merged into the user message's
// text at send time, so "the words are on screen" cannot tell an attached card from a delivered one
// — only the stored turn can. (`tests-core/messageFlow.e2e.test.ts` reasons about a turn the same
// way, from the app's own store rather than from what a bubble happens to render.)
import {
  addDemoNote,
  clearComposer,
  clearDemoNotes,
  clickPanelControl,
  closeDemoPanel,
  composer,
  CONTEXT_ATTACHED_TOAST,
  deliveredMessagesContaining,
  DEMO_CONTEXT_TEXT,
  expect,
  focusComposer,
  openChat,
  openDemoPanel,
  test,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const MESSAGE = "hello from the demo plugin";

test.describe("plugins — composer.attach and delivery", () => {
  test('the "+" attaches a server-built context card that is delivered with the next message', async ({
    page,
  }) => {
    await openChat(page);

    // A known database, so the card's body is a fact this spec controls.
    await openDemoPanel(page);
    await clearDemoNotes(page);
    await addDemoNote(page, "attach-spec note");

    const attachButton = page.locator('[data-testid="demo-attach"]');
    // With a draft open the composer HAS an active target, so the button is enabled — that is
    // `composer.useActiveTarget()` reporting through the branded handle.
    await expect(attachButton, "an open draft gives the composer an active target").toBeEnabled();
    await clickPanelControl(page, "demo-attach");

    // The toast the plugin raised for itself…
    await expect(page.getByText(CONTEXT_ATTACHED_TOAST).first()).toBeVisible({ timeout: 20_000 });
    // …and the chip the HOST put on the draft. Matched as a SUBSTRING, not as the whole text of a
    // node: the composer renders the card as its source plus its title ("Demo Демо-контекст"), and
    // an anchored match would pin a layout detail that is the app's to change.
    const chip = page.getByText(DEMO_CONTEXT_TEXT).first();
    await expect
      .poll(() => page.getByText(DEMO_CONTEXT_TEXT).count(), {
        timeout: 20_000,
        message: "the context card appears in the composer",
      })
      .toBeGreaterThan(0);
    await saveEvidenceScreenshot(page, "03-attach-card");

    // It belongs to the DRAFT, not to the panel's render tree.
    await closeDemoPanel(page);
    await expect(chip, "the card survives closing the panel").toBeVisible({ timeout: 20_000 });
    await saveEvidenceScreenshot(page, "03-attach-card-composer");

    // ── send it ───────────────────────────────────────────────────────────────────────────────
    await clearComposer(page);
    await focusComposer(page);
    await page.keyboard.type(MESSAGE, { delay: 20 });
    await expect(composer(page)).toContainText(MESSAGE, { timeout: 15_000 });
    await page.keyboard.press("Enter");

    // The app's own store is the witness: the turn's text carries the merged card.
    await expect
      .poll(async () => (await deliveredMessagesContaining(MESSAGE)).length, {
        timeout: 60_000,
        message: "the sent turn reaches projection_thread_messages",
      })
      .toBeGreaterThan(0);
    const delivered = await deliveredMessagesContaining(MESSAGE);

    const text = delivered.join("\n---\n");
    expect(text, "the message itself was sent").toContain(MESSAGE);
    expect(text, "the plugin's card was merged into the turn").toContain('sectionId="plugin:demo"');
    expect(text, "the card is closed as a review_comment block").toContain("</review_comment>");
    // The BODY is the one the SERVER built for this database — not a client-side placeholder.
    expect(text, "the card body is the server-built context").toContain("attach-spec note");
    expect(text, "the card body carries the plugin's own version banner").toMatch(
      /Demo v0\.1\.0 — (сохранено заметок|\d+ note)/,
    );

    await saveEvidenceScreenshot(page, "03-after-send");
    saveEvidenceJson("03-attach", {
      spec: "attach.e2e.test.ts",
      message: MESSAGE,
      deliveredTurns: delivered,
    });

    // Leave the plugin database as this spec found it.
    await openDemoPanel(page);
    await clearDemoNotes(page);
    await closeDemoPanel(page);
  });
});
