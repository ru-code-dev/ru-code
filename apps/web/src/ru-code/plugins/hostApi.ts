// ru-code: the `WebPluginHost` object one plugin's `activate(host)` receives (mvp-plan §1.3).
//
// Everything a plugin can reach is on this object, scoped to its own id: its asset URLs, its
// panels, its composer items, its RPCs. React itself is deliberately NOT here — under D13 the
// plugin imports `react` by name and the index.html import map resolves it to the app's own
// chunk, which is what makes `host.hooks.*` legal to call from the plugin's components.

import type {
  PluginComposer,
  PluginComposerItem,
  PluginComposerProvider,
  PluginLocale,
  PluginPanelMode,
  PluginPanelRegistration,
  PluginProject,
  PluginToast,
  WebPluginHost,
} from "@smart-tools/plugin-sdk/host";
import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import { getLocale, L } from "@ru-code/localization";
import { useMemo } from "react";

import { connectionProjectionPhase } from "@t3tools/client-runtime/connection";

import { useTheme } from "~/hooks/useTheme";
import type { ReactNode } from "react";
import { environmentCatalog } from "~/connection/catalog";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

import { pluginPanelId, type GlobalPanelId } from "../skills-agents/rightGlobalPanel/store";
import { registerOverlayPanel } from "../skills-agents/rightGlobalPanel/registry";
import {
  addPluginBackgroundView,
  pluginBackgroundViewCount,
  MAX_BACKGROUND_VIEWS_PER_PLUGIN,
} from "./backgroundViews";
import { makePluginComposer } from "./composerPort";
import { pluginComposerItemId } from "./composerRegistry";
import { useActiveProjectId, useProjectsSource } from "../skills-agents/catalog/hostPorts";
import { makePluginInvoke } from "./rpcPort";
import { reportPluginProblem } from "./problems";
import { safePluginBackgroundRender, safePluginIcon, safePluginPanelRender } from "./renderSafety";
import { recordPluginDisplayName, type WebPluginStatus } from "./status";

/**
 * ru-code (A13, A12 finding R1-M5): per-plugin registration caps.
 *
 * One plugin looping `registerPanel` 1000 times produced 1024 footer buttons, pushed the sidebar's
 * project/thread list off screen and tripled time-to-interactive (5401 ms vs a 1740 ms baseline).
 * Nothing in the app was wrong — the registries are unbounded by design and a nav renders what it
 * is given — but "the host never dies because of a plugin" (guardrail 8) has to cover a `for` loop
 * an author writes by accident, not only a throw.
 *
 * The numbers are deliberately small: a panel is a SIDEBAR ICON, and no plugin has a legitimate
 * reason for more than a handful; composer items are rows in a menu the user types into. Beyond the
 * cap the registration is dropped and the plugin is told once, through the same toast+console
 * channel every other plugin problem uses — never a throw, which would abort `activate()` and take
 * the plugin's working half down with its mistake.
 */
export const MAX_PANELS_PER_PLUGIN = 4;
export const MAX_COMPOSER_ITEMS_PER_PLUGIN = 20;
/**
 * ru-code (A22, SDK 0.3.0): the cap on ALWAYS-MOUNTED, render-nothing surfaces
 * (`registerBackgroundView`). Re-exported from `backgroundViews.ts` so every plugin cap is
 * readable in one place, which is where a reviewer looks for them.
 *
 * It is the tightest cap on this host on purpose: a background view runs on every render of a
 * component the whole app depends on, and there is no honest plugin that needs three of them —
 * a plugin with three has written one component that should have been three hooks.
 */
export { MAX_BACKGROUND_VIEWS_PER_PLUGIN };

/**
 * ru-code (A13 round 3, A12 finding R3-H4): the ceiling on registration CALLS per surface, valid
 * or not. See `overCeiling` in {@link makeWebPluginHost}.
 */
export const MAX_REGISTRATION_CALLS_PER_PLUGIN = 100;

/**
 * ru-code (A13 round 2, A12 finding R2-H2): every plugin-supplied registration FIELD is validated
 * here, at the one host seam.
 *
 * `renderSafety.tsx` wraps the two surfaces that are React COMPONENTS. `label` is the third piece
 * of plugin data that reaches React and it reaches it as a CHILD — `SidebarChrome.tsx`'s
 * `<TooltipPopup>{panel.label}</TooltipPopup>` — i.e. outside every plugin boundary. A `label`
 * that was an object («Minified React error #31») replaced the whole app the moment the user
 * hovered the footer icon, and took a healthy second plugin down with it. The SDK types say
 * `label: string`, but a plugin is untyped JavaScript at run time: a label built from a helper that
 * returned an object, or read out of the plugin's own storage, arrives here unchecked.
 *
 * The composer half of the same host object already did this (`composerRegistry.ts`'s
 * `toMenuItem`); this is that shape, applied to BOTH halves and moved up to the seam, so the
 * registries downstream can keep assuming their inputs. A registration that fails is DROPPED and
 * the plugin is told once — never a throw, which would abort `activate()` (guardrail 8).
 *
 * The length cap is on the same footing: a 200 kB `label` is not a crash, but it is a nav row no
 * viewport can draw, and 64 characters is already three times the longest built-in label.
 */
export const MAX_REGISTRATION_LABEL_LENGTH = 64;

/**
 * ru-code (A13 round 3, A12 finding R3-L4): control and FORMAT characters are not a label.
 *
 * `trim()` removes whitespace, so `"\u00a0"` was already refused — but a zero-width space passed
 * and became an invisible footer tooltip, and a right-to-left override passed and flipped the
 * direction of the `aria-label` around it. Neither is a containment hole; both are a nav row the
 * user cannot read or trust, which is the same argument the length cap rests on.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

const isUsableLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= MAX_REGISTRATION_LABEL_LENGTH &&
  !CONTROL_OR_FORMAT.test(value);

/** A component may be a function OR an exotic object (`memo`, `forwardRef` — lucide ships these). */
const isComponentLike = (value: unknown): boolean =>
  typeof value === "function" || (typeof value === "object" && value !== null);

/** Which fields of a panel registration are unusable. Empty ⇒ the registration is well formed. */
export function invalidPanelFields(panel: unknown): readonly string[] {
  if (typeof panel !== "object" || panel === null) return ["registration"];
  const candidate = panel as Record<string, unknown>;
  const invalid: string[] = [];
  // ru-code (A13 round 3, A12 finding R3-L3): reading a field can THROW. A `label` defined as a
  // getter that throws propagated out of `registerPanel` and aborted `activate()`, so the plugin
  // lost every registration after the bad one — the opposite of what README §6 promises and of
  // what the comment here used to claim ("a getter cannot throw inside the host"). Every field is
  // read inside this one `try`; anything that throws is one unusable registration, reported.
  try {
    if (candidate["id"] !== undefined && typeof candidate["id"] !== "string") invalid.push("id");
    if (!isUsableLabel(candidate["label"])) invalid.push("label");
    if (!isComponentLike(candidate["icon"])) invalid.push("icon");
    if (typeof candidate["render"] !== "function") invalid.push("render");
    if (candidate["navHidden"] !== undefined && typeof candidate["navHidden"] !== "boolean") {
      invalid.push("navHidden");
    }
    // ru-code (A16, SDK 0.2.0): `preferredWidth` is a FINITE number or nothing.
    //
    // `Number.isFinite`, not `typeof === "number"`: `NaN` and `±Infinity` are numbers, and a `NaN`
    // reaching the panel host's width hook renders `style={{ width: "NaNpx" }}` — a declaration the
    // browser discards, collapsing the docked column to its flex minimum. Refusing the whole
    // registration (rather than dropping the field) is the house rule for every other field here:
    // the author is told which field is wrong, once, instead of debugging a silently ignored value.
    if (
      candidate["preferredWidth"] !== undefined &&
      !Number.isFinite(candidate["preferredWidth"])
    ) {
      invalid.push("preferredWidth");
    }
  } catch {
    return ["registration"];
  }
  return invalid;
}

const COMPOSER_TRIGGERS: ReadonlySet<string> = new Set(["command", "skill", "agent"]);

/** Which fields of a composer item are unusable. `label`/`description` are optional at run time. */
export function invalidComposerItemFields(item: unknown): readonly string[] {
  if (typeof item !== "object" || item === null) return ["item"];
  const candidate = item as Record<string, unknown>;
  const invalid: string[] = [];
  // R3-L3, the composer half: the same `try`, for the same reason.
  try {
    if (typeof candidate["trigger"] !== "string" || !COMPOSER_TRIGGERS.has(candidate["trigger"])) {
      invalid.push("trigger");
    }
    if (typeof candidate["name"] !== "string" || candidate["name"].trim() === "")
      invalid.push("name");
    if (candidate["label"] !== undefined && !isUsableLabel(candidate["label"]))
      invalid.push("label");
    if (candidate["description"] !== undefined && typeof candidate["description"] !== "string") {
      invalid.push("description");
    }
    if (typeof candidate["prompt"] !== "string" && typeof candidate["prompt"] !== "function") {
      invalid.push("prompt");
    }
  } catch {
    return ["item"];
  }
  return invalid;
}

/**
 * `/plugins/<id>/<rel>` — the route A2 serves plugin files from.
 *
 * Containment is enforced here as well as on the server (defence in depth, the posture
 * `http.ts:265-292` uses): a `..` segment, a leading `/` and a NUL are all refused, so a
 * plugin cannot mint a URL that walks out of its own folder even if the route ever regresses.
 */
export function pluginAssetUrl(pluginId: string, rel: string): string {
  // ru-code (A13, A12 finding R1-L1): a LEADING SLASH throws, it is not stripped. README §6 has
  // always said so; the old `replace(/^\/+/, "")` quietly turned `assetUrl("/etc/passwd")` into
  // `/plugins/<id>/etc/passwd`. Nothing escaped (the route still contains it), but an author
  // reading the documented contract got the opposite behaviour, which is how a real traversal
  // attempt goes unnoticed. One rule: the argument is plugin-relative or it is an error.
  const rejected =
    rel === "" ||
    rel.startsWith("/") ||
    rel.includes("\0") ||
    rel.split("/").some((segment) => segment === ".." || segment === ".");
  if (rejected) {
    throw new Error(
      `[plugins] ${pluginId}: assetUrl(${JSON.stringify(rel)}) is not a contained relative path`,
    );
  }
  return `/plugins/${pluginId}/${rel}`;
}

/** `host.hooks.useLocale` — a real React hook, so a plugin with its OWN React fails loudly. */
function usePluginLocale(): PluginLocale {
  // The locale is fixed for the lifetime of the document: changing the language writes the
  // server setting and RELOADS (see ru-code/locale.ts), which is the only way module-level
  // `L()` constants can be re-evaluated. `useMemo` is therefore correct AND is what makes this
  // a genuine hook call into the host's React — the identity proof mvp-plan §1.3 asks for.
  return useMemo(() => getLocale(), []);
}

/** `host.hooks.useTheme` — the app's resolved light/dark (the `hostPorts.ts` idiom). */
function usePluginTheme(): "light" | "dark" {
  return useTheme().resolvedTheme;
}

/**
 * ru-code (A22, SDK 0.3.0): `host.hooks.useProjects` — the app's project list, shaped for a plugin.
 *
 * Implemented over the app's OWN `useProjectsSource` rather than re-derived: that hook is what the
 * catalogs, the MCP panel and the pixso panel already read (`skills-agents/catalog/hostPorts.ts`),
 * so a plugin panel and a built-in panel cannot disagree about which projects exist. Its return
 * shape `{ id, name, cwd }` IS `PluginProject`, and its `id` is the app's stable `ProjectId` — the
 * same identity the server half's `host.projects` keys by, so the two halves need no translation.
 */
function usePluginProjects(): ReadonlyArray<PluginProject> {
  return useProjectsSource();
}

/**
 * ru-code (A22, SDK 0.3.0): `host.hooks.useActiveProjectId` — resolved from the ROUTE.
 *
 * Same reasoning: `activeProject.ts` is the app's own answer to "which project is the user looking
 * at", read today by the MCP active-project sync and the composer's catalog filter. Resolving it
 * from the route rather than from a component's props is what makes a panel, a background view and
 * a composer provider all see the same value in the same commit.
 */
function usePluginActiveProjectId(): string | null {
  return useActiveProjectId();
}

/** `host.hooks.useConnectionPhase` — the supervisor's own three-state projection, as a string. */
function usePluginConnectionPhase(): string {
  const environmentId = usePrimaryEnvironmentId();
  const { data } = useEnvironmentQuery(
    environmentId === null ? null : environmentCatalog.stateAtom(environmentId),
  );
  return data === null ? "disconnected" : connectionProjectionPhase(data);
}

const toPluginPanelMode = (mode: DiffPanelMode): PluginPanelMode =>
  mode === "sheet" ? "sheet" : "sidebar";

/**
 * ru-code (A13 round 3, A12 finding R3-H3): `host.toast` is the THIRD path a plugin has into React,
 * and round 2 validated only the first two.
 *
 * `title` and `description` went straight to `stackedThreadToast`, i.e. to base-ui's `<Toast.Title>`
 * — which renders them as React CHILDREN, outside every plugin boundary. `host.toast.error({
 * toString() {…}, evil: true })` from `activate()` therefore replaced the app with the crash card
 * («Minified React error #31»), on every boot, with a reload doing nothing and the card not even
 * naming the plugin. This is R2-H2's defect on the one surface that fix did not cover.
 *
 * NOTHING IS COERCED. A toast whose title is an object is a bug the author has to see; substituting
 * the plugin's name would show a toast that lies about what the plugin asked for. The call is
 * dropped and the plugin is told once, exactly like a malformed registration.
 */
export const MAX_TOAST_TITLE_LENGTH = 200;
export const MAX_TOAST_DESCRIPTION_LENGTH = 1000;

/** Which fields of a `host.toast.*` call are unusable. Empty ⇒ the call is well formed. */
export function invalidToastFields(title: unknown, description: unknown): readonly string[] {
  const invalid: string[] = [];
  if (
    typeof title !== "string" ||
    title.trim() === "" ||
    title.length > MAX_TOAST_TITLE_LENGTH ||
    CONTROL_OR_FORMAT.test(title)
  ) {
    invalid.push("title");
  }
  if (
    description !== undefined &&
    (typeof description !== "string" || description.length > MAX_TOAST_DESCRIPTION_LENGTH)
  ) {
    invalid.push("description");
  }
  return invalid;
}

function makePluginToast(pluginId: string, pluginName: string): PluginToast {
  const report = (kind: "success" | "error" | "info") => (title: string, description?: string) => {
    const invalid = invalidToastFields(title, description);
    if (invalid.length > 0) {
      reportPluginProblem({
        kind: "error",
        pluginId,
        code: "toast-invalid",
        title: L(
          `Plugin "${pluginName}" message was dropped`,
          `Сообщение плагина «${pluginName}» отброшено`,
        ),
        detail: L(
          `invalid toast fields: ${invalid.join(", ")}`,
          `некорректные поля уведомления: ${invalid.join(", ")}`,
        ),
      });
      return;
    }
    reportPluginProblem({
      kind,
      pluginId,
      title,
      ...(description === undefined ? {} : { detail: description }),
    });
  };
  return { success: report("success"), error: report("error"), info: report("info") };
}

/** Which overlay-panel ids one plugin registered (returned so the loader can report them). */
export interface PluginHostHandle {
  readonly host: WebPluginHost;
  readonly panelIds: readonly GlobalPanelId[];
}

export function makeWebPluginHost(status: Pick<WebPluginStatus, "id" | "name">): PluginHostHandle {
  const pluginId = status.id;
  const panelIds: GlobalPanelId[] = [];
  // The composer menu labels a plugin's section with its DISPLAY name, and the composer port
  // only ever sees the id — so the name is recorded here, where both are in hand.
  recordPluginDisplayName(pluginId, status.name);

  /**
   * One toast+console line per overflowing surface, however many registrations follow it.
   *
   * The de-duplication itself now lives in `problems.ts` (R3-H4) and is keyed by
   * `(pluginId, code)`; this local set stays because it is also what keeps the STRING building
   * below out of a hot loop.
   */
  const reportedOverflow = new Set<string>();
  const reportOverflow = (surface: string, title: string, detail: string): void => {
    if (reportedOverflow.has(surface)) return;
    reportedOverflow.add(surface);
    reportPluginProblem({ kind: "error", pluginId, code: `${surface}-overflow`, title, detail });
  };

  /**
   * ru-code (A13 round 3, A12 finding R3-H4): the HARD CEILING on registration CALLS.
   *
   * The caps above bound what a plugin gets (4 panels, 20 rows) and round 2 made them count
   * distinct ids — but a call that is REFUSED still costs the host the work of validating it and,
   * before this round, a toast apiece. 300 malformed `registerPanel` calls produced 600 toasts and
   * the tab stopped answering altogether, where a thousand well-formed ones booted in 1865 ms. So
   * a plugin gets a fixed budget of calls per surface, valid or not; past it the call returns
   * immediately and the ceiling itself is reported once. 100 is two orders of magnitude above what
   * any honest plugin does and two orders below where the browser notices.
   */
  const calls = new Map<string, number>();
  const overCeiling = (surface: string): boolean => {
    const spent = (calls.get(surface) ?? 0) + 1;
    calls.set(surface, spent);
    if (spent <= MAX_REGISTRATION_CALLS_PER_PLUGIN) return false;
    // Only the FIRST call past the ceiling builds a message; the rest are one map lookup.
    if (spent > MAX_REGISTRATION_CALLS_PER_PLUGIN + 1) return true;
    reportPluginProblem({
      kind: "error",
      pluginId,
      code: `${surface}-ceiling`,
      title: L(
        `Plugin "${status.name}" made too many registration calls`,
        `Плагин «${status.name}» сделал слишком много вызовов регистрации`,
      ),
      detail: L(
        `at most ${String(MAX_REGISTRATION_CALLS_PER_PLUGIN)} ${surface} registration calls per plugin; the rest are ignored`,
        `не более ${String(MAX_REGISTRATION_CALLS_PER_PLUGIN)} вызовов регистрации (${surface}) на плагин; остальные игнорируются`,
      ),
    });
    return true;
  };

  /** `Panel "<name>" was skipped` + a reason, the one message shape a dropped panel produces. */
  const reportPanelSkipped = (code: string, detail: string, detailRu: string): void => {
    reportPluginProblem({
      kind: "error",
      pluginId,
      // R3-H4: the category, so 300 malformed registrations cost ONE toast, not 300.
      code,
      // A4 finding M4: every host-side, user-facing plugin string is bilingual — the
      // toast lands in an otherwise Russian UI.
      title: L(
        `Plugin "${status.name}" panel was skipped`,
        `Панель плагина «${status.name}» пропущена`,
      ),
      detail: L(detail, detailRu),
    });
  };

  const registerPanel = (panel: PluginPanelRegistration): void => {
    // R3-H4: the ceiling is charged FIRST, so a loop of malformed calls costs one map lookup each.
    if (overCeiling("panel")) return;
    // ru-code (A13 round 2, A12 finding R2-H2): fields FIRST — `panel.id` is read below, and a
    // registration that is not an object at all must not throw inside the host.
    const invalid = invalidPanelFields(panel);
    if (invalid.length > 0) {
      reportPanelSkipped(
        "panel-invalid",
        `invalid panel fields: ${invalid.join(", ")}`,
        `некорректные поля панели: ${invalid.join(", ")}`,
      );
      return;
    }
    const id = pluginPanelId(pluginId, panel.id);
    if (id === null) {
      reportPanelSkipped(
        "panel-slug",
        `panel id ${JSON.stringify(panel.id ?? "")} is not a valid slug`,
        `идентификатор панели ${JSON.stringify(panel.id ?? "")} — некорректный слаг`,
      );
      return;
    }
    // ru-code (A13 round 2, A12 finding R2-M3): the cap counts DISTINCT ids, not calls. Both
    // registries replace on a duplicate id (`registry.tsx` even logs "registered twice;
    // replacing"), so re-registering one panel to change its label is the documented, supported
    // way to update a surface — and the per-call counter punished it as abuse, froze the panel at
    // the 4th call and told the author it had "registered too many panels".
    if (!panelIds.includes(id) && panelIds.length >= MAX_PANELS_PER_PLUGIN) {
      reportOverflow(
        "panel",
        L(
          `Plugin "${status.name}" registered too many panels`,
          `Плагин «${status.name}» зарегистрировал слишком много панелей`,
        ),
        L(
          `at most ${String(MAX_PANELS_PER_PLUGIN)} panels per plugin; the rest are ignored`,
          `не более ${String(MAX_PANELS_PER_PLUGIN)} панелей на плагин; остальные игнорируются`,
        ),
      );
      return;
    }
    registerOverlayPanel({
      id,
      label: panel.label,
      // ru-code (A13, A12 findings R1-H1/R1-H2): plugin React NEVER reaches a nav or the panel
      // host unwrapped. `renderSafety.tsx` explains why the boundary is here and not at the
      // three call sites.
      icon: safePluginIcon({ pluginId, pluginName: status.name, icon: panel.icon }),
      ...(panel.navHidden === undefined ? {} : { navHidden: panel.navHidden }),
      // ru-code (A16): the panel's requested docked width. Passed through as given — the CLAMP
      // (320–960) belongs to `RightGlobalPanelHost`, which owns the width and is the only place
      // that knows the persisted user width beats it.
      ...(panel.preferredWidth === undefined ? {} : { preferredWidth: panel.preferredWidth }),
      // `DiffPanelMode` is a superset ("inline" | "sheet" | "sidebar") of the SDK's
      // `PluginPanelMode`. This host only ever passes "sheet" or "sidebar"
      // (RightGlobalPanelHost.tsx:66,78); narrow explicitly rather than cast, so a future
      // "inline" mount degrades to the sidebar layout instead of handing a plugin a mode its
      // types say cannot happen.
      render: safePluginPanelRender({
        pluginId,
        pluginName: status.name,
        render: (mode, onClose) => panel.render(mode, onClose),
        toPluginMode: toPluginPanelMode,
      }),
    });
    if (!panelIds.includes(id)) panelIds.push(id);
  };

  /**
   * `registerItem` with the composer cap. Everything else on `PluginComposer` is untouched —
   * `attach`/`detach` are bounded by the draft they write to, and `useActiveTarget` is a hook.
   */
  const composerBase = makePluginComposer(pluginId);
  /** The DISTINCT row ids this plugin holds — the same counting rule as panels (R2-M3). */
  const composerItemIds = new Set<string>();
  const composer: PluginComposer = {
    ...composerBase,
    registerItem: (item: PluginComposerItem) => {
      // R3-H4: the same ceiling, on the composer's own budget of calls.
      if (overCeiling("composer-item")) return;
      // R2-H2, the composer half: the fields the menu renders are checked before the row is
      // counted, so a malformed item never consumes a slot in the cap either.
      const invalid = invalidComposerItemFields(item);
      if (invalid.length > 0) {
        reportPluginProblem({
          kind: "error",
          pluginId,
          code: "composer-item-invalid",
          title: L(
            `Plugin "${status.name}" composer item was skipped`,
            `Пункт композера плагина «${status.name}» пропущен`,
          ),
          detail: L(
            `invalid composer item fields: ${invalid.join(", ")}`,
            `некорректные поля пункта композера: ${invalid.join(", ")}`,
          ),
        });
        return;
      }
      // The identity the registry replaces on — computed with the registry's own function so the
      // cap and the store can never disagree about what "the same row" means.
      const itemId = pluginComposerItemId(pluginId, item.trigger, item.name.trim());
      if (!composerItemIds.has(itemId) && composerItemIds.size >= MAX_COMPOSER_ITEMS_PER_PLUGIN) {
        reportOverflow(
          "composer-item",
          L(
            `Plugin "${status.name}" registered too many composer items`,
            `Плагин «${status.name}» зарегистрировал слишком много пунктов композера`,
          ),
          L(
            `at most ${String(MAX_COMPOSER_ITEMS_PER_PLUGIN)} composer items per plugin; the rest are ignored`,
            `не более ${String(MAX_COMPOSER_ITEMS_PER_PLUGIN)} пунктов на плагин; остальные игнорируются`,
          ),
        );
        return;
      }
      composerItemIds.add(itemId);
      composerBase.registerItem(item);
    },
    // ru-code (A22, SDK 0.3.0): the same CALL ceiling every other surface is charged (R3-H4) —
    // 100 registration calls, valid or not. The per-trigger cap (2) and the boundary live in
    // `composerRegistry.registerComposerProvider`, which is where the store's own count is, so
    // the cap and the store cannot disagree about what is registered.
    registerProvider: (provider: PluginComposerProvider) => {
      if (overCeiling("composer-provider")) return;
      composerBase.registerProvider(provider);
    },
  };

  /**
   * ru-code (A22, SDK 0.3.0, owner decision O3-b): `registerBackgroundView`.
   *
   * The cap is charged the same way panels' is (distinct surfaces, not calls), and `render` is
   * wrapped in this plugin's boundary + `<Suspense>` HERE, before the entry reaches the store —
   * the surface is mounted app-wide above the router, so an unwrapped throw would be the app's
   * crash card rather than a plugin's problem row.
   */
  const registerBackgroundView = (render: () => ReactNode): void => {
    if (overCeiling("background-view")) return;
    if (typeof render !== "function") {
      reportPluginProblem({
        kind: "error",
        pluginId,
        code: "background-view-invalid",
        title: L(
          `Plugin "${status.name}" background view was skipped`,
          `Фоновая вьюха плагина «${status.name}» пропущена`,
        ),
        detail: L(
          "registerBackgroundView(render) needs a function",
          "registerBackgroundView(render) требует функцию",
        ),
      });
      return;
    }
    const registered = pluginBackgroundViewCount(pluginId);
    if (registered >= MAX_BACKGROUND_VIEWS_PER_PLUGIN) {
      reportOverflow(
        "background-view",
        L(
          `Plugin "${status.name}" registered too many background views`,
          `Плагин «${status.name}» зарегистрировал слишком много фоновых вьюх`,
        ),
        L(
          `at most ${String(MAX_BACKGROUND_VIEWS_PER_PLUGIN)} background views per plugin; the rest are ignored`,
          `не более ${String(MAX_BACKGROUND_VIEWS_PER_PLUGIN)} фоновых вьюх на плагин; остальные игнорируются`,
        ),
      );
      return;
    }
    addPluginBackgroundView({
      key: `background:${pluginId}:${String(registered)}`,
      pluginId,
      render: safePluginBackgroundRender({
        pluginId,
        pluginName: status.name,
        surface: "background-view",
        render,
      }),
    });
  };

  const host: WebPluginHost = {
    id: pluginId,
    assetUrl: (rel) => pluginAssetUrl(pluginId, rel),
    getLocale: () => getLocale(),
    toast: makePluginToast(pluginId, status.name),
    registerPanel,
    registerBackgroundView,
    composer,
    invoke: makePluginInvoke(pluginId),
    hooks: {
      useLocale: usePluginLocale,
      useTheme: usePluginTheme,
      useConnectionPhase: usePluginConnectionPhase,
      useProjects: usePluginProjects,
      useActiveProjectId: usePluginActiveProjectId,
    },
  };

  return { host, panelIds };
}
