// ru-code (A13, A12 findings R1-H1 / R1-H2): the error boundary around every piece of REACT a
// plugin supplies.
//
// A plugin contributes exactly two render surfaces (SDK `./host`): a panel `icon` component and a
// panel `render(mode, onClose)` function. Both used to be mounted raw — `SidebarChrome.tsx`'s
// `<Icon />` and `RightGlobalPanelHost.tsx`'s `{active.render(...)}` — so four lines of plugin code
// could replace the entire SPA with the app's crash card, on every load in the icon's case, with no
// UI left to uninstall the plugin from. That is guardrail 8 ("the host never dies because of a
// plugin") broken by the smallest possible mistake.
//
// WHY THE BOUNDARY LIVES HERE and not at the three call sites Fable named. `hostApi.ts` is the ONE
// seam in `apps/**` where plugin React becomes an `OverlayPanel`, so wrapping here covers the
// sidebar footer row, `GlobalPanelNav`, `RightGlobalPanelHost` and any nav added later — and cannot
// be forgotten by the next one. Built-in panels are seeded straight into `OVERLAY_PANELS` and never
// pass through here, so they keep failing loudly, which is what we want from first-party code.
//
// WHY THE PANEL BODY IS A COMPONENT and not just wrapped children. `render` is a plain function the
// host CALLS during its own render: `<Boundary>{panel.render(mode, close)}</Boundary>` evaluates
// `render` OUTSIDE the boundary, so a synchronous throw (exactly the A12 fixture) escapes it. The
// call has to happen inside a component that the boundary owns.
//
// The composer surface needs none of this: `PluginComposerItem` carries `label`/`description` as
// STRINGS and its `prompt` is resolved in an async handler with its own catch — no plugin component
// is ever mounted for a composer row.
//
// ru-code (A13 round 2, A12 finding R2-H1): THE THIRD SURFACE — the panel's UNMOUNT.
//
// The two boundaries above are mounted INSIDE the panel, so they die with it. A `useEffect`
// cleanup runs during the commit that REMOVES the subtree: the boundary is being torn down in the
// same commit, so React walks past it to the next boundary that is still mounted — which was the
// router root, i.e. the crash card, with no attribution at all. The trigger is the most ordinary
// interaction there is: clicking the panel's footer icon a second time.
//
// The answer is a boundary that OUTLIVES the panel: `PluginPanelSlotBoundary` is mounted once by
// `RightGlobalPanelHost` and stays mounted while the plugin's subtree comes and goes, so an
// unmount-phase throw lands on a live boundary. It renders `null` and resets itself — the panel is
// already closing, which is what raised the throw — after attributing the fault to the plugin that
// owned the slot. A BUILT-IN panel's throw is re-thrown from its render, so first-party code keeps
// failing loudly (the posture the icon/render boundaries take by not covering built-ins at all).
//
// WHY THE OWNER IS REMEMBERED rather than read from the props at catch time. A passive-effect
// cleanup runs AFTER the commit that removed the subtree, so by then the host has already
// re-rendered with `open === null` and the boundary's `pluginId` prop is null. The boundary
// therefore keeps the current owner and the one before it (`owner` / `previousOwner`, both synced
// from `componentDidMount`/`componentDidUpdate`) and blames `owner ?? previousOwner`. The one case
// this gets wrong is a BUILT-IN panel whose unmount cleanup throws while the user is switching
// straight to a plugin panel — that fault is attributed to the plugin taking the slot. It costs a
// wrong toast, never the app, and no first-party panel schedules a throwing cleanup.
//
// AND THE LAST-RESORT NET (`pluginPanelCrashCandidate` / `recoverFromPluginPanelCrash`, wired into
// `routes/__root.tsx`'s `errorComponent`). Whatever React routes past every boundary above, if a
// PLUGIN panel is open when the root error view mounts the panel is closed, the plugin is named
// once, and the router is `reset()` — so no plugin path can leave the crash card on screen. Guarded
// per plugin id: a second crash from the same plugin shows the card, because at that point the app
// really may be broken.
//
// ru-code (A13 round 3, A12 findings R3-H1 / R3-H2): THE FOURTH SURFACE — React that SUSPENDS.
//
// An error boundary catches a THROW. Suspension is not a throw: React unwinds to the nearest
// `<Suspense>` boundary, and there was none above a plugin's surfaces — so the whole root tree
// suspended and React rendered NOTHING. `React.lazy(() => new Promise(() => {}))` as a panel icon
// (one line, and exactly the shape `isComponentLike` was widened in round 2 to admit) produced a
// pure white viewport at boot: no crash card, no toast, no console line, no page error, no UI left
// to uninstall the plugin from. A `render` that returned a pending promise did the same on the
// click that opened the panel — and stayed blank after the panel was closed, because React hides
// suspended content with `display:none` rather than unmounting it.
//
// So every plugin surface now renders inside a `<Suspense>` INSIDE its existing boundary:
//
//   · the ICON falls back to a neutral placeholder glyph — the button keeps its size and its
//     tooltip, which is what the user clicks to reach (and then remove) the plugin;
//   · the PANEL BODY falls back to a spinner card naming the plugin, so a slow lazy import reads
//     as "loading", not as "broken".
//
// A suspension has no callback ("still suspended" is not an event React reports), so each fallback
// arms a {@link PLUGIN_SUSPENSE_REPORT_MS} timer and reports ONCE through the same channel every
// other plugin fault uses. The timer is cleared when the fallback unmounts, i.e. when the lazy
// component finally resolves — a legitimately slow icon is never blamed.
//
// AND ONE REFUSAL AT THE SEAM. `render()` returning a THENABLE is refused outright (a fallback
// card, one report): React 19 renders a thenable child by `use()`-ing it, so a pending promise
// suspends the panel forever, and the SDK contract has always said `render` returns a `ReactNode`.
// A `lazy` icon, by contrast, is legal and is handled by the Suspense above — the difference is
// that `lazy` is a component the author opted into, while a promise from `render` is a missing
// `await` in code that cannot use one.
//
// WHY EVERY COMPONENT HERE IS TOP-LEVEL and the two exported factories build their elements with
// `createElement` instead of JSX. The app builds with the REACT COMPILER. A capitalised component
// defined INSIDE a factory (`const SafePluginIcon = (props) => <…/>`) is compiled as a component,
// and the compiler hoisted its `onError` closure to module scope while it still referenced the
// factory's own parameter — shipping `function qVt(e){return HVt({pluginId:input.pluginId,…})}`
// with `input` out of scope. That is a boot-time `ReferenceError: input is not defined` inside the
// sidebar, i.e. the exact crash card this module exists to prevent; the new e2e spec caught it on
// its first run against the real build. So: every component is declared at module scope and takes
// everything through PROPS (which the compiler handles correctly), and what the factories return is
// a lowercase, JSX-free function the compiler does not treat as a component at all.

import { L } from "@ru-code/localization";
import { CircleDashedIcon, LoaderCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type {
  PluginIconComponent,
  PluginIconProps,
  PluginPanelMode,
} from "@smart-tools/plugin-sdk/host";
import { Component, createElement, Suspense, useEffect, type ReactNode } from "react";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";

import { useRightGlobalPanelStore } from "../skills-agents/rightGlobalPanel/store";
import { reportPluginProblem } from "./problems";
import { pluginDisplayName } from "./status";

/** One report per plugin surface, however many times React re-renders it. */
const reportedSurfaces = new Set<string>();

/**
 * The surface name shared by the slot boundary and the router-root net (R2-H1).
 *
 * Both report through {@link reportRenderFault}, which de-duplicates by `plugin:surface` — one
 * name for both means the user is told ONCE per plugin whichever of the two nets caught the fault.
 */
const PANEL_LIFECYCLE_SURFACE = "panel";

/** Plugins already recovered from at the router root; a SECOND crash shows the card (R2-H1). */
const recoveredPluginPanels = new Set<string>();

/**
 * How long a plugin surface may stay SUSPENDED before the fault is reported (R3-H1/R3-H2).
 *
 * The same budget `loadPlugins` gives a plugin's `activate()`: long enough that a genuinely slow
 * dynamic import resolves first (the auditor's 3 s `lazy` icon is well inside it), short enough
 * that a loader which will never settle is named while the user is still looking at the app.
 */
export const PLUGIN_SUSPENSE_REPORT_MS = 10_000;

/**
 * How recently a plugin boundary must have caught for the router root to blame the plugin (R3-H3).
 *
 * The round-2 net keyed off "a plugin panel is OPEN", which is not evidence of anything: it blamed
 * the plugin for an app-level crash that merely happened while its panel was up, and it did
 * nothing at all when the fault came from `activate()` at boot with no panel open. The flag below
 * is set by the plugin boundaries themselves, so the root card is attributed only when a plugin's
 * React actually failed a moment earlier.
 */
export const PLUGIN_FAULT_ATTRIBUTION_MS = 5_000;

/** The last fault a PLUGIN boundary caught — the only evidence the router root accepts (R3-H3). */
let lastPluginFault: { readonly id: string; readonly at: number } | null = null;

/** Called from every plugin boundary's `onError`; see {@link pluginPanelCrashCandidate}. */
function flagPluginFault(pluginId: string): void {
  lastPluginFault = { id: pluginId, at: Date.now() };
}

/** Test seam. */
export function resetPluginRenderFaultReports(): void {
  reportedSurfaces.clear();
  recoveredPluginPanels.clear();
  lastPluginFault = null;
}

const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  return firstLine === "" ? L("render failed", "ошибка отрисовки") : firstLine;
};

function reportRenderFault(input: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly surface: string;
  readonly error: unknown;
}): void {
  const key = `${input.pluginId}:${input.surface}`;
  if (reportedSurfaces.has(key)) return;
  reportedSurfaces.add(key);
  reportPluginProblem({
    kind: "error",
    pluginId: input.pluginId,
    // R3-H4: the category, so `problems.ts` shows one toast per plugin per surface however many
    // times React re-renders a broken tree.
    code: `render:${input.surface}`,
    title: L(
      `Plugin "${input.pluginName}" failed to render`,
      `Плагин «${input.pluginName}» не смог отрисоваться`,
    ),
    detail: `${input.surface}: ${describe(input.error)}`,
  });
}

/**
 * A fallback that names the plugin if the suspension never ends (R3-H1/R3-H2).
 *
 * React has no "still suspended" callback, so the only honest signal is time: the fallback is
 * mounted for as long as the surface is suspended, and it reports once the budget is spent. When
 * the lazy component resolves the fallback unmounts and the timer is cleared — which is what keeps
 * a legitimately slow dynamic import from being reported as a fault.
 *
 * The report itself is {@link reportPluginSuspended}, a plain function: this project has no DOM in
 * its unit environment, so the timer's PAYLOAD has to be reachable without a renderer.
 */
export function reportPluginSuspended(input: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly surface: string;
  readonly message: string;
}): void {
  reportRenderFault({ ...input, error: new Error(input.message) });
}

function usePluginSuspenseReport(input: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly surface: string;
  readonly message: string;
}): void {
  const { message, pluginId, pluginName, surface } = input;
  useEffect(() => {
    const timer = setTimeout(() => {
      reportPluginSuspended({ pluginId, pluginName, surface, message });
    }, PLUGIN_SUSPENSE_REPORT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [message, pluginId, pluginName, surface]);
}

/** The neutral placeholder the footer button shows while a plugin's icon is suspended. */
function PluginIconPending({
  pluginId,
  pluginName,
  ...iconProps
}: PluginIconProps & { readonly pluginId: string; readonly pluginName: string }) {
  usePluginSuspenseReport({
    pluginId,
    pluginName,
    surface: "icon",
    message: L("the icon never finished loading", "иконка так и не загрузилась"),
  });
  return (
    <span
      aria-label={L("plugin icon loading", "иконка плагина загружается")}
      className="inline-flex items-center justify-center opacity-60"
      data-plugin-icon-pending={pluginId}
      role="img"
    >
      <CircleDashedIcon {...iconProps} />
    </span>
  );
}

/** The spinner card the panel shows while a plugin's body is suspended. */
function PluginPanelPending({
  pluginId,
  pluginName,
}: {
  readonly pluginId: string;
  readonly pluginName: string;
}) {
  usePluginSuspenseReport({
    pluginId,
    pluginName,
    surface: "render",
    message: L("the panel never finished rendering", "панель так и не отрисовалась"),
  });
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-4"
      data-slot="plugin-panel-pending"
    >
      <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      <div className="text-sm text-muted-foreground">
        {L(`Plugin "${pluginName}" is loading…`, `Плагин «${pluginName}» загружается…`)}
      </div>
    </div>
  );
}

type PluginIconBoundaryProps = PluginIconProps & {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly icon: PluginIconComponent;
};

/**
 * A plugin's panel icon, mounted inside a boundary. A throw becomes a generic warning glyph —
 * never a missing button, because the button is what the user clicks to reach (and then remove)
 * the plugin.
 */
function PluginIconBoundary({ icon, pluginId, pluginName, ...iconProps }: PluginIconBoundaryProps) {
  const Icon = icon;
  return (
    <RenderErrorBoundary
      fallback={
        // `aria-label`, not `title`: the app bans the native title tooltip (`t3code/
        // no-native-title-tooltip`), and this glyph is rendered INSIDE the nav's own
        // `TooltipTrigger` — a second Tooltip nested in a trigger would fight it for the pointer.
        // The button already tooltips the panel's label; this adds the reason for assistive tech
        // and gives the e2e suite a stable hook.
        <span
          aria-label={L("plugin failed", "плагин не работает")}
          className="inline-flex items-center justify-center"
          data-plugin-icon-failed={pluginId}
          role="img"
        >
          <TriangleAlertIcon {...iconProps} />
        </span>
      }
      onError={(error) => {
        flagPluginFault(pluginId);
        reportRenderFault({ pluginId, pluginName, surface: "icon", error });
      }}
    >
      {/* R3-H1: a `lazy` icon whose loader never settles SUSPENDS, and a suspension is not an
          error — without this boundary React unwound to the root and rendered nothing at all. */}
      <Suspense
        fallback={<PluginIconPending {...iconProps} pluginId={pluginId} pluginName={pluginName} />}
      >
        <Icon {...iconProps} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

/** Wrap a plugin's panel icon. See the module header for why this returns a plain function. */
export function safePluginIcon(input: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly icon: PluginIconComponent;
}): PluginIconComponent {
  const { icon, pluginId, pluginName } = input;
  const safeIcon = (props: PluginIconProps): ReactNode =>
    createElement(PluginIconBoundary, { ...props, icon, pluginId, pluginName });
  return safeIcon as PluginIconComponent;
}

/**
 * The plugin's own `render`, CALLED HERE rather than by the host.
 *
 * `<Boundary>{panel.render(mode, close)}</Boundary>` would evaluate `render` outside the boundary,
 * so a synchronous throw (exactly the A12 fixture) escapes it. The call has to happen inside a
 * component the boundary owns.
 */
const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

function PluginPanelBody({
  mode,
  onClose,
  render,
}: {
  readonly mode: PluginPanelMode;
  readonly onClose: () => void;
  readonly render: (mode: PluginPanelMode, onClose: () => void) => ReactNode;
}) {
  const node = render(mode, onClose);
  // ru-code (A13 round 3, A12 finding R3-H2): a PROMISE is not a ReactNode. React 19 renders a
  // thenable child by `use()`-ing it, so a pending one suspends the panel for as long as it stays
  // pending — the auditor's fixture blanked the app on the click that opened the panel and stayed
  // blank after it was closed. The boundary above turns this throw into the panel's own fallback
  // card, which names the plugin and the rule.
  if (isThenable(node)) {
    throw new Error(
      L(
        "render() must return a ReactNode, not a Promise",
        "render() должен вернуть ReactNode, а не Promise",
      ),
    );
  }
  return <>{node}</>;
}

function PluginPanelFallback({
  error,
  onClose,
  pluginName,
}: {
  readonly error: unknown;
  readonly onClose: () => void;
  readonly pluginName: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4"
      data-slot="plugin-panel-failed"
    >
      <div className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium wrap-break-word">
            {L(
              `Plugin "${pluginName}" failed to render`,
              `Плагин «${pluginName}» не смог отрисоваться`,
            )}
          </div>
          <div className="mt-1 text-xs wrap-break-word text-muted-foreground select-text">
            {describe(error)}
          </div>
        </div>
        <button
          aria-label={L("Close panel", "Закрыть панель")}
          className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="text-xs text-muted-foreground">
        {L(
          "The rest of the app is unaffected. Remove the plugin folder and restart to uninstall it.",
          "На остальное приложение это не влияет. Чтобы удалить плагин, удалите его папку и перезапустите приложение.",
        )}
      </div>
    </div>
  );
}

type PluginPanelBoundaryProps = {
  readonly mode: PluginPanelMode;
  readonly onClose: () => void;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly render: (mode: PluginPanelMode, onClose: () => void) => ReactNode;
};

/**
 * The boundary's fallback, as a factory rather than an inline arrow.
 *
 * `react/no-unstable-nested-components` (correctly) refuses a function that returns a component
 * written inline in a prop — and the point of that rule, an identity that changes every render, is
 * real here too: `RenderErrorBoundary` only reads `fallback` once it has already caught, so a fresh
 * closure costs nothing, but keeping the shape at module scope keeps it obvious.
 */
const makePanelFallback =
  (pluginName: string, onClose: () => void) =>
  (error: unknown): ReactNode =>
    createElement(PluginPanelFallback, { error, onClose, pluginName });

function PluginPanelBoundary({
  mode,
  onClose,
  pluginId,
  pluginName,
  render,
}: PluginPanelBoundaryProps) {
  return (
    <RenderErrorBoundary
      fallback={makePanelFallback(pluginName, onClose)}
      onError={(error) => {
        flagPluginFault(pluginId);
        reportRenderFault({ pluginId, pluginName, surface: "render", error });
      }}
    >
      {/* R3-H2: anything INSIDE the plugin's own tree may suspend too — a `lazy` child, a `use()`
          of a promise — so the Suspense wraps the body rather than only guarding `render`'s
          result. */}
      <Suspense fallback={<PluginPanelPending pluginId={pluginId} pluginName={pluginName} />}>
        <PluginPanelBody mode={mode} onClose={onClose} render={render} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

/**
 * Wrap a plugin's panel `render`. The signature stays the host's (`DiffPanelMode`), because that is
 * what `OverlayPanel.render` is; the narrowing to the SDK's two-value `PluginPanelMode` is the
 * caller's, exactly as before.
 */
export function safePluginPanelRender(input: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly render: (mode: PluginPanelMode, onClose: () => void) => ReactNode;
  readonly toPluginMode: (mode: DiffPanelMode) => PluginPanelMode;
}): (mode: DiffPanelMode, onClose: () => void) => ReactNode {
  const { pluginId, pluginName, render, toPluginMode } = input;
  return (mode, onClose) =>
    createElement(PluginPanelBoundary, {
      mode: toPluginMode(mode),
      onClose,
      pluginId,
      pluginName,
      render,
    });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R2-H1 — the panel SLOT boundary, and the router-root net behind it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `plugin:<pluginId>[:<panelId>]` → the plugin id; `null` for a built-in panel. */
export function pluginIdFromPanelId(panelId: string | null): string | null {
  if (panelId === null) return null;
  const [prefix, pluginId] = panelId.split(":");
  return prefix === "plugin" && pluginId !== undefined && pluginId !== "" ? pluginId : null;
}

type PluginSlotOwner = { readonly id: string; readonly name: string };

type PluginPanelSlotBoundaryProps = {
  readonly children: ReactNode;
  /** The plugin that owns the slot right now, or `null` while a built-in panel does. */
  readonly pluginId: string | null;
  /** Closes the global panel — the slot is unusable once its subtree threw. */
  readonly onPluginFault: () => void;
};

type PluginPanelSlotBoundaryState = { readonly failed: boolean; readonly error: unknown };

/**
 * The boundary that OUTLIVES the panel (module header, R2-H1).
 *
 * A class, deliberately: only a class component can catch, and the React Compiler leaves classes
 * alone — which is the other half of why nothing in this file is a closure over a factory
 * parameter.
 */
export class PluginPanelSlotBoundary extends Component<
  PluginPanelSlotBoundaryProps,
  PluginPanelSlotBoundaryState
> {
  override state: PluginPanelSlotBoundaryState = { failed: false, error: undefined };

  /** The owner of the subtree as last COMMITTED, and the one before it. See the module header. */
  private owner: PluginSlotOwner | null = null;
  private previousOwner: PluginSlotOwner | null = null;

  static getDerivedStateFromError(error: unknown): PluginPanelSlotBoundaryState {
    return { failed: true, error };
  }

  override componentDidMount(): void {
    this.syncOwner();
  }

  override componentDidUpdate(): void {
    this.syncOwner();
  }

  override componentDidCatch(error: unknown): void {
    const owner = this.owner ?? this.previousOwner;
    if (owner === null) return; // a built-in panel: re-thrown from render, never swallowed here.
    flagPluginFault(owner.id);
    reportRenderFault({
      pluginId: owner.id,
      pluginName: owner.name,
      surface: PANEL_LIFECYCLE_SURFACE,
      error,
    });
    this.props.onPluginFault();
    // The slot has to keep working for the NEXT panel: the fault is already reported and the
    // panel is closing, so the boundary hands its own state back rather than latching a fallback.
    this.setState({ failed: false, error: undefined });
  }

  private syncOwner(): void {
    const { pluginId } = this.props;
    const next: PluginSlotOwner | null =
      pluginId === null ? null : { id: pluginId, name: pluginDisplayName(pluginId) };
    if (next?.id === this.owner?.id) return;
    this.previousOwner = this.owner;
    this.owner = next;
  }

  override render(): ReactNode {
    if (this.state.failed) {
      // Nothing here owns a built-in panel's failure: re-throw so the app's own root still shows
      // it, exactly as it did before this boundary existed.
      if ((this.owner ?? this.previousOwner) === null) throw this.state.error;
      return null;
    }
    return this.props.children;
  }
}

/**
 * The plugin a root crash may honestly be blamed on, or `null`.
 *
 * Read by `routes/__root.tsx`'s `errorComponent` on mount: a non-null answer means "this crash
 * card is a plugin's, close its panel and try again" (R2-H1).
 *
 * ru-code (A13 round 3, A12 finding R3-H3): the evidence is a PLUGIN BOUNDARY THAT JUST CAUGHT,
 * not an open panel. Round 2 keyed off `useRightGlobalPanelStore.getState().open`, which says
 * nothing about who broke: it blamed a plugin for any app-level crash that happened while its
 * panel was up, and it did nothing at boot — where `host.toast({…})` with a non-string title put
 * the crash card on screen with no panel open, on every reload. With no flag inside the window the
 * app's own generic card is the honest answer.
 */
export function pluginPanelCrashCandidate(): string | null {
  const fault = lastPluginFault;
  if (fault === null || Date.now() - fault.at > PLUGIN_FAULT_ATTRIBUTION_MS) return null;
  if (recoveredPluginPanels.has(fault.id)) return null;
  return fault.id;
}

/**
 * Close the crashed plugin's panel and name it, ONCE per plugin.
 *
 * The caller (`routes/__root.tsx`) then calls the router's own `reset()`. A second crash from the
 * same plugin is not recovered from — at that point the app may genuinely be broken and the card
 * is the honest answer.
 */
export function recoverFromPluginPanelCrash(pluginId: string, error: unknown): void {
  recoveredPluginPanels.add(pluginId);
  useRightGlobalPanelStore.getState().close();
  reportRenderFault({
    pluginId,
    pluginName: pluginDisplayName(pluginId),
    surface: PANEL_LIFECYCLE_SURFACE,
    error,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A22 (SDK 0.3.0) — THE FIFTH SURFACE: React that draws nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `registerBackgroundView` and the composer PROVIDER drivers both mount plugin components that
// return `null` and exist only for their hooks and effects. They are the riskiest surface on this
// page, not the safest, for one reason: they are mounted app-wide and ALWAYS, so a throw in one is
// a throw in the app shell rather than in a panel the user opened. The boundary is therefore not
// optional here, and it renders `null` — there is no card to show for a surface that had no
// pixels, and drawing one would put a plugin's failure in the middle of the app's chrome.
//
// The `<Suspense fallback={null}>` is the same argument: a background view that suspends must not
// suspend the shell it is mounted in. Its work simply has not happened yet.
//
// The fault is still ATTRIBUTED — `reportRenderFault` gives the plugin its toast and its problem
// row, exactly as a panel throw does — so "silent" is only true of the pixels.

function PluginBackgroundBody({ render }: { readonly render: () => ReactNode }) {
  // Same reason `PluginPanelBody` exists: rendering the body outside the boundary would let a
  // synchronous throw escape it.
  //
  // ru-code (A24-fix, A24 finding H1) — THE BODY IS MOUNTED, NEVER CALLED. This line used to read
  // `<>{render()}</>`, and that one pair of parentheses is the whole of H1:
  //
  //   * a plain call runs the body's hooks on THIS component's fiber, not on one of its own;
  //   * and this file is compiled by the REACT COMPILER (see the note at the top). A body that
  //     takes `render` through props and calls it compiles to
  //         let t1; if ($[0] !== render) { t1 = render(); $[0] = render; $[1] = t1; } else t1 = $[1];
  //     — the call is MEMOIZED on the identity of `render`, which is bound once per registration.
  //     So `render()` ran exactly once, at mount, and every hook inside it froze at its mount
  //     value for the life of the page.
  //
  // `registerBackgroundView` survived that only by accident: its documented idiom returns an
  // ELEMENT (`() => <Resync />`), so `Resync` had a fiber of its own underneath the memoized call
  // and kept re-rendering. The composer provider drivers — whose body IS the component holding
  // `useRows` — had no such fiber, and A24 measured all three of the catalogs plugin's providers
  // stuck at `phase: "synchronizing"`, `query: ""`, contributing 0 rows to `$`, `#` and `/`.
  //
  // `createElement(render)` fixes both tenants at once: the plugin's function becomes a component
  // INSTANCE with its own fiber, inside this boundary and its `<Suspense>`, so the compiler's
  // memoized element is created once while the component behind it re-renders on its own
  // subscriptions. A body that returns an element still works exactly as before — `Resync` is now
  // one fiber deeper — and a body that holds hooks directly now works too, which it did not.
  //
  // NOTE FOR ANYONE EDITING THE CALLERS: `safePluginBackgroundRender` returns a hook-FREE closure
  // that only builds an element, so `PluginBackgroundSurface` may keep calling it. The rule this
  // line enforces is narrower and absolute: no function that may contain HOOKS is ever invoked
  // during another component's render.
  return <>{createElement(render)}</>;
}

/**
 * Wrap an always-mounted, render-nothing plugin subtree (SDK 0.3.0 `registerBackgroundView`, and
 * the composer provider drivers). Returns a component the host mounts; it renders nothing.
 */
export function safePluginBackgroundRender(input: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly surface: "background-view" | "composer-provider";
  readonly render: () => ReactNode;
}): () => ReactNode {
  const { pluginId, pluginName, render, surface } = input;
  return () => createElement(PluginBackgroundBoundary, { pluginId, pluginName, render, surface });
}

function PluginBackgroundBoundary({
  pluginId,
  pluginName,
  render,
  surface,
}: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly render: () => ReactNode;
  readonly surface: "background-view" | "composer-provider";
}) {
  return (
    <RenderErrorBoundary
      // `null`, not a card: this surface owns no pixels, and the app shell is not the place to
      // draw a plugin's failure. The toast + problem row carry the attribution instead.
      fallback={() => null}
      onError={(error) => {
        flagPluginFault(pluginId);
        reportRenderFault({ pluginId, pluginName, surface, error });
      }}
    >
      <Suspense fallback={null}>
        <PluginBackgroundBody render={render} />
      </Suspense>
    </RenderErrorBoundary>
  );
}
