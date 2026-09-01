// ru-code (mid-turn wave, P3d): the FIRST browser-driven proof of the delivery
// marks, and the only place the RELOAD claim is actually tested.
//
// Everything else about the marks is pinned on one side of a seam or the other:
// the persistence half against real SQL (ProjectionThreadMessagesDeliveryState),
// the adapter half against the real wire (midTurnDeliveryBridge), the render
// half against real markup (midTurnDeliveryMark.render). None of them crosses
// the gap. This spec closes it: a REAL built app in real Chromium, driven by the
// REAL fake ACP over real pipes, asserting what a user actually sees on a
// balloon — and what they still see after pressing refresh.
//
// Two legs, the two endings a queued message can have:
//   1. delivered  → the clock appears while the turn runs, then GOES AWAY when
//      the drain hands the text over, and stays away across a reload.
//   2. not-delivered → the clock appears, a Stop wipes the queue, the balloon
//      flips to the warning mark, and THAT mark survives a reload.
//
// Leg 2 is the load-bearing one for reload: it is the only case whose mark is
// visible AFTER the refresh, so it proves the value came back out of the read
// model rather than lingering in client memory. Leg 1's reload assertion is
// weaker by nature (absence proves less than presence) and is written as such.
import {
  expect,
  openThread,
  readHarnessState,
  sendPrompt,
  test,
  waitForShellCacheToLearnThread,
  writeFakeControl,
} from "./fixtures.ts";

// Long enough for the browser to type + send a second message while turn 1 is
// still genuinely running, then let the drain fire.
const HOLD_MS = 6_000;

const FIRST = "первый вопрос";
const MID_TURN = "а ещё уточни вот это";

/**
 * The delivery mark, located WITHOUT depending on its wording: the label is an
 * English source literal that the localization build rewrites, so matching text
 * here would couple this spec to which bundle it runs against. `role="status"`
 * is the language-agnostic handle the component gives us.
 */
// ru-code (ap-final T4): scoped to the mark's OWN testid, not to `role="status"`.
// The old locator was `[role="status"][aria-label]`, which is not specific to the
// delivery mark at all — `ui/spinner.tsx:5-11` renders exactly that shape with
// `aria-label="Loading"`. Under full-suite load a spinner outlived the send, so
// `.first()` was the spinner, `pendingLabel` was captured as "Loading", and the
// "wait for the label to change" poll below then captured the PENDING clock as
// the post-stop label — failing the reload comparison against the correctly
// persisted "Not sent". Measured in `logs/ap-final/final_e2e2.log`.
const deliveryMarks = (page: Parameters<typeof openThread>[0]) =>
  page.getByTestId("mid-turn-delivery-mark");

test("mid-turn delivery marks: clock while queued, cleared on drain, and correct after reload", async ({
  page,
}) => {
  const state = readHarnessState();
  writeFakeControl(state, { delayMs: 0, midTurn: { holdMs: HOLD_MS } });

  await openThread(page);
  await sendPrompt(page, FIRST);

  // Turn 1 is now streaming and will hold for HOLD_MS. The composer must accept
  // a second message here — that relaxation is the whole wave (sendGate.ts no
  // longer receives the qwen running-turn condition).
  await sendPrompt(page, MID_TURN);

  // 1. PENDING: the balloon is in history immediately, carrying its clock,
  //    while the text genuinely has not reached the model.
  await expect(page.getByText(MID_TURN, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(deliveryMarks(page).first()).toBeVisible({ timeout: 15_000 });

  // 2. DELIVERED: the drain hands the text over and the mark clears. A
  //    delivered message is just a message — no tick, by design.
  await expect(deliveryMarks(page)).toHaveCount(0, { timeout: 30_000 });

  // 3. RELOAD. Stated honestly: absence after a refresh is a WEAKER claim than
  //    presence, because a mark that never persisted would also be absent. It
  //    pins that delivery does not RESURRECT a stale clock from the read model,
  //    which is a real regression this would catch; leg 2 below is what proves
  //    a value actually round-trips through the projection.
  // ru-code (extended-view redesign): the F5 must not race the shell cache (see fixtures).
  await waitForShellCacheToLearnThread(page);
  await page.reload();
  await expect(page.getByText(MID_TURN, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(deliveryMarks(page)).toHaveCount(0, { timeout: 15_000 });
});

test("mid-turn delivery marks: a Stop leaves NOT-DELIVERED, and it survives a reload", async ({
  page,
}) => {
  const state = readHarnessState();
  writeFakeControl(state, { delayMs: 0, midTurn: { holdMs: HOLD_MS } });

  await openThread(page);
  await sendPrompt(page, FIRST);
  await sendPrompt(page, MID_TURN);

  await expect(page.getByText(MID_TURN, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(deliveryMarks(page).first()).toBeVisible({ timeout: 15_000 });
  // Capture the PENDING label so the flip below can be detected without
  // hardcoding either wording — both are English source literals the
  // localization build rewrites, so matching text would couple this spec to
  // which bundle it runs against.
  const pendingLabel = await deliveryMarks(page).first().getAttribute("aria-label");

  // Stop while the message is still queued: the server resets the queue and
  // announces not-delivered for everything still pending. Nothing auto-fires
  // afterwards — qwen's own stop path does not drain either
  // (Session.ts:4516-4522).
  const stop = page.getByRole("button", { name: /^(Stop generation|Остановить генерацию)$/ });
  await stop.click();

  // The mark is still THERE (it changed meaning, not existence): the clock has
  // become the not-delivered warning.
  //
  // Waiting for the LABEL TO CHANGE, not merely for a mark to be visible: the
  // pending clock is already visible at this point, so a bare visibility check
  // passes instantly against the OLD state and captures the wrong label. That
  // is precisely how the first draft of this spec failed — it compared a
  // pending label against a correctly-persisted not-delivered one.
  const mark = deliveryMarks(page).first();
  await expect(mark).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => mark.getAttribute("aria-label"), { timeout: 30_000 })
    .not.toBe(pendingLabel);
  const afterStopLabel = await mark.getAttribute("aria-label");

  // THE RELOAD PROOF. The client has no memory after this; the mark can only
  // come back out of the persisted projection row (fork migration 004's
  // delivery_state column, read via listByThreadId).
  // ru-code (extended-view redesign): the F5 must not race the shell cache (see fixtures).
  await waitForShellCacheToLearnThread(page);
  await page.reload();
  await expect(page.getByText(MID_TURN, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  const reloadedMark = deliveryMarks(page).first();
  await expect(reloadedMark).toBeVisible({ timeout: 15_000 });
  expect(await reloadedMark.getAttribute("aria-label")).toBe(afterStopLabel);
});
