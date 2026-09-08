// ru-code: E2E HARNESS — the PLUGINS suite's own boot (globalSetup for playwright.plugins.config.ts).
//
// It is a sibling of `scripts/bootApp.ts`, not a variant of it, for three reasons the pixso suite
// already established (its own config, its own testDir, its own artifacts dir):
//
//  1. **It builds nothing.** D9 is "build packages → copy dist → build the app → run dist", and the
//     ONE full build of this stage happens before the suite is started, deliberately. So this setup
//     ASSERTS `apps/server/dist/bin.mjs` and `apps/web/dist/index.html` exist and fails fast with the
//     command to run when they do not — instead of silently rebuilding for ~60 s per run and turning
//     a three-run flake budget into a five-minute one.
//  2. **The plugins directory must be seeded BEFORE the server starts.** `PluginHost.start` scans
//     once at boot (hot re-scan is backlog), so a plugin copied after the spawn does not exist for
//     that process. There is no "seed a fixture" hook in the shared boot for that.
//  3. **It seeds three plugins on purpose**: the real `demo` (from the package's `dist/`, i.e. the
//     artifact a user copies), the `demo-broken` fixture that throws in its SERVER `activate`, and a
//     generated `hang` plugin whose WEB `activate` never settles. Those three are the isolation
//     matrix (mvp-plan guardrail 8) and every other suite must never pay for them.
//
// The plugins directory is NOT pointed at by `RU_CODE_PLUGINS_DIR`: `paths.ts` derives
// `<baseDir>/plugins` from `--base-dir`, so seeding `<tmp>/base/plugins/<id>` and passing
// `--base-dir <tmp>/base` exercises the PRODUCTION path resolution rather than the test-only
// override. The plugin's data lands at `<tmp>/base/userdata/plugins/<id>/data.sqlite` (D2), which is
// also what the uninstall spec reads back to prove D11.
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalConsole:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { RU_CODE_TMP_ROOT } from "./primitives.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");

/** Own artifacts root (`.artifacts-*` is gitignored) — never the core suite's `.artifacts/`. */
export const PLUGINS_ARTIFACTS_DIR = NodePath.join(import.meta.dirname, "../.artifacts-plugins");
export const PLUGINS_STATE_FILE = NodePath.join(PLUGINS_ARTIFACTS_DIR, "harness-state.json");
export const PLUGINS_AUTH_FILE = NodePath.join(PLUGINS_ARTIFACTS_DIR, "auth.json");

const BUILT_SERVER_ENTRY = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const BUILT_WEB_INDEX = NodePath.join(REPO_ROOT, "apps/web/dist/index.html");
const FAKE_ACP_ENTRY = NodePath.join(
  REPO_ROOT,
  "apps/server/src/ru-code/tests/qwen/fake-acp/fake-acp-server.ts",
);

/**
 * The demo plugin's build output, reached through the untracked `ru-code-packages` symlink — the
 * same dependency the pixso suite already takes on it (`harness/fakePixsoMcp.ts`). `dist/` IS the
 * drop-in folder (D4): this suite copies it exactly as `scripts/install-local.mjs` would.
 */
export const DEMO_PLUGIN_DIST = NodePath.join(
  REPO_ROOT,
  "ru-code-packages/packages/plugin-demo/dist",
);
/** The throwing fixture that ships beside the demo package, never installed by its installer. */
export const DEMO_BROKEN_FIXTURE = NodePath.join(
  REPO_ROOT,
  "ru-code-packages/packages/plugin-demo/fixtures/demo-broken",
);

/** Plugin ids this suite seeds. The specs import these rather than spelling them again. */
export const DEMO_ID = "demo";
export const DEMO_BROKEN_ID = "demo-broken";
export const DEMO_HANG_ID = "demo-hang";
/**
 * A13 (A12 findings R1-H1 / R1-H2): a plugin whose panel React throws.
 *
 * NOT seeded at boot — `renderFaults.e2e.test.ts` installs it, restarts, asserts, removes it and
 * restarts again. It has to be that way round twice over: the host scans the plugins directory once
 * per process, and every other spec counts console errors and footer icons, so a permanently
 * installed fault fixture would move six specs' expectations for one spec's benefit.
 */
export const DEMO_FAULTY_ID = "demo-faulty";

/**
 * A13 round 3 (A12 finding R3-H4): a plugin that FLOODS the host with registrations.
 *
 * 300 malformed calls per surface plus 1000 well-formed ones. Installed and removed by
 * `renderFaults.e2e.test.ts` in the same window as the faulty fixture, and kept a SEPARATE plugin
 * on purpose: its 1000 valid panels would otherwise spend the faulty plugin's 4-panel cap and its
 * three fault panels would never be registered.
 */
export const DEMO_FLOOD_ID = "demo-flood";

/**
 * A13 round 3 (A12 findings R3-H1 / R3-H2): a plugin whose React SUSPENDS rather than throws.
 *
 * Its own plugin, not another panel on `demo-faulty`: a fault is reported once per plugin per
 * surface, so a hanging ICON beside a throwing ICON would be de-duplicated into one report.
 */
export const DEMO_SUSPEND_ID = "demo-suspend";

/**
 * A18 finding H2: a plugin whose STYLESHEET restyles the app.
 *
 * The defect it reproduces is not hypothetical — it is what the real analytics plugin did. Its
 * Tailwind sheet shipped an unscoped `.hidden{display:none}`, the loader appended the `<link>`
 * AFTER the app's own stylesheet, and on equal specificity source order handed the fight to the
 * plugin: `[data-slot="sidebar"]` computed `display:none` and the app lost its whole footer nav —
 * including the button that opens the plugin's own panel.
 *
 * The fixture is HAND-WRITTEN, unlayered CSS on purpose. The SDK's half of the fix (utilities in
 * `@layer plugin`) does not apply to a plugin that ships plain CSS, so this fixture can only be
 * held by the HOST's half: the `<link>` goes before the app's sheet.
 *
 * Installed and removed by `styles.e2e.test.ts`, never seeded at boot — every other spec counts
 * footer icons, manifests and statuses.
 */
export const DEMO_CSS_ID = "demo-css";

/** `PLUGIN_LOAD_TIMEOUT_MS` in `apps/web/src/ru-code/plugins/loadPlugins.ts` — the hang's budget. */
export const PLUGIN_LOAD_TIMEOUT_MS = 10_000;

const BOOT_TIMEOUT_MS = 180_000;

export interface PluginsHarnessState {
  readonly webUrl: string;
  readonly port: number;
  readonly runnerPid: number;
  readonly tmpRoot: string;
  /** `--base-dir`; `plugins/` and `userdata/` hang off it. */
  readonly baseDir: string;
  /** `<baseDir>/plugins` — where a plugin FOLDER is dropped in. */
  readonly pluginsDir: string;
  /** `<baseDir>/userdata` — where the app's `state.sqlite` and `plugins/<id>/data.sqlite` live. */
  readonly stateDir: string;
  readonly homeDir: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
  readonly projectCwd: string;
}

export const readPluginsHarnessState = (): PluginsHarnessState =>
  JSON.parse(NodeFS.readFileSync(PLUGINS_STATE_FILE, "utf8")) as PluginsHarnessState;

/**
 * The generated `hang` plugin: a web half whose `activate()` returns a promise that never settles.
 *
 * Generated rather than committed because its whole content is four lines and the point is that it
 * is broken in a way no build would ever emit — the same argument the `demo-broken` fixture's own
 * header makes. It has no server half on purpose: the server must report it `loaded`
 * (`hasServer: false`, nothing to run) while the BROWSER is the half that times out, which is what
 * separates spec 1's server-side view from spec 6's user-visible one.
 */
const HANG_PLUGIN_MANIFEST = {
  id: DEMO_HANG_ID,
  name: "Demo (hang)",
  version: "0.1.0",
  apiVersion: 1,
  web: "web/index.mjs",
  contributes: { panel: true },
};
const HANG_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): activate() NEVER settles.
export default {
  activate() {
    return new Promise(() => {});
  },
};
`;

/** Copy one plugin folder into the plugins dir, replacing whatever was there (install-local's posture). */
export function installPluginFolder(pluginsDir: string, id: string, sourceDir: string): void {
  const target = NodePath.join(pluginsDir, id);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(pluginsDir, { recursive: true });
  NodeFS.cpSync(sourceDir, target, { recursive: true });
}

/** Delete a plugin folder — the uninstall half of the drop-in contract (D11 keeps its data). */
export function removePluginFolder(pluginsDir: string, id: string): void {
  NodeFS.rmSync(NodePath.join(pluginsDir, id), { recursive: true, force: true });
}

/**
 * The generated `faulty` plugin: two panels, one whose ICON throws and one whose RENDER throws.
 *
 * The auditor's two HIGH fixtures, verbatim in spirit and four lines each. Before A13 the first of
 * them replaced the entire SPA with the app's crash card on EVERY page load — with no UI left to
 * uninstall the plugin from — and the second did the same on the first click of its footer icon.
 * Generated rather than committed for the same reason `demo-broken` and `demo-hang` are: no build
 * would ever emit this, and its whole content is the fault.
 */
const FAULTY_PLUGIN_MANIFEST = {
  id: DEMO_FAULTY_ID,
  name: "Demo (faulty)",
  version: "0.1.0",
  apiVersion: 1,
  web: "web/index.mjs",
  contributes: { panel: true },
};
const FAULTY_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): plugin React that throws.
// \`lucide-react\` by name: host-provided (D13), so the SECOND panel has a REAL icon and the spec's
// "the button is visible" assertion is about the button, not about an empty box.
import { BugIcon } from "lucide-react";
import { createElement, useEffect } from "react";

function BoomOnUnmount() {
  useEffect(() => () => {
    throw new Error("A12 panel unmount boom");
  }, []);
  return createElement("div", { "data-t": "panelunmount" }, "body");
}

export default {
  activate(host) {
    host.registerPanel({
      id: "icon",
      label: "Boom icon",
      icon: () => {
        throw new Error("A12 icon boom");
      },
      render: () => null,
    });
    host.registerPanel({
      id: "render",
      label: "Boom render",
      icon: BugIcon,
      render: () => {
        throw new Error("A12 panel render boom");
      },
    });
    // A12 round 2 (R2-H1): a body whose effect CLEANUP throws. It renders and opens fine; the
    // fault is raised by CLOSING the panel, in the commit that removes the subtree — which is
    // exactly the commit that destroys every boundary inside it.
    host.registerPanel({
      id: "unmount",
      label: "Boom unmount",
      icon: BugIcon,
      render: () => createElement(BoomOnUnmount, {}),
    });
  },
};
`;

const SUSPEND_PLUGIN_MANIFEST = {
  id: DEMO_SUSPEND_ID,
  name: "Demo (suspend)",
  version: "0.1.0",
  apiVersion: 1,
  web: "web/index.mjs",
  contributes: { panel: true },
};

/**
 * The auditor's `iconlazyhang` and `rp1` fixtures (R3-H1 / R3-H2), plus the control.
 *
 * A SEPARATE plugin from `demo-faulty`: a render fault is reported once per plugin per SURFACE, so
 * a hanging icon in the same plugin as a THROWING icon would be de-duplicated away and the spec
 * could not tell the two apart.
 */
const SUSPEND_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): React that SUSPENDS.
import { CheckIcon } from "lucide-react";
import { lazy } from "react";

// A lazy component is exactly the exotic-object shape the round-2 field check was widened to
// admit, and a loader that never settles is one line. BEFORE: a pure white viewport at boot, with
// no crash card, no toast, no console line and no page error.
const LazyHang = lazy(() => new Promise(() => {}));
// The control: a lazy icon that DOES resolve, after 3 s. It must end up showing the real glyph.
const LazyLate = lazy(
  () => new Promise((resolve) => setTimeout(() => resolve({ default: CheckIcon }), 3000)),
);

export default {
  activate(host) {
    host.registerPanel({ id: "hang", label: "Hang icon", icon: LazyHang, render: () => null });
    host.registerPanel({ id: "late", label: "Late icon", icon: LazyLate, render: () => null });
    // R3-H2: a render that returns a PENDING promise. React 19 renders a thenable child by
    // awaiting it, so this blanked the app on the click that opened the panel — and stayed blank
    // after the panel was closed, because React hides suspended content rather than unmounting it.
    host.registerPanel({
      id: "promise",
      label: "Promise render",
      icon: CheckIcon,
      render: () => new Promise(() => {}),
    });
  },
};
`;

/** Write the generated `suspend` plugin into the plugins dir. */
export function installSuspendPlugin(pluginsDir: string): void {
  const target = NodePath.join(pluginsDir, DEMO_SUSPEND_ID);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(target, "web"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "plugin.json"),
    `${JSON.stringify(SUSPEND_PLUGIN_MANIFEST, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(target, "web", "index.mjs"), SUSPEND_PLUGIN_WEB_ENTRY);
}

const FLOOD_PLUGIN_MANIFEST = {
  id: DEMO_FLOOD_ID,
  name: "Demo (flood)",
  version: "0.1.0",
  apiVersion: 1,
  web: "web/index.mjs",
  contributes: { panel: true },
};

/**
 * The auditor's `badflood` fixture (R3-H4), with the R1-M5 flood beside it for contrast.
 *
 * BEFORE: the 300 malformed calls produced 600 toasts — the composer never appeared inside 60 s,
 * `page.evaluate("1+1")` timed out at 20 s and `page.screenshot` timed out twice at 25 s. The
 * 1000 WELL-FORMED registrations in the same file were handled in 1865 ms, which is what makes the
 * first number a regression rather than a fact of life.
 */
const FLOOD_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): a registration flood.
import { BugIcon } from "lucide-react";

export default {
  activate(host) {
    // Four WELL-FORMED panels first, so the spec can prove the plugin's good half survives its
    // own flood — and that the ceiling ignores what comes after, not what came before.
    for (let i = 0; i < 4; i++) {
      host.registerPanel({
        id: "ok" + i,
        label: "Flood " + i,
        icon: BugIcon,
        render: () => null,
      });
    }
    // The auditor's \`badflood\`, verbatim: 300 malformed calls per surface.
    for (let i = 0; i < 300; i++) {
      host.registerPanel({ id: "b" + i, label: { o: i }, icon: () => null, render: () => null });
    }
    for (let i = 0; i < 300; i++) {
      host.composer.registerItem({ trigger: "command", name: "b" + i, label: 42, prompt: "x" });
    }
    // …and 1000 more well-formed ones, every one of them past the ceiling: ignored SILENTLY.
    for (let i = 0; i < 1000; i++) {
      host.registerPanel({
        id: "late" + i,
        label: "Late " + i,
        icon: BugIcon,
        render: () => null,
      });
    }
  },
};
`;

/** Write the generated `flood` plugin into the plugins dir. */
export function installFloodPlugin(pluginsDir: string): void {
  const target = NodePath.join(pluginsDir, DEMO_FLOOD_ID);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(target, "web"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "plugin.json"),
    `${JSON.stringify(FLOOD_PLUGIN_MANIFEST, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(target, "web", "index.mjs"), FLOOD_PLUGIN_WEB_ENTRY);
}

/** Write the generated `faulty` plugin into the plugins dir. */
export function installFaultyPlugin(pluginsDir: string): void {
  const target = NodePath.join(pluginsDir, DEMO_FAULTY_ID);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(target, "web"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "plugin.json"),
    `${JSON.stringify(FAULTY_PLUGIN_MANIFEST, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(target, "web", "index.mjs"), FAULTY_PLUGIN_WEB_ENTRY);
}

const CSS_PLUGIN_MANIFEST = {
  id: DEMO_CSS_ID,
  name: "Demo (css)",
  version: "0.1.0",
  apiVersion: 1,
  web: "web/index.mjs",
  styles: "web/styles.css",
  contributes: {},
};

/** A web half that does nothing: the stylesheet is the whole fixture. */
const CSS_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): a plugin whose STYLESHEET is the payload.
export default {
  activate() {},
};
`;

/**
 * The rules A18 measured in `packages/plugin-analytics/dist/web/styles.css` (evidence
 * `71-H2-css-leak.txt`), in the SHAPE that sheet had: Tailwind's own `@layer utilities`, which is
 * the same layer name the APP's Tailwind uses.
 *
 * The layer is the whole point and it is not a detail. Cascade layers beat source order, and
 * UNLAYERED declarations beat every layered one — so a plugin that ships plain, unlayered CSS wins
 * against the app's layered utilities no matter where its `<link>` sits, and no host can order
 * that away (the answer for hand-written plugin CSS is, and remains, "prefix your selectors").
 * What broke the app was not that: it was a Tailwind-built plugin sheet landing in the app's OWN
 * `utilities` layer, where the only tie-breaker left is source order — and the loader was
 * appending. This fixture is that sheet, so the ordering fix is what has to hold it.
 *
 * The declaration line comes first, exactly as Tailwind emits it, so the plugin's sheet does not
 * accidentally re-order the app's own layers by being the first to name one of them.
 */
const CSS_PLUGIN_STYLESHEET = `/* e2e fixture (generated by harness/pluginsBoot.ts) — A18 finding H2. */
@layer theme, base, components, utilities;
@layer utilities {
  .hidden { display: none }
  .block { display: block }
  .flex { display: flex }
  .grid { display: grid }
  .inline-flex { display: inline-flex }
  .table { display: table }
  @media (width >= 48rem) {
    .md\\:block { display: none }
    .md\\:flex { display: none }
  }
}
/* The plugin's own rule, on a class the app does not define. */
.ru-demo-css-probe { color: rgb(1, 2, 3) }
`;

/** Write the generated `css` plugin into the plugins dir. */
export function installCssLeakPlugin(pluginsDir: string): void {
  const target = NodePath.join(pluginsDir, DEMO_CSS_ID);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(target, "web"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "plugin.json"),
    `${JSON.stringify(CSS_PLUGIN_MANIFEST, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(target, "web", "index.mjs"), CSS_PLUGIN_WEB_ENTRY);
  NodeFS.writeFileSync(NodePath.join(target, "web", "styles.css"), CSS_PLUGIN_STYLESHEET);
}

/** Write the generated `hang` plugin into the plugins dir. */
export function installHangPlugin(pluginsDir: string): void {
  const target = NodePath.join(pluginsDir, DEMO_HANG_ID);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(target, "web"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "plugin.json"),
    `${JSON.stringify(HANG_PLUGIN_MANIFEST, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(target, "web", "index.mjs"), HANG_PLUGIN_WEB_ENTRY);
}

/**
 * The build gate. D9 says the app is built before anything is run, and this suite deliberately does
 * NOT build — so a missing artifact must read as an instruction, not as a boot timeout four minutes
 * later.
 */
function assertBuiltAppExists(): void {
  const missing = [BUILT_SERVER_ENTRY, BUILT_WEB_INDEX].filter((file) => !NodeFS.existsSync(file));
  if (missing.length === 0) return;
  throw new Error(
    `[plugins-e2e] the built app is missing:\n` +
      missing.map((file) => `  - ${file}\n`).join("") +
      `[plugins-e2e] this suite runs the BUILT app and never builds it (mvp-plan D9).\n` +
      `[plugins-e2e] run: pnpm build   (from ${REPO_ROOT})`,
  );
}

/** Same posture for the demo: its `dist/` is the drop-in folder, and it is built by its own package. */
function assertDemoDistExists(): void {
  const entry = NodePath.join(DEMO_PLUGIN_DIST, "plugin.json");
  if (NodeFS.existsSync(entry)) return;
  throw new Error(
    `[plugins-e2e] no demo plugin build output at ${DEMO_PLUGIN_DIST}\n` +
      `[plugins-e2e] it is reached through the untracked \`ru-code-packages\` symlink (as the pixso suite does).\n` +
      `[plugins-e2e] run, in the ru-code-packages worktree: pnpm --filter @smart-tools/plugin-demo build`,
  );
}

/** Reserve a free loopback port by binding one and reading it back (bootApp.ts's helper). */
async function reserveFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not reserve a port for the app")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

const envFor = (state: {
  readonly homeDir: string;
  readonly t3Home: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
}): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: state.homeDir,
  T3CODE_HOME: state.t3Home,
  RU_CODE_CLI_JS: FAKE_ACP_ENTRY,
  RU_CODE_FAKE_ACP: "FLOW",
  RU_CODE_FAKE_CONTROL_FILE: state.controlFile,
  RU_CODE_FAKE_CLI_CONFIG_DIR: state.cliConfigDir,
  RU_CODE_FAKE_LOG_FILE: NodePath.join(PLUGINS_ARTIFACTS_DIR, "fake-acp.log"),
  RU_CODE_CREATE_STARTER_PROJECT: "1",
  T3CODE_NO_BROWSER: "1",
  T3CODE_LOG_LEVEL: "Debug",
  RU_CODE_WARM_ENGINE: "0",
  TZ: "UTC",
});

/**
 * Spawn the BUILT server on `port` against `baseDir` and wait until it serves HTML.
 *
 * Detached, exactly like `scripts/bootApp.ts`: the harness owns the child's lifetime, teardown
 * signals its whole process group, and the fake CLI children it spawns go with it.
 */
async function spawnServer(input: {
  readonly port: number;
  readonly baseDir: string;
  readonly tmpRoot: string;
  readonly homeDir: string;
  readonly t3Home: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
  readonly projectCwd: string;
  readonly logName: string;
}): Promise<number> {
  const logPath = NodePath.join(PLUGINS_ARTIFACTS_DIR, input.logName);
  const logFd = NodeFS.openSync(logPath, "w");
  const runner = NodeChildProcess.spawn(
    "node",
    [
      BUILT_SERVER_ENTRY,
      "start",
      "--foreground",
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      "--port",
      String(input.port),
      "--base-dir",
      input.baseDir,
    ],
    {
      cwd: input.projectCwd,
      env: envFor(input),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );

  const url = `http://localhost:${String(input.port)}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const served = await fetch(url)
      .then((response) => response.ok)
      .catch(() => false);
    if (served) break;
    if (runner.exitCode !== null) {
      throw new Error(
        `[plugins-e2e] the app exited (${String(runner.exitCode)}) before serving — see ${logPath}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`[plugins-e2e] the app at ${url} never became ready — see ${logPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  runner.unref();
  return runner.pid ?? -1;
}

/**
 * Capture the authenticated storage state the specs restore.
 *
 * Copied from `scripts/bootApp.ts` because it is the acceptance the core suite already pins: a
 * loopback server auto-authenticates a fresh browser (`tests-core/localAutoAuth.e2e.test.ts`), and
 * what the snapshot is really for is the ENVIRONMENT REGISTRATION in IndexedDB — without
 * `indexedDB: true` every spec pairs fine and then fails every env RPC with «нет подключения».
 *
 * The composer being on screen is the predicate, not a sleep: it is the app's own signal that the
 * SPA booted AND its environment connection came up.
 */
async function captureAuthState(webUrl: string): Promise<void> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      const navigated = await page
        .goto(webUrl, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (navigated) break;
      if (Date.now() > deadline) {
        throw new Error(`[plugins-e2e] the app never served ${webUrl}`);
      }
    }
    await page
      .locator("div[contenteditable=true]")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await context.storageState({ path: PLUGINS_AUTH_FILE, indexedDB: true });
    // Same isolation strip as the core harness: the boot page's persisted composer draft would
    // otherwise be restored into every spec context and redirect them into one shared thread.
    const snapshot = JSON.parse(NodeFS.readFileSync(PLUGINS_AUTH_FILE, "utf8")) as {
      origins?: Array<{ localStorage?: Array<{ name: string }> }>;
    };
    for (const origin of snapshot.origins ?? []) {
      const entries = origin.localStorage;
      if (entries === undefined) continue;
      origin.localStorage = entries.filter(
        (entry) =>
          entry.name !== "ruCode:composer-drafts:v1" && entry.name !== "ruCode:browser-history:v1",
      );
    }
    NodeFS.writeFileSync(PLUGINS_AUTH_FILE, JSON.stringify(snapshot, null, 2));
  } finally {
    await browser.close();
  }
}

/**
 * SIGKILL a pid's process group, but only after `ps` confirms the pid still carries `needle` in its
 * argv — pids are recycled, and a state file that outlived its run must never signal a stranger.
 * Lifted verbatim in spirit from `scripts/bootApp.ts:killIfStillOurs`.
 */
export function killIfStillOurs(pid: number, needle: string): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const args = NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!args.includes(needle)) return;
  } catch (error: unknown) {
    // `status` is set when `ps` RAN and said "no such process"; anything else (no `ps` at all)
    // leaves it undefined and the kill goes ahead.
    if (typeof (error as { status?: unknown }).status === "number") return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** True once nothing is listening on `port` — the proof a stopped server really let go. */
async function isPortFree(port: number): Promise<boolean> {
  const net = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Stop the running app and wait for its port to come free.
 *
 * SIGTERM first (the server closes its database cleanly), SIGKILL after a grace window. Every kill
 * is identity-checked. The uninstall spec calls this, then deletes a plugin folder, then
 * {@link restartPluginsApp} — which is the ONLY way to prove the drop-in contract's second half,
 * because `PluginHost.start` scans once per process.
 */
export async function stopPluginsApp(state: PluginsHarnessState): Promise<void> {
  if (state.runnerPid > 0) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(-state.runnerPid, signal);
      } catch {
        break; // already gone
      }
      await new Promise((resolve) => setTimeout(resolve, signal === "SIGTERM" ? 2_000 : 0));
    }
  }
  killIfStillOurs(state.runnerPid, BUILT_SERVER_ENTRY);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await isPortFree(state.port)) return;
    if (Date.now() > deadline) {
      throw new Error(`[plugins-e2e] port ${String(state.port)} never came free after stop`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Restart the app on the SAME port and rewrite the state file.
 *
 * The port is reused deliberately: the saved `storageState` (cookies, localStorage AND the IndexedDB
 * environment registration) is bound to the origin `http://localhost:<port>`, so a restart on a new
 * port would silently hand every later page an unauthenticated, unregistered app.
 */
export async function restartPluginsApp(state: PluginsHarnessState): Promise<PluginsHarnessState> {
  const t3Home = NodePath.join(state.tmpRoot, "t3home");
  const runnerPid = await spawnServer({
    port: state.port,
    baseDir: state.baseDir,
    tmpRoot: state.tmpRoot,
    homeDir: state.homeDir,
    t3Home,
    cliConfigDir: state.cliConfigDir,
    controlFile: state.controlFile,
    projectCwd: state.projectCwd,
    logName: `app-boot-restart-${String(Date.now())}.log`,
  });
  const next: PluginsHarnessState = { ...state, runnerPid };
  NodeFS.writeFileSync(PLUGINS_STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

export default async function bootPluginsApp(): Promise<void> {
  NodeFS.mkdirSync(PLUGINS_ARTIFACTS_DIR, { recursive: true });

  // A state file that survived a previous run describes a process THIS run does not own. Reclaim it
  // before anything else — a leaked server would keep its base dir's databases open.
  try {
    const previous = readPluginsHarnessState();
    killIfStillOurs(previous.runnerPid, BUILT_SERVER_ENTRY);
    NodeFS.rmSync(PLUGINS_STATE_FILE, { force: true });
  } catch {
    // no previous run
  }

  assertBuiltAppExists();
  assertDemoDistExists();

  NodeFS.mkdirSync(RU_CODE_TMP_ROOT, { recursive: true });
  const tmpRoot = NodeFS.mkdtempSync(NodePath.join(RU_CODE_TMP_ROOT, "ru-code-e2e-plugins-"));
  const baseDir = NodePath.join(tmpRoot, "base");
  const pluginsDir = NodePath.join(baseDir, "plugins");
  const stateDir = NodePath.join(baseDir, "userdata");
  const homeDir = NodePath.join(tmpRoot, "home");
  const t3Home = NodePath.join(tmpRoot, "t3home");
  const cliConfigDir = NodePath.join(homeDir, ".qwen");
  const controlFile = NodePath.join(tmpRoot, "fake-control.json");
  NodeFS.mkdirSync(NodePath.join(cliConfigDir, "bin"), { recursive: true });
  NodeFS.mkdirSync(t3Home, { recursive: true });
  NodeFS.mkdirSync(pluginsDir, { recursive: true });
  // Detection stub only — never executed (RU_CODE_CLI_JS wins the spawn).
  NodeFS.writeFileSync(NodePath.join(cliConfigDir, "bin", "cli.js"), "// e2e detection stub\n");
  NodeFS.writeFileSync(controlFile, JSON.stringify({ delayMs: 0, historyTurns: 0 }));

  // ── the drop-in, BEFORE the server starts (PluginHost.start scans once) ──────────────────────
  installPluginFolder(pluginsDir, DEMO_ID, DEMO_PLUGIN_DIST);
  installPluginFolder(pluginsDir, DEMO_BROKEN_ID, DEMO_BROKEN_FIXTURE);
  installHangPlugin(pluginsDir);

  const projectCwd = REPO_ROOT;
  const port = await reserveFreePort();
  const webUrl = `http://localhost:${String(port)}`;
  const runnerPid = await spawnServer({
    port,
    baseDir,
    tmpRoot,
    homeDir,
    t3Home,
    cliConfigDir,
    controlFile,
    projectCwd,
    logName: "app-boot.log",
  });

  await captureAuthState(webUrl);

  const state: PluginsHarnessState = {
    webUrl,
    port,
    runnerPid,
    tmpRoot,
    baseDir,
    pluginsDir,
    stateDir,
    homeDir,
    cliConfigDir,
    controlFile,
    projectCwd,
  };
  NodeFS.writeFileSync(PLUGINS_STATE_FILE, JSON.stringify(state, null, 2));
  console.log(
    `[plugins-e2e] app ${webUrl} (pid ${String(runnerPid)}) with ${DEMO_ID} + ${DEMO_BROKEN_ID} + ${DEMO_HANG_ID} in ${pluginsDir}`,
  );
}
