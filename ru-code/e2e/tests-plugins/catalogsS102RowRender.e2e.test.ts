// ru-code (S102): ONE catalog edit reaches the UI, and only its row re-renders.
//
// The owner sees whole catalog panels re-render on any change (S102 brief §0). One edit — the
// Global switch of one of three skills — must reach the screen (the switch flips) and render that
// row only: the other two rows render nothing. Renders are counted the way React DevTools'
// "highlight updates" counts them — the probe `@smart-tools/plugin-dev/e2e` gives every plugin's
// own suite, taken here from its source through the `ru-code-packages` link (as `harness/
// fakePixsoMcp.ts` takes the pixso fake), because the app is a PRODUCTION React build and the probe
// reads what both builds report to the devtools hook.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  RenderProbe,
  installRenderProbe,
} from "../../../ru-code-packages/packages/plugin-dev/src/e2e/probe.ts";
import { expect, openChat, state, test, type Page } from "./fixtures.ts";

/** RED TODAY (S102): the reason, measured — removed with the fix that turns it green. */
const RED_TODAY =
  "the two unchanged rows re-render with the changed one: the mutation primes a fresh catalog array and the rows are not memo components";

const SKILLS_LABEL = /^(Менеджер Навыков|Skill manager)$/;
const SKILLS_REFRESH = /^(Обновить навыки|Refresh skills)$/;
const NAMES = ["s102-app-a", "s102-app-b", "s102-app-c"] as const;
const describe = (name: string): string => `Desc ${name}.`;
const ROW = '[data-slot="tabs-panel"] [role="button"]';
const SHOWN = '[data-slot="tabs-panel"]:not([hidden])';

const skillDir = (name: string): string => NodePath.join(state().cliConfigDir, "skills", name);

test.beforeAll(() => {
  for (const name of NAMES) {
    NodeFS.mkdirSync(skillDir(name), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(skillDir(name), "SKILL.md"),
      `---\nname: ${name}\ndescription: ${describe(name)}\n---\n\n# ${name}\n`,
      "utf8",
    );
  }
});

test.afterAll(() => {
  for (const name of NAMES) NodeFS.rmSync(skillDir(name), { recursive: true, force: true });
});

/** No commit between three looks 150 ms apart: the change has finished rendering. */
const quiet = async (probe: RenderProbe): Promise<void> => {
  let last = -1;
  let still = 0;
  await expect
    .poll(
      async () => {
        const commits = await probe.commits();
        still = commits === last ? still + 1 : 0;
        last = commits;
        return still >= 2;
      },
      { intervals: [150], timeout: 30_000 },
    )
    .toBe(true);
};

const openSkillsGlobal = async (page: Page) => {
  const button = page.getByRole("button", { name: SKILLS_LABEL }).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.dispatchEvent("click");
  await expect(page.getByRole("tab", { name: /^(Каталог|Catalog)$/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  // The rows were written after this process walked its roots: Refresh is what reads the disk.
  await page.getByLabel(SKILLS_REFRESH).first().dispatchEvent("click");
  await page
    .getByRole("tab", { name: /^(Глобально|Global)$/ })
    .first()
    .click();
  for (const name of NAMES) {
    await expect(
      page.locator(SHOWN).getByRole("switch", { name: `Отключить ${name}` }),
    ).toBeAttached({
      timeout: 30_000,
    });
  }
};

test("S102 one catalog edit reaches the UI and renders only its row", async ({ page }) => {
  test.fail(true, RED_TODAY);
  test.setTimeout(180_000);
  await installRenderProbe(page);
  await openChat(page);
  await openSkillsGlobal(page);

  const probe = new RenderProbe(page);
  await quiet(probe);
  await probe.arm([
    ...NAMES.map((name) => ({ name: `row:${name}`, selector: ROW, text: describe(name) })),
    { name: "rows:other", selector: ROW },
    { name: "tabs", selector: '[data-slot="tabs-list"]' },
  ]);
  await page
    .locator(SHOWN)
    .getByRole("switch", { name: "Отключить s102-app-b" })
    .dispatchEvent("click");
  // The edit reached the UI: the switch now offers to turn the skill back on.
  await expect(
    page.locator(SHOWN).getByRole("switch", { name: "Включить s102-app-b" }),
  ).toBeAttached({
    timeout: 20_000,
  });
  await quiet(probe);
  const counts = await probe.read();
  process.stdout.write(
    `S102 app-catalogs-row ${JSON.stringify(counts.blocks)} commits=${String(counts.commits)}\n`,
  );

  expect.soft(counts.blocks["row:s102-app-b"] ?? 0, "the edited row rendered").toBeGreaterThan(0);
  expect.soft(counts.blocks["row:s102-app-a"] ?? 0, "unchanged row a rendered").toBe(0);
  expect.soft(counts.blocks["row:s102-app-c"] ?? 0, "unchanged row c rendered").toBe(0);
});
