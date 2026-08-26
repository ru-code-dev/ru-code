// ru-code: DEAD-ENVIRONMENT DRAFT RETIREMENT acceptance — the field bug where a
// persisted draft pinned a server identity that no longer exists (app data
// wiped → new environmentId) and the /draft route rendered it forever with an
// empty project picker and a disabled composer.
//
// The spec seeds the REAL localStorage draft-store shape (version 8, exactly
// the field dump's schema) with a draft referencing a dead environmentId, then
// opens that draft URL: the route must retire it to "/" and the index must
// re-mint a fresh draft from live data — project picked, composer usable.
import * as NodeCrypto from "node:crypto";

import { expect, readHarnessState, test } from "./fixtures.ts";

const DEAD_ENVIRONMENT_ID = "00000000-dead-4dea-adea-000000000000";

test("a draft pinned to a dead environment retires to a fresh working draft", async ({ page }) => {
  const state = readHarnessState();
  const staleDraftId = NodeCrypto.randomUUID();
  const staleThreadId = NodeCrypto.randomUUID();
  const staleStore = {
    state: {
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {
        [staleDraftId]: {
          threadId: staleThreadId,
          environmentId: DEAD_ENVIRONMENT_ID,
          projectId: state.projectCwd,
          logicalProjectKey: `${DEAD_ENVIRONMENT_ID}:${state.projectCwd}`,
          createdAt: new Date().toISOString(),
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [`${DEAD_ENVIRONMENT_ID}:${state.projectCwd}`]: staleDraftId,
      },
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    },
    version: 8,
  };
  await page.addInitScript((serialized) => {
    window.localStorage.setItem("ruCode:composer-drafts:v1", serialized);
  }, JSON.stringify(staleStore));

  await page.goto(`${state.webUrl}/draft/${staleDraftId}`, { waitUntil: "domcontentloaded" });

  // The dead draft must be LEFT (it used to render forever). Where the index hands
  // off is owned by __root.tsx's bootstrap-thread welcome auto-open whenever the
  // harness bootstraps a thread (RU_CODE_CREATE_STARTER_PROJECT=1 +
  // --auto-bootstrap-project-from-cwd) — a race this spec must not pin.
  await page.waitForURL((url) => !url.pathname.includes(staleDraftId), { timeout: 60_000 });
  expect(page.url()).not.toContain(DEAD_ENVIRONMENT_ID);
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({
    timeout: 60_000,
  });
});
