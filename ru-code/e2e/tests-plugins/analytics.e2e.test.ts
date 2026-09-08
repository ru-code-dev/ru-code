// ru-code (A20) — spec 9: the ANALYTICS plugin, in the real app, after the compiled-in page is gone.
//
// A19 deleted the app's `/analytics` route, its sidebar button, its server RPCs and its migration.
// Everything that page did is now a drop-in folder: `@smart-tools/plugin-analytics`. This spec is
// the acceptance for that swap — the only place the ported dashboard is driven through the real
// host, in a real browser, against real qwen transcripts on disk.
//
// WHAT IT PINS, in the order the user meets it:
//
//   1. the footer icon «Аналитика» exists at all (the plugin's `registerPanel`, not app chrome);
//   2. it opens the panel at the width the plugin ASKS for — `ANALYTICS_PANEL_PREFERRED_WIDTH`,
//      960 since A18 finding M2 — which is the seam A16 added to the host for exactly this plugin
//      (the app's own default is 448, and nine widgets in a 448 px strip is a product change);
//   3. Refresh re-runs the disk scan through `plugin.invoke` and the board survives it;
//   4. the charts are real — recharts `<svg>` in the panel, not a placeholder;
//   5. the NUMBERS are the seeded transcripts', not zeros: the KPI strip is read tile by tile;
//   6. and deleting the folder takes all of it away — no button, no entry point, 404.
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

import { demoFooterButton, expect, openAppWithDemo, state, test } from "./fixtures.ts";

/** The plugin's own id — the folder name its `install-local` writes, and the URL segment. */
const ANALYTICS_ID = "analytics";

/**
 * Its build output, reached through the untracked `ru-code-packages` symlink — the same dependency
 * `DEMO_PLUGIN_DIST` already takes. `dist/` IS the drop-in folder (D4).
 */
const ANALYTICS_PLUGIN_DIST = NodePath.resolve(
  import.meta.dirname,
  "../../../ru-code-packages/packages/plugin-analytics/dist",
);

/** `ANALYTICS_PANEL_PREFERRED_WIDTH` in `plugin-analytics/src/web/index.tsx`. */
const EXPECTED_PANEL_WIDTH = 960;

/** Locale-agnostic by construction — this suite switches the app's language (see `fixtures.ts`). */
const ANALYTICS_LABEL = /^(Аналитика|Analytics)$/;
const REFRESH_LABEL = /^(Обновить статистику|Refresh analytics)$/;
const SESSIONS_LABEL = /^(Сессий|Sessions)$/;
const PROJECTS_LABEL = /^(Проектов|Projects)$/;
const API_CALLS_LABEL = /^(Запросов API|API requests)$/;
const TOOL_CALLS_LABEL = /^(Вызовов инструментов|Tool calls)$/;
/** `AnalyticsDashboard.tsx` renders this INSTEAD of the board when there is nothing to show. */
const EMPTY_BOARD = /Пока нет сессий|No sessions yet/;

const PANEL = '[data-testid="analytics-panel"]';

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

// ── the spec ─────────────────────────────────────────────────────────────────────────────────

test.describe("plugins — the analytics plugin is the analytics page", () => {
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
    seedTranscripts(current.cliConfigDir);
    installPluginFolder(current.pluginsDir, ANALYTICS_ID, ANALYTICS_PLUGIN_DIST);
    await restartPluginsApp(current);
  });

  test.afterAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    removePluginFolder(current.pluginsDir, ANALYTICS_ID);
    await restartPluginsApp(current);
  });

  test("the footer icon opens the dashboard, it renders the seeded numbers, and removing the folder takes it away", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await openAppWithDemo(page);

    // ── 1. the plugin's footer button exists, beside the demo's ──────────────────────────────
    const analyticsButton = page.getByRole("button", { name: ANALYTICS_LABEL }).first();
    await expect(analyticsButton, "the plugin's «Аналитика» footer button").toBeVisible({
      timeout: 30_000,
    });
    await expect(demoFooterButton(page), "…beside the demo plugin's own").toBeVisible();

    // ── 2. it opens the panel, at the width the PLUGIN asked for ─────────────────────────────
    await analyticsButton.click();
    const panel = page.locator(PANEL);
    await expect(panel, "the plugin's panel").toBeVisible({ timeout: 30_000 });

    // The docked column is the nearest ancestor carrying an inline `width` — `DockedGlobalPanel`
    // renders `style={{ width: `${width}px` }}` and nothing else on the way up does.
    const column = await page.evaluate((selector: string) => {
      let node: HTMLElement | null = document.querySelector<HTMLElement>(selector);
      while (node !== null && node !== document.body) {
        if (node.style.width.endsWith("px")) {
          return {
            inline: node.style.width,
            measured: Math.round(node.getBoundingClientRect().width),
          };
        }
        node = node.parentElement;
      }
      return null;
    }, PANEL);
    expect(column, "the panel is docked in a column with an inline width").not.toBeNull();
    expect(column?.inline, "…the width the plugin's `preferredWidth` asked for").toBe(
      `${String(EXPECTED_PANEL_WIDTH)}px`,
    );
    expect(column?.measured, "…and that is what it measures").toBe(EXPECTED_PANEL_WIDTH);

    // ── 3. the board loads, and Refresh re-runs the scan ─────────────────────────────────────
    //
    // A POSITIVE predicate: the KPI strip is rendered only when `hasContent` is true, and the
    // strip and the state paragraph («Загрузка статистики…», «Пока нет сессий») are mutually
    // exclusive in `AnalyticsDashboard`. Waiting for the empty text to be absent would pass while
    // the board was still LOADING, which is a different string and a vacuous wait.
    await expect(
      panel.getByText(SESSIONS_LABEL).first(),
      "the KPI strip is on the board, i.e. the snapshot arrived",
    ).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText(EMPTY_BOARD), "…and it is not the empty state").toHaveCount(0);

    const refresh = panel.getByRole("button", { name: REFRESH_LABEL }).first();
    await expect(refresh, "the dashboard's own Refresh control").toBeEnabled({ timeout: 60_000 });
    await refresh.click();
    // It disables itself while the RPC is in flight; being enabled again is the round trip landing.
    await expect(refresh, "…and the refresh completes").toBeEnabled({ timeout: 60_000 });
    await expect(panel.getByText(EMPTY_BOARD), "…leaving real content behind").toHaveCount(0);

    // ── 4. the charts are real ───────────────────────────────────────────────────────────────
    const charts = await page.evaluate((selector: string) => {
      const root = document.querySelector(selector);
      return {
        svg: root === null ? 0 : root.querySelectorAll("svg").length,
        recharts: root === null ? 0 : root.querySelectorAll(".recharts-wrapper").length,
      };
    }, PANEL);
    expect(charts.svg, "the panel renders SVG").toBeGreaterThan(0);
    expect(charts.recharts, "…including recharts surfaces").toBeGreaterThan(0);

    // ── 5. the numbers are the transcripts', not zeros ───────────────────────────────────────
    //
    // Read tile by tile rather than by matching digits anywhere in the panel: "4" appears in an
    // axis tick too, and a board that had lost its KPI strip would still satisfy a text match.
    const kpis = await page.evaluate((selector: string) => {
      const root = document.querySelector(selector);
      // `KpiStrip`'s own grid — `xl:grid-cols-7`, one child per tile. Scoping to it keeps the pairs
      // honest: a card elsewhere on the board also has a rounded tile and a mono number.
      const strip = root?.querySelector('[class*="grid-cols-7"]') ?? null;
      if (strip === null) return [];
      return [...strip.children].map((tile) => ({
        label: tile.querySelector('span[class*="uppercase"]')?.textContent?.trim() ?? null,
        value: tile.querySelector('span[class*="font-mono"]')?.textContent?.trim() ?? "",
      }));
    }, PANEL);
    const kpi = (label: RegExp): number => {
      const tile = kpis.find((entry) => entry.label !== null && label.test(entry.label));
      expect(tile, `the KPI tile ${String(label)} is on the board`).toBeDefined();
      return Number.parseInt((tile?.value ?? "").replace(/[^\d]/g, ""), 10);
    };
    expect(kpi(SESSIONS_LABEL), "sessions").toBeGreaterThanOrEqual(SEEDED_SESSIONS);
    expect(kpi(PROJECTS_LABEL), "projects").toBeGreaterThanOrEqual(SEEDED_PROJECTS);
    expect(kpi(API_CALLS_LABEL), "API requests").toBeGreaterThanOrEqual(SEEDED_API_CALLS);
    expect(kpi(TOOL_CALLS_LABEL), "tool calls").toBeGreaterThanOrEqual(SEEDED_TOOL_CALLS);

    await saveEvidenceScreenshot(page, "09-analytics-panel");
    await saveEvidenceJson("09-analytics", { column, charts, kpis, pageErrors });
    expect(pageErrors, "no page errors with the plugin installed").toEqual([]);

    // ── 6. uninstall: the folder goes, and everything it contributed goes with it ────────────
    const before = state();
    await stopPluginsApp(before);
    removePluginFolder(before.pluginsDir, ANALYTICS_ID);
    const after = await restartPluginsApp(before);

    await openAppWithDemo(page);
    await expect(
      page.getByRole("button", { name: ANALYTICS_LABEL }),
      "no «Аналитика» button once the folder is gone — the app contributes none of its own",
    ).toHaveCount(0);

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
    await saveEvidenceJson("09-analytics-uninstalled", { routes, pageErrors });
    expect(pageErrors, "no page errors after the uninstall either").toEqual([]);
  });
});
