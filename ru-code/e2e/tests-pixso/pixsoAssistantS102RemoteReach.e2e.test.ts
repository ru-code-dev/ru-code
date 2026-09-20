// ru-code (S102): a REMOTE scan of a frame NOT yet in the gallery reaches «Недавние сканы» AND the
// gallery WITHOUT closing or reopening the panel — the owner's case, seen in the app (S102 brief §0).
//
// WHY NO EARLIER SPEC CAUGHT IT (S100 §2): `pixsoAssistantRemote.e2e.test.ts` scans a frame the local
// suite had already imported (a reimport: the gallery count is 1 before and after, with or without
// a refresh), never looks at «Недавние сканы», and `pixsoAssistantS10DuplicateEnriched` reloads the
// page before it looks. Here the frame is one the gallery holds no card for: none before, one after,
// and the panel stays open throughout.
//
// The cause, by trace (S100 §1) and measured in the playground (S102, `plugins/…/pixso/e2e`): the
// remote run's own settle listener subscribes after the panel's boot listener, whose replay has
// already written the same settle, so the equal-settle guard returns before the gallery re-read.
import { REAL_FRAMES_BY_KEY } from "../harness/fakePixsoMcp.ts";
import { loadRealCapture, rootLayerNameOf, rootSizeLabelOf } from "../harness/pixsoExpectations.ts";
import { expect, readHarnessState, test, type Page } from "../tests-core/fixtures.ts";

/** Does the expectations manifest describe this frame's capture (its card name and size)? */
const described = (frame: string): boolean => {
  try {
    return rootLayerNameOf(loadRealCapture(frame)) !== null;
  } catch {
    return false;
  }
};

/**
 * The corpus's LAST frame by key that the manifest describes. Run ALONE, no spec has scanned it. In
 * the whole `test:pixso` run the specs before this one HAVE imported it (S104 close): the local
 * route's fake walks the corpus one payload per scan and wraps (`pixso-core/dev/fake-mcp/
 * fakePixsoMcp.ts` "get_node_dsl — one payload per call, walking the cycle"), and by the time this
 * spec runs every described frame has a card. So the precondition below makes the frame new the
 * way a user would — it deletes the frame's card first — and then proves it is not in the gallery.
 */
const FRAME = REAL_FRAMES_BY_KEY.toReversed().find((entry) => described(entry.frame)) ?? null;

const designUrlFor = (itemId: string): string =>
  `https://company-pixso.com/app/editor/AbCdEf123456?item-id=${encodeURIComponent(itemId)}`;

const galleryCards = (page: Page) =>
  page.getByTestId("pixso-group-section").getByTestId("pixso-card");

test("S102 a REMOTE scan of a frame not yet in the gallery reaches «Недавние сканы» and the gallery without a reopen", async ({
  page,
}) => {
  test.setTimeout(180_000);
  expect(FRAME, "the corpus holds a real frame to scan remotely").not.toBeNull();
  const frame = FRAME?.frame ?? "";
  const capture = loadRealCapture(frame);
  const rootName = rootLayerNameOf(capture) ?? "";
  const rootSize = rootSizeLabelOf(capture) ?? "";
  expect(rootName, `${frame} has a root layer name to find its card by`).not.toBe("");
  const cardsOfFrame = () =>
    galleryCards(page).filter({ hasText: rootName }).filter({ hasText: rootSize });
  const recentOfFrame = () =>
    page
      .getByRole("tabpanel", { name: "Импорт" })
      .getByTestId("pixso-card")
      .filter({ hasText: rootName });

  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();

  // PRECONDITION: the frame is NOT in the gallery yet — an earlier spec's card for it is deleted
  // first, through the card's own ⋯ menu and its confirmation.
  await page.getByRole("tab", { name: "Галерея" }).click();
  // The gallery has LOADED — its toolbar when it holds cards, its empty state when it holds none.
  await expect(
    page.getByTestId("pixso-new-group-button").or(page.getByText("Галерея пуста")),
  ).toBeVisible({ timeout: 15_000 });
  const already = await cardsOfFrame().count();
  for (let left = already; left > 0; left -= 1) {
    const card = cardsOfFrame().first();
    await card.hover();
    await card.getByRole("button", { name: /^Действия карточки/ }).click();
    await page.getByTestId("pixso-card-delete").click();
    await page.getByTestId("pixso-card-delete-confirm").click();
    await expect(cardsOfFrame(), `deleting ${frame}'s card`).toHaveCount(left - 1, {
      timeout: 10_000,
    });
  }
  await expect(cardsOfFrame(), `precondition: no card for ${frame} before the scan`).toHaveCount(0);
  await page.getByRole("tab", { name: "Импорт" }).click();

  // The token, through the wizard — the same steps as `pixsoAssistantRemote.e2e.test.ts` — unless
  // a token is already saved: in the whole `test:pixso` run that spec saved one before this one, and
  // the remote tab opens on the URL step.
  const onboarding = page.getByTestId("pixso-remote-onboarding");
  await expect(onboarding.or(page.getByTestId("pixso-remote-url-step"))).toBeVisible({
    timeout: 15_000,
  });
  if (await onboarding.isVisible()) {
    await page.getByTestId("pixso-create-token").click();
    await page.getByTestId("pixso-token-input").fill("pix_e2e_s102_remote_token");
    await page.getByTestId("pixso-token-check").click();
    await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("pixso-token-save").click();
    await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Готово" }).click();
  }

  // The scan — of a frame no scan has touched.
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(FRAME?.key ?? ""));
  await page.getByTestId("pixso-remote-scan-button").click();
  await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Карточка добавлена в галерею")).toBeVisible();

  // The panel was never closed. «Недавние сканы» shows the new card…
  await expect(recentOfFrame(), "the new card in «Недавние сканы», no reopen").toBeVisible({
    timeout: 10_000,
  });
  // …and so does the gallery.
  await page.getByRole("tab", { name: "Галерея" }).click();
  await expect(cardsOfFrame(), "the new card in the gallery, no reopen").toHaveCount(1, {
    timeout: 10_000,
  });
});
