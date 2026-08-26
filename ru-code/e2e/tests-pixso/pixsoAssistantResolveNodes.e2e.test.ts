// ru-code: RESOLVE WAVES A1+B — the recursive nested-node resolve, end to end in a real
// browser: the REAL panel drives the REAL server, which dials the fake Pixso MCP's
// remote route; the fake serves a GENERATED nested-instance frame (reserved 9000:*
// vocabulary — no corpus needed on any machine) whose targeted node fetches each take
// ~3s (`NESTED_NODE_DELAY_MS`), so the «Запрос дополнительной ноды k/N» row is a real,
// observable state, not a race.
//
// FILE NAME sorts AFTER `pixsoAssistantRemote.e2e.test.ts` (shared-gallery discipline:
// the local spec's first-N-cards pins and the remote spec's own baseline run first) and
// BEFORE the S10/ZIsolation suites, which pin nothing about these cards.
//
// CASES: the constant-state arm (ALWAYS runs — the nested frame scans to a card and the
// wire matches whatever `NODES_FETCH_ENABLED` says) · then, gated on that constant being
// true: cancel-mid-fetch (wave B task 3 — the four host seams are wired now; the old
// «no user-facing cancel affordance can exist this wave» note is SUPERSEDED, std-9) ·
// happy path WITH the wave-B seam proof (the fetched override content visibly lands in
// the RENDERED card preview) · partial failure (fail-soft warning box) ·
// retry-fetches-ONLY-the-failed-node.
//
// PARKED SINCE THE NODES-CONSTANT WAVE (decisions 480/486): `NODES_FETCH_ENABLED` ships
// `false`, so the four gated cases skip themselves — the phase they pin does not exist
// while no targeted fetch is issued. The gate reads the package constant directly, so
// flipping that literal re-arms them with no edit in this file.
//
// ORDER MATTERS (serial): the cancel case runs FIRST — a cancelled run persists
// nothing, so the happy path that follows still fetches both nodes fresh; after the
// happy path banks them, no later scan of that frame would enter the node-fetch phase
// at all (fetch-each-DISTINCT-guid-once across runs).

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { NODES_FETCH_ENABLED } from "@smart-tools/t3-code-pixso-mcp-assistant/contracts";

import type { HarnessState } from "../scripts/bootApp.ts";
import { expect, readHarnessState, test, type Page } from "../tests-core/fixtures.ts";

const NESTED_RESOLVE_ITEM_ID = "9000:000015";
const NESTED_PARTIAL_ITEM_ID = "9000:000016";
/** `harness/fakePixsoMcp.ts`'s nested fixtures — the happy frame's two DISTINCT inner
 *  guids (4 clones in the tree: the row's total proves dedupe) and the partial frame's
 *  ok/flaky pair (the flaky one fails exactly once per fake lifetime). */
const NESTED_RESOLVE_INNER = ["9000:210001", "9000:210002"];
const NESTED_PARTIAL_OK = "9000:220001";
const NESTED_PARTIAL_FLAKY = "9000:220002";

interface FakeCalls {
  readonly nodeFetches: ReadonlyArray<{ readonly route: string; readonly guid: string }>;
  readonly abortedNodeFetches: ReadonlyArray<{
    readonly route: string;
    readonly guid: string;
  }>;
}

async function fetchFakeCalls(state: HarnessState): Promise<FakeCalls> {
  const response = await fetch(state.remotePixsoCallsUrl);
  return (await response.json()) as FakeCalls;
}

async function fetchNodeCalls(state: HarnessState): Promise<ReadonlyArray<string>> {
  return (await fetchFakeCalls(state)).nodeFetches.map((call) => call.guid);
}

function designUrlFor(itemId: string): string {
  return `https://company-pixso.com/app/editor/AbCdEf123456?item-id=${encodeURIComponent(itemId)}`;
}

/** Optional vision-check artifact drop (wave-B brief task 5): set
 *  `PIXSO_E2E_SHOTS_DIR` and the specs save PNGs of the settled surfaces there. */
async function saveShot(page: Page, name: string): Promise<void> {
  const dir = process.env["PIXSO_E2E_SHOTS_DIR"];
  if (dir === undefined || dir === "") return;
  NodeFS.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: NodePath.join(dir, name), fullPage: true });
}

async function openPixsoPanel(page: Page): Promise<void> {
  const state = readHarnessState();
  await page.goto(state.webUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pixso", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Импорт" })).toBeVisible();
}

/** The remote URL step, whatever state the shared server is in: a token saved by an
 *  earlier spec is reused; a fresh boot (partial run) walks the wizard once. */
async function ensureRemoteReady(page: Page): Promise<void> {
  if (await page.getByTestId("pixso-remote-url-step").isVisible()) return;
  await expect(page.getByTestId("pixso-remote-onboarding")).toBeVisible();
  await page.getByTestId("pixso-create-token").click();
  await page.getByTestId("pixso-token-input").fill("pix_e2e_nested_nodes_token");
  await page.getByTestId("pixso-token-check").click();
  await expect(page.getByTestId("pixso-token-verify-ok")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("pixso-token-save").click();
  await expect(page.getByText("Токен сохранён")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(page.getByTestId("pixso-remote-url-step")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

/**
 * PARKED-STATE ARM (nodes-constant wave, decisions 480/486). `NODES_FETCH_ENABLED` is
 * `false` in the shipped package, and the only way to flip it is the package's own
 * test-only layer — no production seam, so the app under this harness issues ZERO
 * targeted node fetches. This case is the honest coverage of THAT state: the same
 * nested frame the cases below drive still scans to a card, and the wire stays clean.
 * It runs in whichever state the constant is in, so the arm can never go dark.
 */
test("nested frame scans to a card, and node-fetching obeys the shipped constant", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = readHarnessState();
  const before = await fetchNodeCalls(state);

  await openPixsoPanel(page);
  await ensureRemoteReady(page);

  await page.getByTestId("pixso-design-url-input").fill(designUrlFor(NESTED_RESOLVE_ITEM_ID));
  await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
  await page.getByTestId("pixso-remote-scan-button").click();

  await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Карточка добавлена в галерею")).toBeVisible();

  const fetchedThisRun = (await fetchNodeCalls(state)).slice(before.length);
  if (NODES_FETCH_ENABLED) {
    // Enabled: the inner guids are fetched, which is what the cases below then pin in
    // detail (phase row, cancel, retry).
    expect(fetchedThisRun.length).toBeGreaterThan(0);
  } else {
    // Parked: not one targeted fetch may reach the wire, and no degradation is claimed
    // — a parked feature is not a failed one.
    expect(fetchedThisRun).toEqual([]);
    await expect(page.getByTestId("pixso-nodes-warning")).toHaveCount(0);
  }
  await saveShot(page, "reserved-nested-constant-state.png");
});

test.describe("node-fetch phase", () => {
  // The three cases below drive the node-fetch phase itself — its progress row, its
  // cancel affordance, its partial-failure retry. None of that surface exists while
  // `NODES_FETCH_ENABLED` is false: there is no fetch to show, cancel or retry. They
  // are skipped by the CONSTANT, never by a hand-maintained flag, so flipping the
  // constant re-arms them with no edit here. The parked state stays covered by the
  // case above.
  test.skip(
    !NODES_FETCH_ENABLED,
    "NODES_FETCH_ENABLED is false — the app issues no targeted node fetches (decisions 480/486)",
  );

  test("B cancel: the button appears during the node-fetch phase, cancel kills the wire (no orphan requests) and returns the pre-scan surface", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const state = readHarnessState();
    const before = await fetchFakeCalls(state);

    await openPixsoPanel(page);
    await ensureRemoteReady(page);

    await page.getByTestId("pixso-design-url-input").fill(designUrlFor(NESTED_RESOLVE_ITEM_ID));
    await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
    await page.getByTestId("pixso-remote-scan-button").click();

    // The node-fetch phase: the row AND the cancel button appear together (the button is
    // scoped to exactly this phase — before it there is nothing worth cancelling).
    await expect(page.getByText("Запрос дополнительной ноды")).toBeVisible({ timeout: 30_000 });
    const cancelButton = page.getByTestId("pixso-scan-cancel");
    await expect(cancelButton).toBeVisible();
    // Wait until BOTH fetches are genuinely on the wire (~3s each — mid-fetch for real).
    await expect
      .poll(async () => (await fetchNodeCalls(state)).length - before.nodeFetches.length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(2);

    await cancelButton.click();

    // 1) The surface returns to the pre-scan state: stepper gone, scan button re-armed.
    await expect(page.getByTestId("pixso-import-stepper")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("pixso-remote-scan-button")).toBeEnabled();
    // 2) NO ORPHAN REQUESTS (spec A1 task 5, now end-to-end): the in-flight fetches'
    //    sockets were torn down by the client — the fake records the unanswered closes.
    await expect
      .poll(
        async () =>
          (await fetchFakeCalls(state)).abortedNodeFetches
            .slice(before.abortedNodeFetches.length)
            .map((call) => call.guid)
            .sort(),
        { timeout: 10_000 },
      )
      .toEqual([...NESTED_RESOLVE_INNER]);
    // 3) The loop stopped: no further node fetch ever goes out (sampled after the abort —
    //    a resolve loop that survived the cancel would re-request within its next wave).
    const callsAfterCancel = (await fetchNodeCalls(state)).length;
    await page.waitForTimeout(4000);
    expect((await fetchNodeCalls(state)).length).toBe(callsAfterCancel);
    await saveShot(page, "reserved-nested-cancelled.png");
  });

  test("A1+B happy path: the node row ticks through 2 DISTINCT fetches (4 clones — dedupe), the scan lands clean, and the fetched override RENDERS in the card", async ({
    page,
  }) => {
    // 2 nodes × ~3s (in-flight together under the default async knob) + the usual scan
    // margins — same ceiling discipline as the remote spec.
    test.setTimeout(120_000);
    const state = readHarnessState();
    const before = await fetchNodeCalls(state);

    await openPixsoPanel(page);
    await ensureRemoteReady(page);

    await page.getByTestId("pixso-design-url-input").fill(designUrlFor(NESTED_RESOLVE_ITEM_ID));
    await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
    await page.getByTestId("pixso-remote-scan-button").click();

    // THE ONE SELF-UPDATING ROW: visible while the ~3s-per-node fetches run, naming the
    // real total (2 — DISTINCT guids, never the 4 clones).
    await expect(page.getByText("Запрос дополнительной ноды")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Запрос дополнительной ноды \d\/2/)).toBeVisible();

    await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Карточка добавлена в галерею")).toBeVisible();
    // No degradation ⇒ no warning box (std-3's negative arm).
    await expect(page.getByTestId("pixso-nodes-warning")).toHaveCount(0);

    // Wire truth from the fake's own call log: each DISTINCT guid fetched EXACTLY once
    // (the cancelled run persisted nothing, so THIS run fetches both fresh).
    const fetched = (await fetchNodeCalls(state)).slice(before.length);
    for (const guid of NESTED_RESOLVE_INNER) {
      expect(fetched.filter((called) => called === guid)).toHaveLength(1);
    }

    // ── WAVE B SEAM PROOF (brief task 1): the RENDERED output changed ──────────────
    // «Override 9000:210001» exists ONLY inside the targeted fetch's generated payload —
    // never in the root DSL. The card's preview thumbnail (our SVG face, rendered
    // server-side from the envelope-merged tree) must carry it: read the actual bytes
    // the <img> renders from.
    const svgSources = await page
      .locator('img[src^="data:image/svg+xml"]')
      .evaluateAll((images) => images.map((image) => image.getAttribute("src") ?? ""));
    expect(svgSources.length).toBeGreaterThan(0);
    const decoded = svgSources.map((source) => decodeURIComponent(source));
    for (const guid of NESTED_RESOLVE_INNER) {
      expect(decoded.some((svg) => svg.includes(`Override ${guid}`))).toBe(true);
    }
    await saveShot(page, "reserved-nested-resolve-settled.png");
  });

  test("A1 partial failure + retry: the warning box tells the truth, «Повторить» re-requests ONLY the failed node, the box clears", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const state = readHarnessState();

    await openPixsoPanel(page);
    await ensureRemoteReady(page);

    await page.getByTestId("pixso-design-url-input").fill(designUrlFor(NESTED_PARTIAL_ITEM_ID));
    await expect(page.getByTestId("pixso-url-parsed")).toBeVisible();
    await page.getByTestId("pixso-remote-scan-button").click();

    // FAIL-SOFT: the scan COMPLETES (a card lands) even though one node fetch failed…
    await expect(page.getByText("Скан завершён")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Карточка добавлена в галерею")).toBeVisible();
    // …and the warning-class box states the degradation honestly, with the count.
    const warningBox = page.getByTestId("pixso-nodes-warning");
    await expect(warningBox).toBeVisible();
    await expect(warningBox).toContainText("Часть узлов не загрузилась");
    await expect(warningBox).toContainText("Не загрузилось дополнительных узлов: 1");
    await saveShot(page, "reserved-nested-partial-degraded.png");

    // ── retry: ONLY the failed node goes out again ────────────────────────────────
    const beforeRetry = await fetchNodeCalls(state);
    await page.getByTestId("pixso-nodes-retry").click();
    // The retry runs the ONE scan funnel — reimport settle (same bytes, same card).
    await expect(page.getByText("уже есть в галерее")).toBeVisible({ timeout: 60_000 });
    // The degradation healed: the box is GONE (its failed list is empty now).
    await expect(page.getByTestId("pixso-nodes-warning")).toHaveCount(0);

    const retried = (await fetchNodeCalls(state)).slice(beforeRetry.length);
    // The banked node must NOT be re-requested; the failed one exactly once.
    expect(retried).not.toContain(NESTED_PARTIAL_OK);
    expect(retried.filter((guid) => guid === NESTED_PARTIAL_FLAKY)).toHaveLength(1);
    await saveShot(page, "reserved-nested-partial-healed.png");
  });
});
