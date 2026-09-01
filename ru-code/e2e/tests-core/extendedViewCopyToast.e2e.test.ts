// ru-code (extended-view SYNC wave, R13-AMENDED): PRESSING COPY SAYS «Скопировано!» — in the
// REAL app, on the real button, with the real clipboard.
//
// This is the one end-to-end guard the unit suite cannot give. The unit spec supplies its own
// `AnchoredToastProvider`, so it proves the button raises a toast but not that the TIMELINE
// mounts a viewport for it (mutation MT-2 stayed green for exactly that reason). Here nothing is
// supplied: the app boots, the extended view renders its own provider, and the toast either
// appears over the button or it does not.
//
// It also pins the shape of the failure the owner reported: the button is `disabled` for the
// feedback window and a disabled trigger closes a base-ui tooltip, so the answer must come from
// somewhere else — a portalled toast anchored to the button, outside the button's own subtree.
//
// DOES NOT PROVE: the popup's pixels (class strings are copied verbatim in UK/toast.tsx and
// pinned there), nor the panel's own viewport (unit-guarded, mutation MT-3).
import { expect, readHarnessState, sendPrompt, test, writeFakeControl } from "./fixtures.ts";
import { expectExtendedMounted, openFreshDraft, switchToExtended } from "./extendedView.ts";

const TOAST = '[data-slot="toast-popup"]';

// The clipboard write must be allowed to SUCCEED, or the button would raise the failure toast
// and this case would pass on the wrong branch.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("R13-AMENDED: the bubble's copy button answers with an anchored toast, which then leaves", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openFreshDraft(page);
  await switchToExtended(page);
  writeFakeControl(readHarnessState(), { delayMs: 0, responseText: "Hello" });
  await sendPrompt(page, "Hi");
  await expectExtendedMounted(page);
  await expect(page.getByText("Hello").first()).toBeVisible({ timeout: 30_000 });

  // Nothing is announced before the click.
  await expect(page.locator(TOAST)).toHaveCount(0);

  // The strip is hover-revealed, exactly as main's is.
  const bubble = page.locator(".rounded-2xl.bg-message").first();
  await bubble.hover();
  const copy = page.locator('[aria-label="Скопировать"], [aria-label="Copy to clipboard"]').first();
  await expect(copy).toBeVisible({ timeout: 10_000 });
  await copy.click();

  // WITHIN A SECOND, and from OUTSIDE the button: the toast is portalled to the document.
  const toast = page.locator(TOAST).filter({ hasText: /Скопировано!|Copied!/ });
  await expect(toast).toHaveCount(1, { timeout: 1_000 });
  await expect(
    page.locator(`${TOAST}:has-text("Скопировано!"), ${TOAST}:has-text("Copied!")`),
  ).toBeVisible();
  // The button is disabled while the feedback stands — which is why the tooltip could never be
  // the feedback, and why the toast must not live inside the button.
  await expect(copy).toBeDisabled();
  expect(
    await copy.evaluate((el) => el.querySelector('[data-slot="toast-popup"]') !== null),
    "the toast must not be inside the button it reports for",
  ).toBe(false);

  // …and it is transient: main's window is 1000 ms, so it is gone well inside 5 s.
  await expect(page.locator(TOAST)).toHaveCount(0, { timeout: 5_000 });
  // The button comes back, so the reader can copy again.
  await expect(copy).toBeEnabled({ timeout: 5_000 });
});
