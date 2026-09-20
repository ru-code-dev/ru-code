// ru-code v2 (decision V2-4): the body of the ONE host-owned plugin route.
//
// `/plugins/$pluginId/$pageId` is a normal app route — `routes/plugins.$pluginId.$pageId.tsx` is
// three lines that hand the two params to this component — so a plugin page gets the app's whole
// chrome for free: the sidebar, the titlebar inset, the theme, the router. v1 had no route at all,
// which is why the analytics dashboard was regressed into a 960 px panel; the owner's verdict on
// that was "regression is unacceptable".
//
// The page's component is mounted the same way every other plugin component is: as an ELEMENT,
// inside `PluginSurface`, inside one more slot boundary. A page that throws shows its own card
// with the app still around it.

import { L } from "@ru-code/localization";
import { useParams } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PluginIcon } from "./PluginIcon";
import { PluginSlotBoundary, PluginSurface } from "./PluginSurface";
import { usePluginLoadPass, type PluginLoadPass } from "./registry";
import { usePluginPages } from "./seams";

/** `/plugins/<pluginId>/<pageId>` for a page a plugin declared. */
export const pluginPagePath = (pluginId: string, pageId: string): string =>
  `/plugins/${pluginId}/${pageId}`;

/**
 * The app's own breadcrumb, from the `Page` the plugin declared (V2-15, closing analytics R2).
 *
 * The data was already in hand — `title` and `icon` are on the seam — and without this a plugin page
 * was the only whole-area surface in the app with no titlebar row at all. A plugin cannot supply it:
 * rendering the app's breadcrumb component is exactly the host coupling v2 removed, and hand-rolling
 * a look-alike would be a plugin imitating app chrome.
 *
 * HOST MARKUP, deliberately OUTSIDE `[data-plugin-root]` (see `PluginSurface`): the plugin's scoped
 * stylesheet must not be able to restyle the app's own chrome, and the title is the plugin's only
 * contribution here — a string the seam already capped at `MAX_LABEL_LENGTH`.
 */
function PluginPageHeader({ title, icon }: { readonly title: string; readonly icon?: string }) {
  // The two shapes every whole-area page in this app has (`UsagePage`, `_chat.pull-requests`): a
  // topbar row in the browser, and the OS titlebar's own drag region in Electron. Copied rather
  // than abstracted, because that is how the app spells it today and a plugin page must look like
  // a page of the app rather than like a plugin.
  const content = (
    <WorkspaceBreadcrumb ariaLabel={L("Plugin page", "Страница плагина")}>
      <WorkspaceBreadcrumbItem current className="gap-2">
        <PluginIcon name={icon} className="size-4 shrink-0 text-icon-muted" />
        <span className="truncate" data-testid="plugin-page-title">
          {title}
        </span>
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
  return isElectron ? (
    <div
      className={cn(
        "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-slot="plugin-page-header"
    >
      {content}
    </div>
  ) : (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-slot="plugin-page-header"
    >
      {content}
    </header>
  );
}

function PluginPageMissing({
  pluginId,
  pageId,
}: {
  readonly pluginId: string;
  readonly pageId: string;
}) {
  return (
    <div className="p-6 text-sm text-muted-foreground" data-slot="plugin-page-missing">
      {L(
        `No page "${pageId}" is installed for plugin "${pluginId}".`,
        `Страница «${pageId}» плагина «${pluginId}» не установлена.`,
      )}
    </div>
  );
}

/** The app's ordinary pending line, while the host has not yet asked whether this page exists. */
function PluginPagePending() {
  return (
    <div className="p-6 text-sm text-muted-foreground" data-slot="plugin-page-pending">
      {L("Loading…", "Загрузка…")}
    </div>
  );
}

/**
 * The line for a pass that FINISHED without a plugin list (S43 F2).
 *
 * Not «не установлена»: on this pass the host never read the list, so whether this plugin is
 * installed is precisely what it does not know — asserting it would be the S40 Q2 defect with the
 * words changed. What it DOES know is true down all three `"unreadable"` paths and is what the
 * loader itself logs at each of them: the list could not be read, so no plugins are loaded
 * (`loadPlugins.ts` — a non-OK `manifests.json`, an unreachable server, a payload that did not
 * decode). That is a terminal sentence about the host, not a claim about the plugin.
 */
function PluginPageUnreadable() {
  return (
    <div className="p-6 text-sm text-muted-foreground" data-slot="plugin-page-unreadable">
      {L(
        "The plugin list could not be read, so no plugins are loaded.",
        "Не удалось прочитать список плагинов — плагины не загружены.",
      )}
    </div>
  );
}

/** What this route can honestly say about `$pluginId/$pageId` on THIS render. */
export type PluginPageState = "found" | "missing" | "pending" | "unreadable";

/**
 * "Not installed" is a STATEMENT OF FACT, so it may only be made once the host has asked.
 *
 * The page list is empty twice over — before the loader ran, and when nothing is installed — and
 * only `usePluginLoadPass()` tells the two apart (S15 A1). Plugins are imported after the first
 * paint and a slow one has a 10 s budget (`loadPlugins.ts`), so without this gate a footer-nav or
 * bookmarked plugin page told the user their installed plugin was "not installed" and then
 * replaced the sentence with the page.
 *
 * THE GATE IS "HAS THE LOADER FINISHED", NOT "WHICH ANSWER DID IT FINISH WITH" (S43 F2). This was
 * `pass === "read" ? "missing" : "pending"`, which sent the TERMINAL `"unreadable"` pass to the
 * waiting state — and nothing re-runs the loader (`registry.ts`), so «Загрузка…» was a promise
 * that this resolves made on a pass that says it never will. `tabSurfaces.tsx` and `slots.tsx` keep
 * the stricter `"read"` rule because they answer a different question: sitting a pass out means
 * NOT DELETING the user's persisted state, which costs nothing and can safely last forever. A
 * ROUTE has to draw something, so each of the three passes gets its own honest line.
 *
 * Pure and exported because `apps/web`'s unit project runs in the NODE environment — a rule that
 * lives only inside a component is a rule only the e2e suite can check.
 */
export const pluginPageState = (entryFound: boolean, pass: PluginLoadPass): PluginPageState =>
  entryFound
    ? "found"
    : pass === "pending"
      ? "pending"
      : pass === "read"
        ? "missing"
        : "unreadable";

/**
 * Render the page `$pluginId/$pageId` names.
 *
 * The lookup is REACTIVE (`usePluginPages`), which is what makes a direct URL load work: plugins
 * are imported after the first paint, so on a cold navigation the list is still empty here. The
 * route is never blocked on the loader — that is the design that let one hanging plugin
 * white-screen the app — so it shows the app's ordinary pending line only while the loader is
 * still running, and draws an answer the moment it finishes ({@link pluginPageState}).
 */
export function PluginPage() {
  const { pluginId, pageId } = useParams({ from: "/plugins/$pluginId/$pageId" });
  const pages = usePluginPages();
  const pass = usePluginLoadPass();
  const entry = pages.find((page) => page.pluginId === pluginId && page.value.id === pageId);
  const state = pluginPageState(entry !== undefined, pass);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-y-auto overscroll-y-none bg-background text-foreground isolate">
      {entry === undefined ? (
        // Three answers, one per pass: still asking, asked and this page is not installed, or
        // finished without ever getting a list to check against.
        state === "pending" ? (
          <PluginPagePending />
        ) : state === "unreadable" ? (
          <PluginPageUnreadable />
        ) : (
          <PluginPageMissing pluginId={pluginId} pageId={pageId} />
        )
      ) : (
        <>
          <PluginPageHeader
            title={entry.value.title}
            {...(entry.value.icon === undefined ? {} : { icon: entry.value.icon })}
          />
          <PluginSlotBoundary pluginId={entry.pluginId}>
            <PluginSurface
              pluginId={entry.pluginId}
              render={entry.value.render}
              surface={`page:${entry.value.id}`}
            />
          </PluginSlotBoundary>
        </>
      )}
    </SidebarInset>
  );
}
