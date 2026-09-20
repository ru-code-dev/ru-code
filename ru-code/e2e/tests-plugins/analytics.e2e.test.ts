// ru-code v2 — spec 9: the ANALYTICS plugin, back to being a PAGE (decision V2-4).
//
// The app's compiled-in `/analytics` route, its sidebar button, its server RPCs and its migration
// are all gone; everything that page did is a drop-in folder, `@smart-tools/plugin-analytics`. This
// spec is the acceptance for that swap — the only place the ported dashboard is driven through the
// real host, in a real browser, against real qwen transcripts on disk.
//
// WHAT CHANGED FROM THE v1 SPEC, AND WHY. v1 asserted a PANEL: a footer icon that opened a docked
// column, and that the column measured exactly `ANALYTICS_PANEL_PREFERRED_WIDTH` (960 px, the top of
// the host's clamp). A18 measured the residue honestly — the KPI strip is `xl:grid-cols-7` keyed on
// the VIEWPORT, so its intrinsic width was ~1004 px against a 959 px column and the panel opened
// with a horizontal scrollbar inside it. The owner's verdict was "regression is unacceptable", so
// v2 gives the host ONE page route and this spec asserts the opposite fact: the board gets the
// whole inset, and nothing anywhere overflows.
//
// WHAT IT PINS, in the order the user meets it:
//
//   1. the footer entry «Аналитика» exists at all (the plugin's `pages[].nav`, not app chrome);
//   2. pressing it navigates to `/plugins/analytics/dashboard` and renders the dashboard;
//   3. INSIDE the app's normal chrome — the sidebar and its other footer buttons are still there,
//      and the page is not a takeover;
//   4. at FULL WIDTH: the board's own container is far wider than v1's 960 px column, the KPI strip
//      lays out at its widest breakpoint, and the document does not scroll sideways;
//   5. the NUMBERS are the seeded transcripts', not zeros — the KPI strip is read tile by tile;
//   6. the charts are real — recharts `<svg>` in the page, not a placeholder — and Refresh re-runs
//      the disk scan through `ctx.invoke`;
//   7. a THEME switch repaints the board, including the chart axes (the plugin's own stylesheet
//      resolves the app's `@theme inline` tokens, so this needs no plugin code at all);
//   8. a DIRECT navigation to the URL works on a cold load — the assertion that would fail if the
//      host route resolved plugins eagerly, because plugins are imported after the first paint;
//   9. and deleting the folder takes all of it away — no footer entry, no page, no web entry, no
//      manifest row.
//
// THE TRANSCRIPTS ARE SEEDED HERE, in the harness's own `cliConfigDir`, in the shape
// `qwen-cli-analytics`'s scanner reads (`core/telemetry.ts` `extractUiEvent`). Relative to TODAY,
// never a fixed calendar date: the dashboard's default window is the last 30 days, so hard-coded
// days would quietly fall out of it and turn this spec into an assertion about an empty board.
//
// The KPI assertions are FLOORS (`>=`), not equalities. Every seeded fact is a lower bound; the fake
// ACP CLI writes genuine transcripts of its own into the same `cliConfigDir`, so a run in which
// another spec has already sent a turn legitimately shows more. A floor is order-independent and
// still fails on the only thing worth failing on — a board that lost its data.
//
// Install/remove with a server restart on both sides, like `renderFaults` and `styles`: the host
// scans the plugins directory once per process, and every other spec in this suite counts
// manifests, statuses and footer icons.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  installPluginFolder,
  removePluginFolder,
  restartPluginsApp,
  stopPluginsApp,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

import { demoFooterButton, expect, openAppWithDemo, state, test, type Page } from "./fixtures.ts";

/** The plugin's own id — the folder name its `install-local` writes, and the URL segment. */
const ANALYTICS_ID = "analytics";

/** `ANALYTICS_PAGE_ID` in `plugin-analytics/src/web/index.tsx`. */
const ANALYTICS_PAGE_ID = "dashboard";
const PAGE_PATH = `/plugins/${ANALYTICS_ID}/${ANALYTICS_PAGE_ID}`;

/**
 * Its build output, reached through the untracked `ru-code-packages` symlink — the same dependency
 * `DEMO_PLUGIN_DIST` already takes. `dist/` IS the drop-in folder.
 */
const ANALYTICS_PLUGIN_DIST = NodePath.resolve(
  import.meta.dirname,
  "../../../ru-code-packages/packages/plugin-analytics/dist",
);

/** Stage-2 evidence, opened and verdicted in `WORKFLOW/logs/S2-analytics.md` §3. */
const STAGE_EVIDENCE_DIR = NodePath.resolve(
  import.meta.dirname,
  "../../../WORKFLOW/logs/S2-analytics-evidence",
);

/** The viewport the stage's two PNGs are taken at. */
const EVIDENCE_VIEWPORT = { width: 1280, height: 800 } as const;

/** Locale-agnostic by construction — this suite switches the app's language (see `fixtures.ts`). */
const ANALYTICS_LABEL = /^(Аналитика|Analytics)$/;
const REFRESH_LABEL = /^(Обновить статистику|Refresh analytics)$/;
const TOTAL_TOKENS_LABEL = /^(Всего токенов|Total tokens)$/i;
const SESSIONS_LABEL = /^(Сессий|Sessions)$/i;
const PROJECTS_LABEL = /^(Проектов|Projects)$/i;
const API_CALLS_LABEL = /^(Запросов API|API requests)$/i;
const TOOL_CALLS_LABEL = /^(Вызовов инструментов|Tool calls)$/i;
/** `AnalyticsDashboard.tsx` renders this INSTEAD of the board when there is nothing to show. */
const EMPTY_BOARD = /Пока нет сессий|No sessions yet/;

const PAGE = '[data-testid="analytics-page"]';

// ── the seeded corpus ────────────────────────────────────────────────────────────────────────

/** 4 sessions in 3 projects; every count below is what the KPI strip must be able to reach. */
const SEEDED_SESSIONS = 4;
const SEEDED_PROJECTS = 3;
/** 3 + 2 + 2 + 2 `api_response` events, and 5 + 3 + 4 + 3 `tool_call`s, across those 4 sessions. */
const SEEDED_API_CALLS = 9;
const SEEDED_TOOL_CALLS = 15;

const isoAt = (daysAgo: number, hour: number, minute: number): string => {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  at.setUTCHours(hour, minute, 0, 0);
  return at.toISOString();
};

/** One `system/ui_telemetry` line — the only shape the package's `extractUiEvent` accepts. */
const uiLine = (input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly event: Readonly<Record<string, unknown>>;
}): string =>
  JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    cwd: input.cwd,
    gitBranch: "main",
    sessionId: input.sessionId,
    timestamp: input.ts,
    systemPayload: { uiEvent: { "event.timestamp": input.ts, ...input.event } },
  });

/**
 * Write a real qwen transcript tree the scanner accepts.
 *
 * Layout: `<cliConfigDir>/projects/<slugged cwd>/chats/<32-hex>.jsonl`, one JSON object per line.
 */
function seedTranscripts(cliConfigDir: string): {
  readonly files: number;
  readonly events: number;
} {
  const model1 = "qwen/qwen3.6-35b-a3b";
  const model2 = "qwen/qwen3.6-coder-72b";
  const sessions = [
    {
      dir: "-a20-alpha",
      cwd: "/a20/alpha",
      sessionId: "a2000001-0001-4001-8001-000000000001",
      daysAgo: 6,
      first: "Refactor the parser module",
      turns: [
        { hour: 9, model: model1, input: 1200, output: 340, tools: ["read_file", "grep"] },
        { hour: 10, model: model1, input: 2400, output: 610, tools: ["edit", "shell"] },
        { hour: 11, model: model2, input: 3100, output: 220, tools: ["read_file"] },
      ],
    },
    {
      dir: "-a20-alpha",
      cwd: "/a20/alpha",
      sessionId: "a2000002-0002-4002-8002-000000000002",
      daysAgo: 4,
      first: "Add tests for the scanner",
      turns: [
        { hour: 14, model: model2, input: 900, output: 180, tools: ["write_file"] },
        { hour: 15, model: model2, input: 1500, output: 400, tools: ["shell", "shell"] },
      ],
    },
    {
      dir: "-a20-beta",
      cwd: "/a20/beta",
      sessionId: "a2000003-0003-4003-8003-000000000003",
      daysAgo: 2,
      first: "Investigate the flaky websocket test",
      turns: [
        {
          hour: 11,
          model: model1,
          input: 5200,
          output: 1300,
          tools: ["read_file", "grep", "edit"],
        },
        { hour: 12, model: model1, input: 4100, output: 780, tools: ["shell"] },
      ],
    },
    {
      dir: "-a20-gamma",
      cwd: "/a20/gamma",
      sessionId: "a2000004-0004-4004-8004-000000000004",
      daysAgo: 1,
      first: "Write the release notes",
      turns: [
        { hour: 8, model: model1, input: 300, output: 900, tools: ["write_file"] },
        { hour: 9, model: model2, input: 640, output: 210, tools: ["read_file", "edit"] },
      ],
    },
  ] as const;

  let files = 0;
  let events = 0;
  for (const session of sessions) {
    const lines: string[] = [
      JSON.stringify({
        type: "user",
        cwd: session.cwd,
        sessionId: session.sessionId,
        timestamp: isoAt(session.daysAgo, session.turns[0]?.hour ?? 9, 0),
        message: { role: "user", content: [{ type: "text", text: session.first }] },
      }),
    ];
    session.turns.forEach((turn, turnIndex) => {
      const promptId = `${session.sessionId}########${String(turnIndex)}`;
      lines.push(
        uiLine({
          cwd: session.cwd,
          sessionId: session.sessionId,
          ts: isoAt(session.daysAgo, turn.hour, 0),
          event: {
            "event.name": "qwen-code.api_response",
            model: turn.model,
            input_token_count: turn.input,
            output_token_count: turn.output,
            cached_content_token_count: 0,
            thoughts_token_count: 0,
            duration_ms: 3000 + turnIndex * 700,
            ttft_ms: 500 + turnIndex * 120,
            prompt_id: promptId,
          },
        }),
      );
      events += 1;
      turn.tools.forEach((fn, toolIndex) => {
        lines.push(
          uiLine({
            cwd: session.cwd,
            sessionId: session.sessionId,
            ts: isoAt(session.daysAgo, turn.hour, 10 + toolIndex),
            event: {
              "event.name": "qwen-code.tool_call",
              function_name: fn,
              success: true,
              decision: "auto_accept",
              duration_ms: 100 + toolIndex * 55,
              tool_type: "native",
              prompt_id: promptId,
            },
          }),
        );
        events += 1;
      });
    });
    const chats = NodePath.join(cliConfigDir, "projects", session.dir, "chats");
    NodeFS.mkdirSync(chats, { recursive: true });
    // The scanner keys a session by its FILE, so the name only has to be a 32-hex-ish `.jsonl`.
    NodeFS.writeFileSync(
      NodePath.join(chats, `${session.sessionId.replaceAll("-", "")}.jsonl`),
      `${lines.join("\n")}\n`,
      "utf8",
    );
    files += 1;
  }
  return { files, events };
}

// ── reading the board ────────────────────────────────────────────────────────────────────────

type KpiTile = { readonly label: string | null; readonly value: string };

/**
 * The KPI strip, tile by tile.
 *
 * Read from `KpiStrip`'s OWN grid (`xl:grid-cols-7`, one child per tile) rather than by matching
 * digits anywhere on the page: "4" appears in an axis tick too, and a board that had lost its strip
 * entirely would still satisfy a text match.
 */
const readKpis = (page: Page): Promise<ReadonlyArray<KpiTile>> =>
  page.evaluate((selector: string) => {
    const root = document.querySelector(selector);
    const strip = root?.querySelector('[class*="grid-cols-7"]') ?? null;
    if (strip === null) return [] as Array<{ label: string | null; value: string }>;
    return [...strip.children].map((tile) => ({
      label: tile.querySelector('span[class*="uppercase"]')?.textContent?.trim() ?? null,
      value: tile.querySelector('span[class*="font-mono"]')?.textContent?.trim() ?? "",
    }));
  }, PAGE);

/** Everything the theme is supposed to move, in one read. */
const themeFacts = (page: Page) =>
  page.evaluate((selector: string) => {
    const root = document.querySelector(selector);
    // recharts renders its axis labels as `<text>` inside `.recharts-wrapper`; the exact wrapper
    // class has moved between recharts majors, so the query is anchored on the wrapper (which the
    // package's own `ChartContainer` owns) rather than on a tick class name.
    const tick = document.querySelector(".recharts-wrapper text");
    const card = root?.querySelector('[class*="bg-card"]') ?? null;
    return {
      background: root === null ? "" : getComputedStyle(root).backgroundColor,
      color: root === null ? "" : getComputedStyle(root).color,
      cardBackground: card === null ? "" : getComputedStyle(card).backgroundColor,
      axisFill: tick === null ? "" : getComputedStyle(tick).fill,
      axisClass: tick === null ? "" : (tick.getAttribute("class") ?? ""),
      documentTheme: document.documentElement.className,
    };
  }, PAGE);

/** The board's real geometry — the whole point of V2-4. */
const layoutFacts = (page: Page) =>
  page.evaluate((selector: string) => {
    const root = document.querySelector(selector);
    // `AnalyticsDashboard` wraps the board in `mx-auto max-w-[1400px]`; that element's width is
    // what a panel used to clamp to 960.
    const board = root?.querySelector('[class*="max-w-\\[1400px\\]"]') ?? null;
    const strip = root?.querySelector('[class*="grid-cols-7"]') ?? null;
    return {
      pageWidth: root === null ? 0 : Math.round(root.getBoundingClientRect().width),
      boardWidth: board === null ? 0 : Math.round(board.getBoundingClientRect().width),
      boardScrollWidth: board === null ? 0 : board.scrollWidth,
      stripColumns:
        strip === null ? 0 : getComputedStyle(strip).gridTemplateColumns.split(" ").length,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  }, PAGE);

/** A PNG in the stage's own evidence folder, at a fixed viewport, plus the suite's own copy. */
async function saveStagePng(page: Page, name: string): Promise<string> {
  NodeFS.mkdirSync(STAGE_EVIDENCE_DIR, { recursive: true });
  const file = NodePath.join(STAGE_EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  await saveEvidenceScreenshot(page, `09-${name}`);
  return file;
}

// ── the spec ─────────────────────────────────────────────────────────────────────────────────

test.describe("plugins — the analytics plugin is the analytics PAGE", () => {
  // Two full server restarts inside the test plus a disk scan; the default 120 s covers neither.
  test.setTimeout(300_000);

  test.beforeAll(async () => {
    const entry = NodePath.join(ANALYTICS_PLUGIN_DIST, "plugin.json");
    if (!NodeFS.existsSync(entry)) {
      throw new Error(
        `[plugins-e2e] no analytics plugin build output at ${ANALYTICS_PLUGIN_DIST}\n` +
          `[plugins-e2e] run, in the ru-code-packages worktree: ` +
          `pnpm --filter @smart-tools/plugin-analytics build`,
      );
    }
    const current = state();
    await stopPluginsApp(current);
    // BEFORE the server starts: the scanner reads this directory, and the plugin's own database is
    // migrated on the host's first boot with the folder present.
    seedTranscripts(current.cliConfigDir);
    // Idempotent — `pluginsBoot` already seeds this folder when the package has been built.
    installPluginFolder(current.pluginsDir, ANALYTICS_ID, ANALYTICS_PLUGIN_DIST);
    await restartPluginsApp(current);
  });

  test.afterAll(async () => {
    // REINSTALL, do not leave the folder removed (S2-analytics §6.5). The last thing the test body
    // does is delete the folder and restart, to prove an uninstall takes the page away — and the
    // harness only seeds plugins at BOOT, so a spec ordered after this one in the same run used to
    // find an app with no analytics plugin at all. Putting it back and restarting once leaves the
    // shared app exactly as `pluginsBoot` built it, which is what every other spec assumes.
    const current = state();
    await stopPluginsApp(current);
    installPluginFolder(current.pluginsDir, ANALYTICS_ID, ANALYTICS_PLUGIN_DIST);
    await restartPluginsApp(current);
  });

  test("the footer entry opens the page, it renders the seeded board at full width, the theme repaints it, and removing the folder takes it away", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const evidence: Record<string, unknown> = { spec: "analytics.e2e.test.ts", path: PAGE_PATH };

    await page.setViewportSize({ ...EVIDENCE_VIEWPORT });
    await page.emulateMedia({ colorScheme: "light" });
    await openAppWithDemo(page);

    // ── 1. the plugin's footer entry exists, beside the demo's ───────────────────────────────
    //
    // The app contributes NO analytics button of its own any more (its `/analytics` route and the
    // `ChartNoAxesColumnIcon` beside Settings were deleted with the v1 extraction), so this button
    // exists only because the plugin's `pages[].nav` asked for it.
    const analyticsButton = page.getByRole("button", { name: ANALYTICS_LABEL }).first();
    await expect(analyticsButton, "the plugin's «Аналитика» footer entry").toBeVisible({
      timeout: 30_000,
    });
    await expect(demoFooterButton(page), "…beside the demo plugin's own").toBeVisible();

    // ── 2. it navigates to the host-owned route and renders the dashboard ────────────────────
    await analyticsButton.click();
    const board = page.locator(PAGE);
    await expect(board, "the plugin's page").toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname, "on the host-owned page route").toBe(PAGE_PATH);

    // ── 3. inside the app's normal chrome ────────────────────────────────────────────────────
    //
    // A plugin PAGE is a page of the app, not a takeover (S1 §3, choice 11): the sidebar stays and
    // the page sits inside it.
    //
    // ru-code S22 (owner): a plugin page is a WHOLE-AREA page like `/usage`, so the sidebar's
    // bottom bar collapses to the same Back button there (`ru-code/sidebar/footerPage.ts` recognises
    // the host-owned `/plugins/<id>/<page>` route; no plugin is involved). The footer ICON ROW is
    // therefore NOT on screen while the board is open — which is what this step used to assert, via
    // the Settings icon and the demo plugin's entry. The baseline compiled-in `/analytics` page had
    // the Back button too, so asserting it here is asserting the same thing the icons stood for:
    // the app's own chrome is still in charge of this surface.
    await expect(
      page.locator('[data-slot="sidebar"]').first(),
      "the app's own sidebar is still there",
    ).toBeVisible();
    await expect(
      page.locator('[data-sidebar="footer"]').getByRole("button", { name: /^(Назад|Back)$/ }),
      "…with the app's own Back in its footer, the way every whole-area page has it",
    ).toBeVisible({ timeout: 30_000 });

    // ── 4. the board loads, with the seeded numbers ──────────────────────────────────────────
    //
    // A POSITIVE predicate: the KPI strip is rendered only when `hasContent` is true, and the strip
    // and the state paragraph («Загрузка статистики…», «Пока нет сессий») are mutually exclusive in
    // `AnalyticsDashboard`. Waiting for the empty text to be absent would pass while the board was
    // still LOADING, which is a different string and a vacuous wait.
    await expect(
      board.getByText(SESSIONS_LABEL).first(),
      "the KPI strip is on the board, i.e. the snapshot arrived",
    ).toBeVisible({ timeout: 60_000 });
    await expect(board.getByText(EMPTY_BOARD), "…and it is not the empty state").toHaveCount(0);

    const kpis = await readKpis(page);
    const kpi = (label: RegExp): number => {
      const tile = kpis.find((entry) => entry.label !== null && label.test(entry.label));
      expect(tile, `the KPI tile ${String(label)} is on the board`).toBeDefined();
      return Number.parseInt((tile?.value ?? "").replace(/[^\d]/g, ""), 10);
    };
    expect(kpis.length, "all seven KPI tiles are on the strip").toBe(7);
    expect(kpi(SESSIONS_LABEL), "sessions").toBeGreaterThanOrEqual(SEEDED_SESSIONS);
    expect(kpi(PROJECTS_LABEL), "projects").toBeGreaterThanOrEqual(SEEDED_PROJECTS);
    expect(kpi(API_CALLS_LABEL), "API requests").toBeGreaterThanOrEqual(SEEDED_API_CALLS);
    expect(kpi(TOOL_CALLS_LABEL), "tool calls").toBeGreaterThanOrEqual(SEEDED_TOOL_CALLS);
    // `formatTokens` prints `28K`, so the digits alone are the mantissa — a floor of 1 is the
    // honest assertion that the tile is not the zero the empty board would show.
    expect(kpi(TOTAL_TOKENS_LABEL), "total tokens is not zero").toBeGreaterThanOrEqual(1);
    evidence["kpis"] = kpis;

    // ── 5. FULL WIDTH — the whole of decision V2-4 ───────────────────────────────────────────
    const layout = await layoutFacts(page);
    evidence["layout"] = layout;
    // v1's panel asked the host for 960 px and got a board whose own content wanted ~1004. On the
    // page route the board is simply as wide as the inset, so the number to beat is 960.
    expect(
      layout.boardWidth,
      "the board is wider than v1's 960 px panel could ever be",
    ).toBeGreaterThan(960);
    // …and it is not merely wide: its content FITS, where the panel's did not.
    expect(
      layout.boardScrollWidth,
      "the board does not scroll sideways inside itself",
    ).toBeLessThanOrEqual(layout.boardWidth + 1);
    // The strip is past its narrow layouts: `grid-cols-2` on a phone, `sm:grid-cols-3`,
    // `lg:grid-cols-4` from 1024 px. Four at a 1280 px window is the app's own sidebar taking its
    // share of the viewport, and it is the honest number to assert here.
    expect(
      layout.stripColumns,
      "the KPI strip is at its lg layout or wider",
    ).toBeGreaterThanOrEqual(4);
    expect(layout.documentScrollWidth, "and the document itself does not scroll sideways").toBe(
      layout.documentClientWidth,
    );

    // ── 5b. the exact configuration v1 could NOT fit ─────────────────────────────────────────
    //
    // A18 §4.3 measured the residual on the v1 panel at a 1600 px window: `xl:grid-cols-7` is keyed
    // on the VIEWPORT, so the strip's intrinsic width was ~1004 px inside a 959 px column and the
    // panel scrolled sideways on every open. Same window, same strip, on the page route.
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect
      .poll(async () => (await layoutFacts(page)).stripColumns, {
        timeout: 20_000,
        message: "the KPI strip reaches its seven-column layout at 1600 px",
      })
      .toBe(7);
    const wide = await layoutFacts(page);
    evidence["layoutWide"] = wide;
    expect(
      wide.boardScrollWidth,
      "…and it FITS, where v1's 960 px column did not",
    ).toBeLessThanOrEqual(wide.boardWidth + 1);
    expect(wide.documentScrollWidth, "…with no sideways scroll on the document either").toBe(
      wide.documentClientWidth,
    );
    await page.setViewportSize({ ...EVIDENCE_VIEWPORT });

    // ── 6. the charts are real, and Refresh re-runs the scan ─────────────────────────────────
    const charts = await page.evaluate((selector: string) => {
      const root = document.querySelector(selector);
      return {
        svg: root === null ? 0 : root.querySelectorAll("svg").length,
        recharts: root === null ? 0 : root.querySelectorAll(".recharts-wrapper").length,
      };
    }, PAGE);
    expect(charts.svg, "the page renders SVG").toBeGreaterThan(0);
    expect(charts.recharts, "…including recharts surfaces").toBeGreaterThan(0);
    evidence["charts"] = charts;

    const refresh = board.getByRole("button", { name: REFRESH_LABEL }).first();
    await expect(refresh, "the dashboard's own Refresh control").toBeEnabled({ timeout: 60_000 });
    await refresh.click();
    // It disables itself while the RPC is in flight; being enabled again is the round trip landing.
    await expect(refresh, "…and the refresh completes").toBeEnabled({ timeout: 60_000 });
    await expect(board.getByText(EMPTY_BOARD), "…leaving real content behind").toHaveCount(0);

    // ── 7. the theme repaints the board, charts included ─────────────────────────────────────
    //
    // No plugin code runs for this. The plugin's stylesheet is compiled against the SDK's copy of
    // the app's `@theme inline` block, so `bg-background`, `bg-card` and the chart axes resolve the
    // APP's variables and follow its switch by construction.
    // Two things before the evidence PNGs, both about what the picture SHOWS rather than what the
    // app does:
    //
    //  1. the `demo-broken` fixture raises its own «не загрузился» toast at boot and it parks over
    //     the filter bar. It is another spec's expected output, not this one's. Dismissed in a
    //     bounded poll (the stack re-renders as each toast leaves), best effort;
    //  2. recharts animates every series in on mount and settles its widths asynchronously (A18
    //     measured the same board reporting two different widths seconds apart), so a capture taken
    //     the instant the board appears shows half-drawn arcs. One settle beat, then the shot.
    await expect
      .poll(
        async () => {
          for (const close of await page.locator('[data-slot="toast-close"]').all()) {
            await close.click({ timeout: 2_000 }).catch(() => undefined);
          }
          return await page.locator('[data-slot="toast-close"]').count();
        },
        { timeout: 15_000, intervals: [500], message: "the boot toasts are dismissed" },
      )
      .toBe(0)
      .catch(() => undefined);
    await page.waitForTimeout(2_000);

    const light = await themeFacts(page);
    const lightPng = await saveStagePng(page, "analytics-page-light");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(async () => (await themeFacts(page)).background, {
        timeout: 20_000,
        message: "the page's computed background follows the theme",
      })
      .not.toBe(light.background);
    await page.waitForTimeout(1_000);
    const dark = await themeFacts(page);
    const darkPng = await saveStagePng(page, "analytics-page-dark");
    evidence["theme"] = { light, dark, lightPng, darkPng };

    expect(dark.background, "the page background moved").not.toBe(light.background);
    expect(dark.cardBackground, "…the widget cards moved with it").not.toBe(light.cardBackground);
    expect(dark.color, "…and so did the text painted on them").not.toBe(light.color);
    // The two captures are genuinely different renders, not the same frame written twice.
    expect(
      NodeFS.readFileSync(darkPng).equals(NodeFS.readFileSync(lightPng)),
      "the two evidence PNGs are different pictures",
    ).toBe(false);
    // `axisFill` is ASSERTED now (S3 step J). recharts 3.10 renders a tick label as
    // `<text class="recharts-text recharts-cartesian-axis-tick-value">` whose PARENT is not
    // `.recharts-cartesian-axis-tick`, so the package's `[&_.recharts-cartesian-axis-tick_text]:`
    // override never matched and every tick kept recharts' own `fill="#666"` in BOTH themes —
    // measured here and in the baseline. `qwen-cli-analytics` now also names the class the label
    // really carries, so the ticks take the token colour and move with the theme like everything
    // else on the board.
    expect(light.axisFill, "the chart's tick labels are painted at all").not.toBe("");
    expect(light.axisFill, "…in the token colour, not recharts' own #666").not.toBe(
      "rgb(102, 102, 102)",
    );
    expect(dark.axisFill, "…and they move with the theme").not.toBe(light.axisFill);

    // The page's own text, for the parity comparison against `logs/baseline/views/analytics.txt`.
    evidence["innerText"] = await board.innerText();
    await page.emulateMedia({ colorScheme: "light" });

    // ── 8. a DIRECT navigation, cold ─────────────────────────────────────────────────────────
    //
    // The plugins are imported after the first paint, so a route that resolved its page eagerly
    // would render "not installed" and stay there. This is the assertion that catches it.
    await page.goto(`${state().webUrl}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(PAGE), "a cold load of the URL renders the page").toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator(PAGE).getByText(SESSIONS_LABEL).first(),
      "…and the board fills itself, with no click anywhere",
    ).toBeVisible({ timeout: 60_000 });
    await saveEvidenceScreenshot(page, "09-analytics-direct-url");

    saveEvidenceJson("09-analytics", { ...evidence, pageErrors });
    expect(pageErrors, "no page errors with the plugin installed").toEqual([]);

    // ── 9. uninstall: the folder goes, and everything it contributed goes with it ────────────
    const before = state();
    await stopPluginsApp(before);
    removePluginFolder(before.pluginsDir, ANALYTICS_ID);
    const after = await restartPluginsApp(before);

    await openAppWithDemo(page);
    await expect(
      page.getByRole("button", { name: ANALYTICS_LABEL }),
      "no «Аналитика» entry once the folder is gone — the app contributes none of its own",
    ).toHaveCount(0);

    // The host still OWNS the route (it is one catch-all), so the URL does not 404 — it renders the
    // host's own "no such page" notice, inside the chrome. That is the honest v2 shape: the route
    // belongs to the app, the page belonged to a plugin that is no longer installed.
    await page.goto(`${after.webUrl}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="plugin-page-missing"]'),
      "the page URL says the plugin is not installed, inside the app's chrome",
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(PAGE), "…and the board is nowhere").toHaveCount(0);
    // ru-code S22: `/plugins/<id>/<page>` is a whole-area route whether or not a plugin answers it,
    // so the sidebar footer is the Back button here too — the app's own chrome, still in charge of
    // a page whose plugin is gone. (This step asserted the Settings footer ICON before that change.)
    await expect(
      page.locator('[data-sidebar="footer"]').getByRole("button", { name: /^(Назад|Back)$/ }),
      "…with the app entirely intact around it",
    ).toBeVisible();

    const routes = await page.evaluate(async (origin: string) => {
      const status = async (path: string): Promise<number> =>
        await fetch(`${origin}${path}`).then(
          (response) => response.status,
          () => -1,
        );
      return {
        webEntry: await status("/plugins/analytics/web/index.mjs"),
        styles: await status("/plugins/analytics/web/styles.css"),
        manifests: await fetch(`${origin}/plugins/manifests.json`).then(
          async (response) => (await response.json()) as unknown,
        ),
      };
    }, after.webUrl);
    expect(routes.webEntry, "the plugin's web entry is 404").toBe(404);
    expect(routes.styles, "…and so is its stylesheet").toBe(404);
    expect(
      JSON.stringify(routes.manifests).includes(`"${ANALYTICS_ID}"`),
      "…and it is not in the manifest list",
    ).toBe(false);

    await saveEvidenceScreenshot(page, "09-analytics-uninstalled");
    saveEvidenceJson("09-analytics-uninstalled", { routes, pageErrors });
    expect(pageErrors, "no page errors after the uninstall either").toEqual([]);
  });
});
