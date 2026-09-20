// ru-code v2: the ONE way plugin React is mounted (architecture.md §2.1, §6).
//
// v1 had five wrapping helpers — panel icon, panel body, background view, provider driver, slot —
// each with its own fallback, its own report and its own Suspense, 707 lines in total, and it
// still missed one surface (a composer row's icon was rendered raw, so a throwing glyph took the
// whole composer down). v2 has exactly one component and one rule:
//
//   the host renders a plugin component AS AN ELEMENT (`createElement(render)`, never `render()`),
//   inside an error boundary, a `<Suspense>` and the plugin's own CSS scope, and a throw or a hang
//   costs that surface only.
//
// `createElement` and not a call is the load-bearing half: `<Boundary>{render()}</Boundary>`
// evaluates `render` OUTSIDE the boundary, so a synchronous throw escapes it — which is exactly
// the fixture v1's audit used to blank the app.
//
// The router-root net at the bottom is kept from v1: React routes some faults past every boundary
// below it (an unmount-phase throw, a fault raised in a commit no boundary is alive for), and
// without it the user got «Something went wrong» for the whole app with nothing naming the plugin.

import { L } from "@ru-code/localization";
import { TriangleAlertIcon } from "lucide-react";
import {
  Component,
  Suspense,
  createElement,
  useEffect,
  type ComponentType,
  type ReactNode,
} from "react";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";

import { reportPluginProblem } from "./problems";
import { pluginDisplayName } from "./status";

/** One report per plugin surface, however many times React re-renders it. */
const reportedSurfaces = new Set<string>();

/**
 * How long a plugin surface may stay SUSPENDED before the fault is reported.
 *
 * The same budget the loader gives a plugin's `activate()`: long enough that a genuinely slow
 * dynamic import resolves first, short enough that a loader which will never settle is named while
 * the user is still looking at the app. React has no "still suspended" callback, so time is the
 * only honest signal — the fallback is mounted for exactly as long as the surface is suspended.
 */
export const PLUGIN_SUSPENSE_REPORT_MS = 10_000;

/**
 * How recently a plugin boundary must have caught for the router root to blame the plugin.
 *
 * The evidence is this flag and nothing else. v1 round 2 asked instead whether a plugin panel was
 * OPEN, which blamed a plugin for every app-level crash that coincided with its panel and stayed
 * silent for a fault raised at boot with no panel open at all.
 */
export const PLUGIN_FAULT_ATTRIBUTION_MS = 5_000;

/** The last fault a PLUGIN boundary caught — the only evidence the router root accepts. */
let lastPluginFault: { readonly id: string; readonly at: number } | null = null;

/** Plugins already recovered from at the router root; a SECOND crash shows the card. */
const recoveredPlugins = new Set<string>();

/** Test seam. */
export function resetPluginRenderFaults(): void {
  reportedSurfaces.clear();
  recoveredPlugins.clear();
  lastPluginFault = null;
}

const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  return firstLine === "" ? L("render failed", "ошибка отрисовки") : firstLine;
};

/** Report a render fault once per `(plugin, surface)`. Never throws. */
export function reportPluginRenderFault(input: {
  readonly pluginId: string;
  readonly surface: string;
  readonly error: unknown;
}): void {
  const key = `${input.pluginId}:${input.surface}`;
  if (reportedSurfaces.has(key)) return;
  reportedSurfaces.add(key);
  const name = pluginDisplayName(input.pluginId);
  reportPluginProblem({
    kind: "error",
    pluginId: input.pluginId,
    // The CATEGORY, so one toast per plugin per surface however many times React re-renders it.
    code: `render:${input.surface}`,
    title: L(`Plugin "${name}" failed to render`, `Плагин «${name}» не смог отрисоваться`),
    detail: `${input.surface}: ${describe(input.error)}`,
  });
}

/** The placeholder a suspended plugin surface shows, and the timer that names it if it never ends. */
function PluginPending({
  pluginId,
  surface,
  quiet,
}: {
  readonly pluginId: string;
  readonly surface: string;
  readonly quiet: boolean;
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      reportPluginRenderFault({
        pluginId,
        surface,
        error: new Error(L("never finished loading", "так и не загрузилось")),
      });
    }, PLUGIN_SUSPENSE_REPORT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pluginId, surface]);
  if (quiet) return null;
  return (
    <div
      className="flex items-center gap-2 p-4 text-xs text-muted-foreground"
      data-slot="plugin-surface-pending"
      data-plugin-id={pluginId}
    >
      {L("Loading…", "Загрузка…")}
    </div>
  );
}

/** The card a failed plugin surface shows in its own place. The rest of the app is untouched. */
function PluginFailed({ pluginId, error }: { readonly pluginId: string; readonly error: unknown }) {
  const name = pluginDisplayName(pluginId);
  return (
    <div
      className="flex min-w-0 items-start gap-2 p-4 text-sm"
      data-slot="plugin-surface-failed"
      data-plugin-id={pluginId}
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="font-medium wrap-break-word">
          {L(`Plugin "${name}" failed to render`, `Плагин «${name}» не смог отрисоваться`)}
        </div>
        <div className="mt-1 text-xs wrap-break-word text-muted-foreground select-text">
          {describe(error)}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {L(
            "The rest of the app is unaffected. Remove the plugin folder and restart to uninstall it.",
            "На остальное приложение это не влияет. Чтобы удалить плагин, удалите его папку и перезапустите приложение.",
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The plugin's component, as an ELEMENT.
 *
 * v1 had a guard here that refused a `render` returning a Promise, because its seam was a FUNCTION
 * the host called: the thenable came back in the host's hand and could be rejected on the spot.
 * v2's seam is a `ComponentType`, so REACT calls it — a component that returns a promise is
 * `use()`d by React and suspends. That is not refusable at this seam, and it does not need to be:
 * the `<Suspense>` below contains it, the app stays up, and the placeholder's 10 s timer names the
 * plugin. A guard that cannot fire would have been a claim this file does not keep.
 */
function PluginBody({ render }: { readonly render: ComponentType }) {
  return createElement(render);
}

/**
 * The CSS scope every plugin surface is mounted inside (decision V2-14).
 *
 * The SDK nests a plugin's whole stylesheet under `[data-plugin-root="<id>"]`, so this attribute is
 * the other half of the contract: without it a plugin's sheet matches NOTHING, and without the sheet
 * being nested the plugin's rules reach app DOM. Both halves ship together.
 *
 * `display: contents` as an INLINE STYLE, not the `contents` utility class: the class only exists in
 * the page when the APP's own Tailwind scan happens to have emitted it, and "the app happens to
 * provide it" is precisely the defect class V2-14 closes (analytics R1). A layout wrapper that
 * silently becomes `display: block` would move every plugin surface one box deeper.
 */
const PLUGIN_ROOT_STYLE = { display: "contents" } as const;

/**
 * The boundary's fallback, as a factory rather than an inline arrow.
 *
 * `react/no-unstable-nested-components` refuses a function that builds a component inside a prop,
 * and the point of that rule — an identity that changes every render — is real here too:
 * `RenderErrorBoundary` reads `fallback` only once it has already caught, so a fresh closure costs
 * nothing, but keeping the shape at module scope keeps it obvious.
 */
const pluginFailedFallback =
  (pluginId: string) =>
  (error: unknown): ReactNode =>
    createElement(PluginFailed, { pluginId, error });

export interface PluginSurfaceProps {
  readonly pluginId: string;
  /** The seam this component came from — `page`, `panel`, `background`. Names the report. */
  readonly surface: string;
  readonly render: ComponentType;
  /** `true` for a surface that draws nothing anyway (background): no visible placeholder. */
  readonly quiet?: boolean;
}

/**
 * Mount one plugin component. THE only place the host renders plugin React.
 *
 * A throw degrades to {@link PluginFailed} and reports once; a suspension shows a placeholder and
 * reports if it never resolves; either way nothing reaches another plugin or the app.
 */
export function PluginSurface({ pluginId, surface, render, quiet = false }: PluginSurfaceProps) {
  return (
    <RenderErrorBoundary
      fallback={pluginFailedFallback(pluginId)}
      onError={(error) => {
        lastPluginFault = { id: pluginId, at: Date.now() };
        reportPluginRenderFault({ pluginId, surface, error });
      }}
    >
      {/* The Suspense wraps the BODY, not just the element: anything inside the plugin's own tree
          may suspend too — a `lazy` child, a `use()` of a promise. */}
      <Suspense fallback={<PluginPending pluginId={pluginId} surface={surface} quiet={quiet} />}>
        {/* Inside the Suspense and around the BODY only: the two fallbacks above are HOST markup
            written in the app's own utilities, and a plugin sheet scoped to this element must not
            be able to restyle the card that reports the plugin's own failure. */}
        <div data-plugin-root={pluginId} style={PLUGIN_ROOT_STYLE}>
          <PluginBody render={render} />
        </div>
      </Suspense>
    </RenderErrorBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The slot boundary and the router-root net
// ─────────────────────────────────────────────────────────────────────────────────────────────

type SlotBoundaryState = {
  readonly failed: boolean;
  readonly error: unknown;
  /** What the slot held when it caught, so the NEXT children render instead of being swallowed. */
  readonly caughtOn?: ReactNode;
};

/**
 * The last net UNDER the router: a plugin surface whose fault escaped {@link PluginSurface} — an
 * error thrown while React was unmounting it, for instance — is caught here so the slot renders
 * nothing instead of taking its host component down.
 *
 * A class component because that is the only thing React gives us for `getDerivedStateFromError`,
 * and it is deliberately NOT `RenderErrorBoundary`: this one renders `null`, never a card, because
 * the card was already shown by the surface below it.
 */
export interface PluginSlotBoundaryProps {
  /** `null` when the slot currently holds a BUILT-IN surface: catch, but blame nobody. */
  readonly pluginId: string | null;
  /** Called after a catch — the panel host uses it to close the slot it just emptied. */
  readonly onFault?: (() => void) | undefined;
  readonly children: ReactNode;
}

export class PluginSlotBoundary extends Component<PluginSlotBoundaryProps, SlotBoundaryState> {
  override state: SlotBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): SlotBoundaryState {
    return { failed: true, error };
  }

  /**
   * Recover when the slot is given something ELSE.
   *
   * The slot is mounted UNCONDITIONALLY and outlives what it holds, so a catch must not wedge it
   * empty for the rest of the session. Derived from props rather than reset from
   * `componentDidUpdate`, which would cost a second commit on every recovery.
   */
  static getDerivedStateFromProps(
    props: PluginSlotBoundaryProps,
    state: SlotBoundaryState,
  ): SlotBoundaryState | null {
    return state.failed && state.caughtOn !== props.children
      ? { failed: false, error: null }
      : null;
  }

  override componentDidCatch(error: unknown): void {
    this.setState({ caughtOn: this.props.children });
    const { pluginId } = this.props;
    if (pluginId !== null) {
      lastPluginFault = { id: pluginId, at: Date.now() };
      reportPluginRenderFault({ pluginId, surface: "slot", error });
    }
    this.props.onFault?.();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Which plugin, if any, the router's error card should blame — and recover from instead of showing.
 *
 * Only a fault a PLUGIN boundary caught within {@link PLUGIN_FAULT_ATTRIBUTION_MS} counts, and only
 * the first one per plugin: a second crash from the same plugin is an app that is genuinely broken
 * and must show the card.
 */
export function pluginCrashCandidate(): string | null {
  const fault = lastPluginFault;
  if (fault === null) return null;
  if (Date.now() - fault.at > PLUGIN_FAULT_ATTRIBUTION_MS) return null;
  if (recoveredPlugins.has(fault.id)) return null;
  return fault.id;
}

/** Name the plugin once and let the router reset. Guarded per plugin by `pluginCrashCandidate`. */
export function recoverFromPluginCrash(pluginId: string, error: unknown): void {
  recoveredPlugins.add(pluginId);
  lastPluginFault = null;
  reportPluginRenderFault({ pluginId, surface: "app", error });
}
