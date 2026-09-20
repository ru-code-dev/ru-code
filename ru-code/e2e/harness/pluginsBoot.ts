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
 * drop-in folder (D4): this suite copies it exactly as `plugin-install-local` (S33 A10) would.
 */
export const DEMO_PLUGIN_DIST = NodePath.join(
  REPO_ROOT,
  "ru-code-packages/packages/plugin-demo/dist",
);
/** The one shipped plugin whose manifest ships it switched off (NEW `src/plugin.json`). */
export const AUTO_CODER_ID = "auto-coder";

/**
 * Optional real plugins (stage 2 ports). Each is seeded ONLY when its package has been built —
 * a missing `dist/` skips it silently, so the demo-only specs keep running while a port is in flight.
 */
export const OPTIONAL_PLUGIN_DISTS: ReadonlyArray<{ readonly id: string; readonly dir: string }> = [
  {
    id: "analytics",
    dir: NodePath.join(REPO_ROOT, "ru-code-packages/packages/plugin-analytics/dist"),
  },
  {
    id: "catalogs",
    dir: NodePath.join(REPO_ROOT, "ru-code-packages/packages/plugin-catalogs/dist"),
  },
  // S38 step 12.5: the auto-coder. Its `Start` spawns a REAL process (the placeholder script the
  // package ships), so `autoCoder.e2e.test.ts` stops every run it starts.
  //
  // S55: it lives in its OWN repository now, reached through the gitignored
  // `ru-code-plugin-auto-coder` symlink beside `ru-code-packages` (the name `shipped-plugins.json`
  // and `.gitignore` use) — the same mechanism, one directory up. Without the sibling checkout the
  // dist is missing and this entry is skipped silently, which is what "optional" means here.
  {
    id: AUTO_CODER_ID,
    dir: NodePath.join(REPO_ROOT, "ru-code-plugin-auto-coder/dist"),
  },
  // S44: the pixso assistant, ported in place. Seeding it here costs this suite nothing at boot —
  // its `activate` only adopts a pre-plugin store on disk and its MCP client is built lazily, on
  // the first rpc call, so with no fake desktop app running it is an inert panel. What it buys is
  // the host's heaviest real plugin (a ~1.8 MB server bundle carrying effect, the MCP SDK and
  // undici) present in every plugins-suite boot.
  {
    id: "pixso",
    dir: NodePath.join(
      REPO_ROOT,
      "ru-code-packages/packages/t3-code-pixso-mcp-assistant-plugin/dist",
    ),
  },
];

/** The throwing fixture that ships beside the demo package, never installed by its installer. */
export const DEMO_BROKEN_FIXTURE = NodePath.join(
  REPO_ROOT,
  "ru-code-packages/packages/plugin-demo/fixtures/demo-broken",
);

/** Plugin ids this suite seeds. The specs import these rather than spelling them again. */
export const DEMO_ID = "demo";
export const DEMO_BROKEN_ID = "demo-broken";
export const DEMO_HANG_ID = "demo-hang";
/** S15 B1: a plugin whose display name is nothing like its id, and whose web half can be broken. */
export const DEMO_NAMED_ID = "demo-named";
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
  /**
   * ru-code (V2-21): the SHIPPED plugins root, when a spec has staged one.
   *
   * Absent for every ordinary boot — the suite's plugins are drop-ins under `<baseDir>/plugins`,
   * which is the production path resolution this harness deliberately exercises. When present it
   * is passed as `RU_CODE_SHIPPED_PLUGINS_DIR`, the test-only override documented in `paths.ts`,
   * pointing at a payload-shaped `…/plugins/<id>` tree — the only way to put a release payload's
   * second root in front of the loader without building and installing a release.
   *
   * `shipped.e2e.test.ts` sets it, asserts against it and restores the app without it.
   */
  readonly shippedPluginsDir?: string;
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
  apiVersion: 2,
  web: "web/index.mjs",
};
const HANG_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): activate() NEVER settles.
//
// It exports a PANEL too, and that is the point: the host registers a plugin only once its
// \`activate\` has settled, so a plugin that hangs contributes nothing — the panel below must never
// reach the sidebar.
export default {
  panels: () => [{ id: "hang", title: "Hang", render: () => null }],
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
 * The harness's plugin switches (V2-43): `auto-coder` ships `"enabled": false` in its manifest, and
 * the harness turns it on the way a user does — `<stateDir>/plugins/disabled.json`'s `enabled` list,
 * which beats the manifest (`apps/server/src/ru-code/plugins/disabled.ts`). The seeded dist stays
 * byte-identical to the built one. A spec that rewrites or removes the file puts THIS back.
 */
export function writeHarnessPluginSwitches(stateDir: string): void {
  const file = NodePath.join(stateDir, "plugins", "disabled.json");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(
    file,
    `${JSON.stringify({ disabled: [], enabled: [AUTO_CODER_ID] }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Seed the optional real plugins (analytics, catalogs) as USER plugins — what every boot does.
 *
 * Extracted from `bootPluginsApp` so `shipped.e2e.test.ts` can put the tree back exactly the way
 * the boot built it: that spec's whole premise is the opposite arrangement (the two plugins in the
 * SHIPPED root and absent from the user dir), and the six specs ordered after it count footer
 * icons and manifest rows. One definition, used by both, so "restored" cannot drift from "seeded" —
 * the auto-coder switch (`writeHarnessPluginSwitches`) included.
 */
export function seedOptionalPlugins(pluginsDir: string, stateDir: string): ReadonlyArray<string> {
  const seeded: Array<string> = [];
  for (const optional of OPTIONAL_PLUGIN_DISTS) {
    if (!NodeFS.existsSync(NodePath.join(optional.dir, "plugin.json"))) continue;
    installPluginFolder(pluginsDir, optional.id, optional.dir);
    seeded.push(optional.id);
  }
  if (seeded.includes(AUTO_CODER_ID)) writeHarnessPluginSwitches(stateDir);
  return seeded;
}

/** The other half: take them OUT of the user dir, so only the shipped root can supply them. */
export function removeOptionalPlugins(pluginsDir: string): void {
  for (const optional of OPTIONAL_PLUGIN_DISTS) removePluginFolder(pluginsDir, optional.id);
}

/**
 * Build a payload-shaped SHIPPED root at `<tmpRoot>/shipped-payload/plugins/<id>` and return it.
 *
 * The shape is the release payload's, not a convenience: `versions/<v>/plugins/<id>` is what
 * `resolveShippedPluginsDir`'s first probe finds in a real install, and the loader's realpath
 * containment is per-root — so the fixture COPIES each `dist/` in exactly as `stage:plugins` does
 * (a symlink here would be silently ignored by `scanPluginsDir`, and the spec would fail for a
 * reason that has nothing to do with what it is testing).
 */
export function stageShippedPluginsFixture(
  tmpRoot: string,
  plugins: ReadonlyArray<{ readonly id: string; readonly dir: string }> = OPTIONAL_PLUGIN_DISTS,
): { readonly dir: string; readonly ids: ReadonlyArray<string> } {
  const dir = NodePath.join(tmpRoot, "shipped-payload", "plugins");
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const ids: Array<string> = [];
  for (const plugin of plugins) {
    if (!NodeFS.existsSync(NodePath.join(plugin.dir, "plugin.json"))) continue;
    NodeFS.cpSync(plugin.dir, NodePath.join(dir, plugin.id), {
      recursive: true,
      dereference: true,
    });
    ids.push(plugin.id);
  }
  return { dir, ids };
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
  apiVersion: 2,
  web: "web/index.mjs",
};
const FAULTY_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): plugin React that throws.
//
// v2 removed one whole family of these: an icon is a lucide NAME now, so "a panel whose icon
// throws" — the fixture that used to replace the entire SPA with the crash card on every page load
// — cannot be written any more. What is left is the surfaces that genuinely mount plugin React,
// plus the name case that replaced the icon one: an icon this build has never heard of.
import { createElement, useEffect } from "react";

function BoomOnUnmount() {
  useEffect(() => () => {
    throw new Error("panel unmount boom");
  }, []);
  return createElement("div", { "data-t": "panelunmount" }, "body");
}

const BoomRender = () => {
  throw new Error("panel render boom");
};

const BoomPage = () => {
  throw new Error("page render boom");
};

export default {
  // The icon NAME is nonsense on purpose: the host must render its fallback glyph, never throw.
  pages: () => [
    { id: "boom", title: "Boom page", icon: "NoSuchIconAtAll", render: BoomPage,
      nav: { label: "Boom page", icon: "NoSuchIconAtAll" } },
  ],
  panels: () => [
    { id: "render", title: "Boom render", icon: "Bug", render: BoomRender,
      nav: { label: "Boom render", icon: "Bug" } },
    // A body whose effect CLEANUP throws. It renders and opens fine; the fault is raised by
    // CLOSING the panel, in the commit that removes the subtree — which is exactly the commit that
    // destroys every boundary inside it.
    { id: "unmount", title: "Boom unmount", icon: "Bug", render: BoomOnUnmount,
      nav: { label: "Boom unmount", icon: "Bug" } },
  ],
};
`;

const SUSPEND_PLUGIN_MANIFEST = {
  id: DEMO_SUSPEND_ID,
  name: "Demo (suspend)",
  version: "0.1.0",
  apiVersion: 2,
  web: "web/index.mjs",
};

/**
 * The auditor's `iconlazyhang` and `rp1` fixtures (R3-H1 / R3-H2), plus the control.
 *
 * A SEPARATE plugin from `demo-faulty`: a render fault is reported once per plugin per SURFACE, so
 * a hanging icon in the same plugin as a THROWING icon would be de-duplicated away and the spec
 * could not tell the two apart.
 */
const SUSPEND_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): React that SUSPENDS.
import { createElement, lazy } from "react";

// A lazy component whose loader never settles. BEFORE the Suspense fallback existed: a pure white
// viewport at boot, with no crash card, no toast, no console line and no page error.
const LazyHang = lazy(() => new Promise(() => {}));
// The control: a lazy body that DOES resolve, after 3 s. It must end up showing its real content.
const LazyLate = lazy(
  () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ default: () => createElement("div", { "data-t": "latebody" }, "late") }),
        3000,
      ),
    ),
);
// A render that returns a PENDING promise. React 19 renders a thenable child by awaiting it, so
// this blanked the app on the click that opened the panel — and stayed blank after the panel was
// closed, because React hides suspended content rather than unmounting it.
const PromiseRender = () => new Promise(() => {});

export default {
  panels: () => [
    { id: "hang", title: "Hang body", icon: "Check", render: LazyHang,
      nav: { label: "Hang body", icon: "Check" } },
    { id: "late", title: "Late body", icon: "Check", render: LazyLate,
      nav: { label: "Late body", icon: "Check" } },
    { id: "promise", title: "Promise render", icon: "Check", render: PromiseRender,
      nav: { label: "Promise render", icon: "Check" } },
  ],
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
  apiVersion: 2,
  web: "web/index.mjs",
};

/**
 * The auditor's `badflood` fixture (R3-H4), with the R1-M5 flood beside it for contrast.
 *
 * BEFORE: the 300 malformed calls produced 600 toasts — the composer never appeared inside 60 s,
 * `page.evaluate("1+1")` timed out at 20 s and `page.screenshot` timed out twice at 25 s. The
 * 1000 WELL-FORMED registrations in the same file were handled in 1865 ms, which is what makes the
 * first number a regression rather than a fact of life.
 */
const FLOOD_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): a contribution flood.
//
// The auditor's \`badflood\`, in the v2 shape. A seam RETURNS a list, so a flood is one array with
// 1 300 entries in it rather than 1 300 calls — but the failure it has to be capped against is the
// same one that measured 600 toasts and a tab that stopped answering: the caps drop the excess and
// the plugin is told ONCE.
export default {
  panels: () => [
    // Well-formed entries FIRST, so the spec can prove the plugin's good half survives its own
    // flood — the cap ignores what comes after, not what came before.
    ...Array.from({ length: 4 }, (_, i) => ({
      id: "ok" + i,
      title: "Flood " + i,
      icon: "Bug",
      render: () => null,
      nav: { label: "Flood " + i, icon: "Bug" },
    })),
    // 300 malformed entries: a title that is not a string is exactly what the host must drop.
    ...Array.from({ length: 300 }, (_, i) => ({ id: "b" + i, title: { o: i }, render: () => null })),
    // …and 1000 more well-formed ones, every one of them past the cap: dropped SILENTLY.
    ...Array.from({ length: 1000 }, (_, i) => ({
      id: "late" + i,
      title: "Late " + i,
      icon: "Bug",
      render: () => null,
      nav: { label: "Late " + i, icon: "Bug" },
    })),
  ],
  composer: {
    items: () => [
      ...Array.from({ length: 300 }, (_, i) => ({ id: "b" + i, label: 42, insert: "x" })),
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: "ok" + i,
        label: "Flood row " + i,
        insert: "/flood" + i + " ",
      })),
    ],
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

// ── the NAMED plugin (S15 B1) ──────────────────────────────────────────────────────────────────
//
// A plugin whose MANIFEST loads and whose WEB HALF can be broken on demand, with a display name
// that is nothing like its id. That pairing is the whole fixture: the loader records the name from
// `manifests.json` for every row, and only then imports the web entry — so when the import throws,
// the host holds a name for a plugin that is not in its registry and never will be. A tab-mounted
// panel is the one surface that outlives its plugin (S15 A1/A2), so it is the one that has to
// render that name.
//
// Generated rather than committed, like `suspend` / `flood` / `faulty` / `css`: no build would emit
// a module whose top level throws, and the two halves have to be swappable inside one spec.

const NAMED_PLUGIN_MANIFEST = {
  id: DEMO_NAMED_ID,
  /** Deliberately NOT derivable from the id — the assertion is "name, not id". */
  name: "Named Plugin",
  version: "0.1.0",
  apiVersion: 2,
  web: "web/index.mjs",
};

const NAMED_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): one tab-mounted panel, nothing else.
import { createElement } from "react";

const TabBody = () => createElement("div", { "data-testid": "named-tab-body" }, "named tab body");

export default {
  panels: () => [
    { id: "notes", title: "Tab Panel", icon: "Puzzle", mount: "tab", render: TabBody,
      nav: { label: "Tab Panel", icon: "Puzzle" } },
  ],
};
`;

const NAMED_PLUGIN_BROKEN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): the SAME plugin, web half broken.
//
// The manifest is untouched — the server still scans the folder, still reports \`state: "loaded"\`
// and still serves this file — so the host learns the display name and then fails to import the
// module. That is the S15 B1 case: a name for a plugin the registry will never hold.
throw new Error("named plugin web entry is broken on purpose");
`;

/**
 * Write the generated `named` plugin, with its web half working or broken (S15 B1).
 *
 * The manifest is byte-identical either way, so swapping only the entry leaves the plugin's row —
 * and its NAME — exactly where it was.
 */
export function installNamedPlugin(
  pluginsDir: string,
  options: { readonly broken: boolean },
): void {
  const target = NodePath.join(pluginsDir, DEMO_NAMED_ID);
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(target, "web"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(target, "plugin.json"),
    `${JSON.stringify(NAMED_PLUGIN_MANIFEST, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(target, "web", "index.mjs"),
    options.broken ? NAMED_PLUGIN_BROKEN_WEB_ENTRY : NAMED_PLUGIN_WEB_ENTRY,
  );
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
  apiVersion: 2,
  web: "web/index.mjs",
  styles: "web/styles.css",
};

/** A web half that does nothing: the stylesheet is the whole fixture. */
const CSS_PLUGIN_WEB_ENTRY = `// e2e fixture (generated by harness/pluginsBoot.ts): a plugin whose STYLESHEET is the payload.
//
// It exports no seam at all, which is legal in v2: a plugin that contributes only a stylesheet is
// a whole plugin.
export default {};
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

/*
 * The SDK's V2-14 output shape, written out by hand because this fixture is a raw drop-in folder
 * that no SDK build ever touched. Every rule a real plugin ships is nested under its own root
 * attribute exactly like this, and the two claims the spec measures against it are:
 *
 *   · INSIDE a plugin root, \`.hidden\` is (0,2,0) against the app's (0,1,0) — so the plugin wins
 *     the fight the \`@layer plugin\` era always lost, and it wins it without a layer;
 *   · OUTSIDE one, the rule does not exist at all, so the app's own \`.hidden{display:none}\` still
 *     decides — which is the negative control for the claim above.
 */
[data-plugin-root="demo-css"] {
  .hidden { display: flex }
  .ru-demo-scoped-probe { color: rgb(4, 5, 6) }
}
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

/**
 * A path that is never created — the suite's way of saying "no shipped plugins root".
 *
 * Under `PLUGINS_ARTIFACTS_DIR` so it is obviously this harness's, and named so that a stray
 * `mkdir` of it would be recognisable as the mistake it would be.
 */
const NO_SHIPPED_PLUGINS_DIR = NodePath.join(PLUGINS_ARTIFACTS_DIR, "__no-shipped-plugins__");

const envFor = (state: {
  readonly homeDir: string;
  readonly t3Home: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
  readonly shippedPluginsDir?: string | undefined;
  /** ru-code (S24): `false` → NO starter project, i.e. the owner's fresh install with 0 projects. */
  readonly starterProject?: boolean | undefined;
}): NodeJS.ProcessEnv => ({
  ...process.env,
  // ru-code (V2-21): only when a spec staged one. Spread so an ordinary boot passes NO shipped
  // root at all rather than an empty string — `resolveShippedPluginsDir` treats "" as unset, but
  // an env var that is present-and-empty is the kind of thing that starts meaning something later.
  // ru-code (V2-21): this suite's DEFAULT is "there is no shipped root".
  //
  // `pnpm build` now stages the shipped set into `apps/server/dist/plugins`, and
  // `resolveShippedPluginsDir`'s FIRST probe is `<import.meta.dirname>/plugins` — which, for
  // `node apps/server/dist/bin.mjs`, is exactly that folder. Left alone, every spec in this suite
  // would therefore find analytics and catalogs already loaded from the payload root, shadowing the
  // user-dir copies `pluginsBoot` seeds and making `analytics.e2e.test.ts`'s "delete the folder and
  // it is gone" impossible to satisfy. Pointing the test-only override at a folder that does not
  // exist is how a run says "one root, the user's" — which is what eleven of the twelve specs are
  // about. `shipped.e2e.test.ts` passes a real directory and gets the two-root world.
  RU_CODE_SHIPPED_PLUGINS_DIR: state.shippedPluginsDir ?? NO_SHIPPED_PLUGINS_DIR,
  HOME: state.homeDir,
  T3CODE_HOME: state.t3Home,
  RU_CODE_CLI_JS: FAKE_ACP_ENTRY,
  RU_CODE_FAKE_ACP: "FLOW",
  RU_CODE_FAKE_CONTROL_FILE: state.controlFile,
  RU_CODE_FAKE_CLI_CONFIG_DIR: state.cliConfigDir,
  RU_CODE_FAKE_LOG_FILE: NodePath.join(PLUGINS_ARTIFACTS_DIR, "fake-acp.log"),
  RU_CODE_CREATE_STARTER_PROJECT: state.starterProject === false ? "0" : "1",
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
  /** ru-code (V2-21): `RU_CODE_SHIPPED_PLUGINS_DIR` for this boot, when a spec staged one. */
  readonly shippedPluginsDir?: string | undefined;
  /**
   * ru-code (S24): `false` → boot with NO project at all.
   *
   * Both halves have to go, and that is why this is one flag and not two: the server only
   * bootstraps the starter project when `--auto-bootstrap-project-from-cwd` is on AND
   * `RU_CODE_CREATE_STARTER_PROJECT=1` (`serverRuntimeStartup.ts:428-432`). The owner's
   * reproduction is a never-used base dir with zero projects, which is what the default `start`
   * command (no auto-bootstrap flag) gives a real user.
   */
  readonly starterProject?: boolean | undefined;
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
      ...(input.starterProject === false ? [] : ["--auto-bootstrap-project-from-cwd"]),
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
    // ru-code (V2-21): whatever the CALLER's state says — a spec turns the shipped root on by
    // restarting with `{ ...state, shippedPluginsDir }` and off again by dropping the field.
    shippedPluginsDir: state.shippedPluginsDir,
  });
  const next: PluginsHarnessState = { ...state, runnerPid };
  NodeFS.writeFileSync(PLUGINS_STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** The tmp tree one harness app runs in — every path the spawn and the state file need. */
interface HarnessTree {
  readonly tmpRoot: string;
  readonly baseDir: string;
  readonly pluginsDir: string;
  readonly stateDir: string;
  readonly homeDir: string;
  readonly t3Home: string;
  readonly cliConfigDir: string;
  readonly controlFile: string;
}

/**
 * Lay out a fresh tmp tree for one app: the base dir (plugins + userdata), a home with the CLI's
 * config dir, the t3 home, and the fake CLI's control file. ONE helper for both boots (S32 §3.4):
 * the suite's shared app (`bootPluginsApp`) and the cold app (`startColdPluginsApp`) differ in what
 * they SEED, never in the shape of the tree.
 */
function layoutHarnessTree(prefix: string): HarnessTree {
  NodeFS.mkdirSync(RU_CODE_TMP_ROOT, { recursive: true });
  const tmpRoot = NodeFS.mkdtempSync(NodePath.join(RU_CODE_TMP_ROOT, prefix));
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
  return { tmpRoot, baseDir, pluginsDir, stateDir, homeDir, t3Home, cliConfigDir, controlFile };
}

/**
 * ru-code (S24): a SECOND app on a NEVER-USED base dir — the owner's fresh install.
 *
 * `restartPluginsApp` cannot express this: it reuses the suite's base dir, so the plugin's own
 * sqlite (`<baseDir>/userdata/plugins/analytics/data.sqlite`) is already migrated AND already full
 * of parsed transcripts, which is the exact condition the owner's defect needs to be absent for.
 * What this boot gives instead is the owner's verbatim setup:
 *
 *  · a fresh `mkdtemp` base dir → the plugin migration `001-file-cache` is applied at boot and the
 *    analytics file cache is EMPTY, so the first `analytics.refresh` must parse every transcript;
 *  · no `--auto-bootstrap-project-from-cwd` and `RU_CODE_CREATE_STARTER_PROJECT=0` → **0 projects**;
 *  · its own port, so it never disturbs the suite's shared app (the state file is NOT rewritten) —
 *    which also means the spec must run with an EMPTY `storageState`: the saved `auth.json` is bound
 *    to the shared app's origin. That is the owner's "pair, then go straight to the page" anyway,
 *    and `tests-core/localAutoAuth.e2e.test.ts` already pins that a token-free fresh browser
 *    reaches the app over loopback.
 *
 * The caller owns the returned app and MUST stop it with {@link stopPluginsApp}.
 */
export async function startColdPluginsApp(options: {
  /** Seed the transcript corpus into this before the app starts; it is the app's `cliConfigDir`. */
  readonly seedCorpus?: (cliConfigDir: string) => void;
  readonly logName?: string;
}): Promise<PluginsHarnessState> {
  assertBuiltAppExists();
  assertDemoDistExists();

  const { tmpRoot, baseDir, pluginsDir, stateDir, homeDir, t3Home, cliConfigDir, controlFile } =
    layoutHarnessTree("ru-code-e2e-plugins-cold-");
  options.seedCorpus?.(cliConfigDir);

  // The same drop-in set the ordinary boot seeds, and for the same reason the owner's machine has
  // it: the real plugins are what the app loads, and the OTHER plugin's boot-time `plugin.invoke`
  // traffic is part of the condition the owner reported (six successful invokes on page open).
  installPluginFolder(pluginsDir, DEMO_ID, DEMO_PLUGIN_DIST);
  seedOptionalPlugins(pluginsDir, stateDir);

  const projectCwd = REPO_ROOT;
  const port = await reserveFreePort();
  const runnerPid = await spawnServer({
    port,
    baseDir,
    tmpRoot,
    homeDir,
    t3Home,
    cliConfigDir,
    controlFile,
    projectCwd,
    logName: options.logName ?? `app-cold-${String(Date.now())}.log`,
    starterProject: false,
  });

  return {
    webUrl: `http://localhost:${String(port)}`,
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

  const { tmpRoot, baseDir, pluginsDir, stateDir, homeDir, t3Home, cliConfigDir, controlFile } =
    layoutHarnessTree("ru-code-e2e-plugins-");

  // ── the drop-in, BEFORE the server starts (PluginHost.start scans once) ──────────────────────
  installPluginFolder(pluginsDir, DEMO_ID, DEMO_PLUGIN_DIST);
  installPluginFolder(pluginsDir, DEMO_BROKEN_ID, DEMO_BROKEN_FIXTURE);
  seedOptionalPlugins(pluginsDir, stateDir);
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
