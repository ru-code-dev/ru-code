// ru-code v2 (S38 step 12.5): the AUTO CODER plugin, end to end in the real app.
//
// `packages/plugin-auto-coder/e2e/autoCoder.e2e.test.ts` drives the same panel inside the SDK's
// playground, where the host is a stub. This file is the other half of that pair: the panel mounted
// by the APP's own plugin host, in the app's global right slot, against the app's real projects,
// over the real websocket, with a REAL process on the other end of Start. Five claims:
//
//  1. THE NAV ENTRY. `panels` returns `mount: "panel"` plus a `nav` entry, so the plugin gets a
//     footer icon and the panel opens from it — the only way a user reaches this plugin.
//  2. THE PROJECT LINE. The panel starts on `ctx.activeProject`, which in the app is the project the
//     window is looking at; tab 1's `Repository` default is that project's folder name, which is
//     what proves the panel is reading the APP's project and not a fixture.
//  3. THE GEAR SAVES. A token typed into the second view is in the plugin's OWN SQLite when the
//     field is left — no Apply button anywhere (V2-38).
//  4. START AND STOP. Start writes `.env` and `local-repos.json` into the plugin's data dir and
//     spawns `node <shipped script>` there; its stdout reaches the pane. Stop takes the process
//     group down, and this file leaves nothing running (rules.md §1.6).
//  5. THE CLOSE ICON. The header's ✕ calls `ctx.closePanel("auto-coder")` (V2-15).
//
// The panel is CLOSED again at the end: the global right slot is mutually exclusive, and every
// later spec in this suite opens its own surface.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AUTO_CODER_ID, restartPluginsApp, stopPluginsApp } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

import {
  closeDemoPanel,
  expect,
  openAppWithDemo,
  openDemoPanel,
  state,
  test,
  type Page,
} from "./fixtures.ts";

/** The footer entry's `aria-label` is the panel's nav label (`SidebarChrome.tsx`). */
const PANEL_LABEL = /^(Auto Coder|Авто Кодер)$/;
const CLOSE_LABEL = /^(Close Auto Coder|Закрыть Авто Кодер)$/;
const SETTINGS_LABEL = /^(Settings|Настройки)$/;
const BACK_LABEL = /^(Back|Назад)$/;
const RUN_TAB = /^(Run|Запуск)$/;
const PROJECT_TAB = /^(Project|Проект)$/;
const JIRA_TOKEN_LABEL = /^(Jira token|Токен Jira)$/;
const REPOSITORY_LABEL = /^(Repository|Репозиторий)$/;
const START_LABEL = /^(Start|Запустить)$/;
const STOP_LABEL = /^(Stop|Остановить)$/;

/**
 * THIS panel's subtree.
 *
 * The host wraps every plugin surface in `[data-plugin-root="<id>"]` (V2-14) and mounts one such
 * wrapper per surface, so the one that holds the heading is the open panel. Scoping matters here
 * beyond tidiness: the app's OWN sidebar has a button labelled "Settings" too, and an unscoped
 * `getByRole("button", { name: /Settings/ })` is a strict-mode violation, not a test.
 */
const panel = (page: Page) =>
  page
    .locator('[data-plugin-root="auto-coder"]')
    .filter({ has: page.getByRole("heading", { name: PANEL_LABEL }) });

/** `<stateDir>/plugins/auto-coder` — `host.paths.dataDir`, the same path `fixtures.ts` reads. */
const dataDir = (): string => NodePath.join(state().stateDir, "plugins", AUTO_CODER_ID);

/** The plugin's own SQLite, read directly: the gear's save has to be ON DISK, not in a store. */
const readSettings = async (): Promise<Record<string, unknown> | null> => {
  const file = NodePath.join(dataDir(), "data.sqlite");
  if (!NodeFS.existsSync(file)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT jira_token, bitbucket_token, login, gigacode_path FROM settings WHERE id = 1",
      )
      .get();
    return (row as Record<string, unknown> | undefined) ?? null;
  } finally {
    database.close();
  }
};

/** Every live process running the plugin's shipped script, asked of the OS. Never `pkill`. */
const liveScriptPids = (): ReadonlyArray<number> => {
  const found = NodeChildProcess.spawnSync("pgrep", ["-af", "assets/script/auto-coder[.]js"], {
    encoding: "utf8",
  });
  return (found.stdout ?? "")
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row) => Number.parseInt(row.trim().split(" ")[0] ?? "", 10))
    .filter((pid) => Number.isFinite(pid));
};

/**
 * S71 F2 — an OBSERVER on `WebSocket.prototype.send`, the mechanism `invokeReadiness.e2e.test.ts`
 * (b) uses: the FIRST `run.output` fetch is WRITTEN, then the socket that carried it is closed —
 * what a dropped network does to a request whose answer has not come back yet. It never swallows
 * or fails a write.
 */
const DROP_UNDER_RUN_OUTPUT = `
globalThis.__acDrop = { armed: true, closedUnder: 0, fetches: 0, sockets: 0, socketsAfterDrop: 0 };
const WS = globalThis.WebSocket;
const nativeSend = WS.prototype.send;
const seen = new WeakSet();
WS.prototype.send = function (data) {
  const text = typeof data === "string" ? data : "";
  if (!seen.has(this)) {
    seen.add(this);
    globalThis.__acDrop.sockets += 1;
    if (globalThis.__acDrop.closedUnder > 0) globalThis.__acDrop.socketsAfterDrop += 1;
  }
  const result = nativeSend.call(this, data);
  if (/"tag":"plugin\\.invoke"/.test(text) && /"method":"run\\.output"/.test(text)) {
    globalThis.__acDrop.fetches += 1;
    if (globalThis.__acDrop.armed) {
      globalThis.__acDrop.armed = false;
      globalThis.__acDrop.closedUnder += 1;
      this.close(4000, "e2e: the connection dropped under the run.output fetch");
    }
  }
  return result;
};
`;

interface DropWire {
  readonly closedUnder: number;
  readonly fetches: number;
  readonly sockets: number;
  readonly socketsAfterDrop: number;
}
const dropWire = (page: Page): Promise<DropWire> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __acDrop?: DropWire }).__acDrop ?? {
        closedUnder: 0,
        fetches: 0,
        sockets: 0,
        socketsAfterDrop: 0,
      },
  );

/**
 * Open the app, wait out the environment connection, then open THIS panel.
 *
 * The connection predicate in `fixtures.ts` is the DEMO plugin's status line, which needs a demo
 * surface on screen — so the demo panel is opened for it and closed again. It is the same fact
 * either way (`ctx.connection`, one host signal for every plugin), and the global right slot is
 * mutually exclusive, so the demo panel has to go before this one arrives.
 */
const openAutoCoder = async (page: Page): Promise<void> => {
  const button = page.getByRole("button", { name: PANEL_LABEL }).first();
  await expect(button, "the plugin's footer entry is on the rail").toBeVisible({ timeout: 30_000 });
  const clicked = await button
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await button.dispatchEvent("click");
  await expect(page.getByRole("heading", { name: PANEL_LABEL })).toBeVisible({ timeout: 30_000 });
};

test.describe("plugins — the auto-coder panel in the app", () => {
  // One real spawn, one real stop, plus the app's own cold open.
  test.setTimeout(240_000);

  test("opens from the nav entry, on the app's own project, and its gear saves", async ({
    page,
  }) => {
    await openAppWithDemo(page);
    await openDemoPanel(page);
    await closeDemoPanel(page);
    await openAutoCoder(page);

    const view = panel(page);

    // (1) the header the catalogs panels have: a title and TWO action icons.
    await expect(view.getByRole("button", { name: SETTINGS_LABEL })).toBeVisible();
    await expect(view.getByRole("button", { name: CLOSE_LABEL })).toBeVisible();

    // (2) the project line, and the project it names is the APP's own. `repoSlug` defaults to the
    // BASENAME OF THE PROJECT'S CWD (`defaults.ts:49`), so a filled Repository field is the panel
    // reading a real project out of `ctx.projects` rather than showing an empty form.
    await expect(view.locator('[data-testid="ac-project-select"]')).toBeVisible({
      timeout: 30_000,
    });
    const selectText = (await view.locator('[data-testid="ac-project-select"]').innerText()).trim();
    expect(selectText, "the selector shows the app's active project").not.toBe("");
    await expect(view.getByLabel(REPOSITORY_LABEL)).not.toHaveValue("", { timeout: 30_000 });
    const repository = await view.getByLabel(REPOSITORY_LABEL).inputValue();

    // (3) the gear saves on blur, and the truth is the plugin's own SQLite.
    await view.getByRole("button", { name: SETTINGS_LABEL }).click();
    await view.getByLabel(JIRA_TOKEN_LABEL).fill("app-e2e-token");
    // The commit is the BLUR (V2-38): the host field above is inert, so another field takes it.
    await view.getByLabel(/^(Login|Логин)$/).click();
    await expect
      .poll(async () => (await readSettings())?.jira_token, { timeout: 30_000 })
      .toBe("app-e2e-token");

    await view.getByRole("button", { name: BACK_LABEL }).click();
    await expect(view.getByRole("tab", { name: PROJECT_TAB })).toBeVisible();

    saveEvidenceJson("38-auto-coder-app", {
      spec: "autoCoder.e2e.test.ts",
      harnessProjectCwd: state().projectCwd,
      repository,
      selector: selectText,
      dataDir: dataDir(),
    });
  });

  test("Start spawns the shipped script and its output reaches the pane; Stop ends it", async ({
    page,
  }) => {
    await openAppWithDemo(page);
    await openDemoPanel(page);
    await closeDemoPanel(page);
    await openAutoCoder(page);

    const view = panel(page);
    await expect(view.getByLabel(REPOSITORY_LABEL)).not.toHaveValue("", { timeout: 30_000 });
    const repository = await view.getByLabel(REPOSITORY_LABEL).inputValue();

    await view.getByRole("tab", { name: RUN_TAB }).click();
    const toggle = view.locator('[data-testid="ac-run-toggle"]');
    await expect(toggle, "ONE button, and it offers Start").toHaveText(START_LABEL, {
      timeout: 30_000,
    });
    await toggle.click();
    await expect(toggle, "…and the same button now offers Stop").toHaveText(STOP_LABEL, {
      timeout: 30_000,
    });

    // The two files the script reads, written into the plugin's own data dir.
    const projectsRoot = NodePath.join(dataDir(), "projects");
    await expect
      .poll(
        () =>
          (NodeFS.existsSync(projectsRoot) ? NodeFS.readdirSync(projectsRoot) : []).filter(
            (entry) => NodeFS.existsSync(NodePath.join(projectsRoot, entry, ".env")),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const runDir = NodePath.join(
      projectsRoot,
      NodeFS.readdirSync(projectsRoot).find((entry) =>
        NodeFS.existsSync(NodePath.join(projectsRoot, entry, ".env")),
      ) ?? "",
    );
    const envText = NodeFS.readFileSync(NodePath.join(runDir, ".env"), "utf8");
    // The token the PREVIOUS spec typed into the gear, and the repository tab 1 is showing: the
    // file the process reads is written from the same two places the user edited.
    expect(envText).toContain("JIRA_TOKEN=app-e2e-token");
    expect(envText).toContain(`ASSIGNED_REPO_SLUG=${repository}`);
    expect(NodeFS.existsSync(NodePath.join(runDir, "local-repos.json"))).toBe(true);

    // The script's own stdout: the two dumps, then a heartbeat a second.
    const output = view.locator('[data-testid="ac-run-output"]');
    await expect(output).toContainText("=== .env ===", { timeout: 30_000 });
    await expect(output).toContainText("=== local-repos.json ===", { timeout: 30_000 });
    await expect(output).toContainText("heartbeat #1", { timeout: 30_000 });

    // Stop, and the process group is gone from the machine.
    await toggle.click();
    await expect(toggle, "the one button offers Start again").toHaveText(START_LABEL, {
      timeout: 30_000,
    });
    await expect.poll(() => liveScriptPids().length, { timeout: 30_000 }).toBe(0);

    // (5) and the header's ✕ closes the panel.
    await view.getByRole("button", { name: CLOSE_LABEL }).click();
    await expect(page.getByRole("heading", { name: PANEL_LABEL })).toHaveCount(0, {
      timeout: 30_000,
    });

    saveEvidenceJson("38-auto-coder-app-run", {
      spec: "autoCoder.e2e.test.ts",
      runDir,
      livePidsAfterStop: liveScriptPids(),
    });
  });

  // S71 F1 — the owner's rule (a): the button follows the SERVER's run state only. A server that
  // restarted gracefully (`deactivate` killed the group and wrote `stopped`) runs nothing, and its
  // published summary says so by holding no run for the project. A tab that was away for the
  // restart (the socket was down: a laptop lid, a network blip) must offer Start when it is back.
  test("a server restart while the tab is away: the button follows the restarted server (S71 F1)", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // Every `plugin.state` snapshot this page receives, per socket: the proof that the tab came
    // back to the RESTARTED server, and what that server's published run summary said.
    let restarted = false;
    const snapshotsAfterRestart: Array<string> = [];
    page.on("websocket", (socket) => {
      const opened = restarted;
      socket.on("framereceived", (frame) => {
        const payload = typeof frame.payload === "string" ? frame.payload : "";
        if (opened && payload.includes('"_tag":"snapshot"')) snapshotsAfterRestart.push(payload);
      });
    });
    await openAppWithDemo(page);
    await openDemoPanel(page);
    await closeDemoPanel(page);
    await openAutoCoder(page);

    const view = panel(page);
    await view.getByRole("tab", { name: RUN_TAB }).click();
    const toggle = view.locator('[data-testid="ac-run-toggle"]');
    await expect(toggle).toHaveText(START_LABEL, { timeout: 30_000 });
    await toggle.click();
    await expect(toggle).toHaveText(STOP_LABEL, { timeout: 30_000 });
    await expect(view.locator('[data-testid="ac-run-output"]')).toContainText("heartbeat #1", {
      timeout: 30_000,
    });

    // The tab goes away, the server restarts gracefully (SIGTERM → the host's scope → the
    // plugin's `deactivate`, which kills the group), and the tab comes back.
    await page.context().setOffline(true);
    try {
      await stopPluginsApp(state());
      await expect
        .poll(() => liveScriptPids().length, { timeout: 30_000, message: "deactivate killed it" })
        .toBe(0);
      await restartPluginsApp(state());
      restarted = true;
    } finally {
      await page.context().setOffline(false);
    }
    // The tab is back on the restarted server: its state stream re-opened and took the snapshot.
    await expect.poll(() => snapshotsAfterRestart.length, { timeout: 90_000 }).toBeGreaterThan(0);
    const summary = /"name":"run\.output","value":(\{[^]*?\})\}/.exec(
      snapshotsAfterRestart[0] ?? "",
    )?.[1];
    saveEvidenceJson("71-auto-coder-restart-while-away", {
      spec: "autoCoder.e2e.test.ts",
      runOutputAfterRestart: summary ?? null,
      button: await toggle.innerText(),
    });

    await expect(
      toggle,
      "nothing runs on the restarted server: the button offers Start",
    ).toHaveText(START_LABEL, { timeout: 90_000 });
  });

  // S71 F2 — the owner's rule (b): the pane fetches the lines after its cursor. A fetch the socket
  // drops under is rejected (`transport`, V2-35) and never re-sent; the run is over, so the
  // published summary will not move again. When the connection is back the pane must still
  // catch up — before S69 the Run tab read once on every edge back into `ready`.
  test("a run.output fetch the socket drops under is made again when the connection is back (S71 F2)", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await openAppWithDemo(page);
    await openDemoPanel(page);
    await closeDemoPanel(page);
    await openAutoCoder(page);

    const view = panel(page);
    await view.getByRole("tab", { name: RUN_TAB }).click();
    const toggle = view.locator('[data-testid="ac-run-toggle"]');
    await expect(toggle).toHaveText(START_LABEL, { timeout: 30_000 });
    await toggle.click();
    await expect(toggle).toHaveText(STOP_LABEL, { timeout: 30_000 });
    await expect(view.locator('[data-testid="ac-run-output"]')).toContainText("heartbeat #1", {
      timeout: 30_000,
    });
    await toggle.click();
    await expect(toggle).toHaveText(START_LABEL, { timeout: 30_000 });
    await expect.poll(() => liveScriptPids().length, { timeout: 30_000 }).toBe(0);

    // A fresh page over the SAME server: the run is over, its summary stands still, and the Run
    // tab's first fetch of that history is the one the socket is closed under.
    await page.addInitScript(DROP_UNDER_RUN_OUTPUT);
    await openAppWithDemo(page);
    await openDemoPanel(page);
    await closeDemoPanel(page);
    await openAutoCoder(page);
    const again = panel(page);
    await again.getByRole("tab", { name: RUN_TAB }).click();
    await expect.poll(async () => (await dropWire(page)).closedUnder, { timeout: 30_000 }).toBe(1);
    // The app reconnects by itself: a frame goes out on a NEW socket (the resubscribes).
    await expect
      .poll(async () => (await dropWire(page)).socketsAfterDrop, { timeout: 60_000 })
      .toBeGreaterThan(0);

    // The pane must then hold the run it was fetching.
    await expect(
      again.locator('[data-testid="ac-run-output"]'),
      "the history the dropped fetch was bringing",
    ).toContainText("heartbeat #1", { timeout: 60_000 });
    saveEvidenceJson("71-auto-coder-drop-under-run-output", {
      spec: "autoCoder.e2e.test.ts",
      wire: await dropWire(page),
    });
  });
});
