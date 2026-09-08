// ru-code (A22, SDK 0.3.0): the app-wide mount point for every plugin surface that draws nothing.
//
// TWO TENANTS, ONE MECHANISM (owner decision O3-b): `registerBackgroundView` views and the
// composer PROVIDER drivers. Both are plugin components that exist for their hooks and effects,
// both must be mounted whether or not any panel is open, and both must be inside the plugin's own
// error boundary — so they share one surface rather than growing two.
//
// WHERE IT IS MOUNTED. `routes/__root.tsx`, beside `AutoUpdateDriverMount` and the other
// render-nothing drivers the app already keeps above the router. That position is the requirement,
// not a preference: a view mounted inside `AppSidebarLayout` would unmount on `/settings/*`, and
// one mounted in the panel host would only run while a panel was open — which is the exact
// behaviour `registerBackgroundView` exists to avoid.
//
// IT RENDERS NOTHING, ALWAYS. Every child returns `null`, so this component contributes no DOM at
// all — the cost is the render pass, which is why the caps are 2 background views per plugin and
// 2 providers per trigger per plugin.

import { L } from "@ru-code/localization";
import { memo, useEffect } from "react";

import { usePluginBackgroundViews, type PluginBackgroundViewEntry } from "./backgroundViews";
import {
  clearProviderRows,
  publishPrimedCommandSlugs,
  publishProviderRows,
  toProviderMenuItem,
  useActiveComposerQuery,
  useComposerProviders,
  MAX_COMPOSER_PROVIDER_ROWS,
  type RegisteredComposerProvider,
} from "./composerProviders";
import { reportPluginProblem } from "./problems";
import { pluginDisplayName } from "./status";

/**
 * One `registerBackgroundView` subtree.
 *
 * `entry.render` was already wrapped in the plugin's boundary + `<Suspense>` by `hostApi.ts`, so
 * this is a mount, not a guard.
 *
 * CALLING IT HERE IS SAFE, and it is the only kind of call that is: what `safePluginBackgroundRender`
 * returns is a hook-FREE closure that does nothing but build the boundary element. The plugin's own
 * body — the function that may hold hooks — is mounted as a component by `PluginBackgroundBody`,
 * which is where A24's H1 was and where the rule is written down.
 */
const BackgroundView = memo(function BackgroundView({
  entry,
}: {
  readonly entry: PluginBackgroundViewEntry;
}) {
  return <>{entry.render()}</>;
});

/**
 * One composer provider's invisible driver: calls the plugin's `useRows(query)` and publishes the
 * result into the store `ChatComposer` reads.
 *
 * THE CALL IS UNCONDITIONAL. `useRows` is a HOOK, so it must run on every render of this
 * component, in the same order, whether or not its trigger is the one the menu has open. Skipping
 * it while the menu is closed would violate the rules of hooks the FIRST time the menu opened, and
 * plugin hooks are the ones least likely to survive that. What varies is the ARGUMENT: `""` when
 * this provider's trigger is not the active one, which is also the argument the submit guard wants
 * for a `command` provider (plan §2.5.4, §6 P5), so the always-on case is not waste.
 *
 * "Every render of this component" is the load-bearing half, and it was the false half until
 * A24-fix: see `composerProviderDriverBody` and `renderSafety.tsx`'s `PluginBackgroundBody`.
 */
const ComposerProviderDriver = memo(function ComposerProviderDriver({
  entry,
}: {
  readonly entry: RegisteredComposerProvider;
}) {
  return <>{entry.driver()}</>;
});

/**
 * The body of one driver — the COMPONENT the plugin boundary mounts.
 *
 * Built here and wrapped by `composerRegistry.ts`, so a throw inside `useRows` lands on the
 * PLUGIN's boundary rather than on this file's.
 *
 * IT IS A COMPONENT, AND IT IS MOUNTED (A24-fix, A24 finding H1). What this factory returns is
 * mounted by `PluginBackgroundBody` as `createElement(body)`, which is what gives every provider
 * its OWN fiber: its own hook list, its own subscriptions, its own re-renders, independent of the
 * sibling drivers and of the host component that holds them. It used to be invoked as a plain
 * function during the host's render instead — so its hooks lived on the host's fiber, and the
 * React Compiler's memoization of that call meant they ran exactly once, at mount, forever.
 *
 * THE PUBLISH HAPPENS IN AN EFFECT, NOT IN RENDER. `useRows` has to be called during render — it
 * is a hook — but writing the result into the store during render would be a store update while
 * another component (`ChatComposer`, subscribed through `useSyncExternalStore`) is rendering, which
 * is the "Cannot update a component while rendering a different component" warning and, worse, a
 * tearing hazard between the menu the composer derived and the rows it derived it from. So: compute
 * in render, publish in an effect. `publishProviderRows` compares field-wise, so the effect running
 * on every render costs one comparison and no re-render once the rows have settled.
 */
export function composerProviderDriverBody(entry: {
  readonly key: string;
  readonly pluginId: string;
  readonly trigger: RegisteredComposerProvider["trigger"];
  readonly useRows: (query: string) => ReadonlyArray<unknown>;
}): () => null {
  return function ProviderRows() {
    const active = useActiveComposerQuery();
    // `""` when another trigger's menu is open (or none is): see the note on
    // `ComposerProviderDriver`. The hook always runs; only its argument changes.
    const query = active.trigger === entry.trigger ? active.query : "";
    const rows = entry.useRows(query);
    const list = Array.isArray(rows) ? rows : [];
    const overflowed = list.length > MAX_COMPOSER_PROVIDER_ROWS;
    // The cap DROPS the excess and keeps the provider. A menu is a list a human reads, and a
    // runaway `useRows` returning an unfiltered catalog on every keystroke must cost its own tail,
    // never the picker.
    const items = list
      .slice(0, MAX_COMPOSER_PROVIDER_ROWS)
      .map((row) => toProviderMenuItem(entry.pluginId, entry.trigger, row as never))
      .filter((item) => item !== null);

    useEffect(() => {
      publishProviderRows(entry.key, items);
      // P5: a `/name` typed by hand, with the menu never opened, still has to pass the submit
      // guard. A `command` provider is driven at the EMPTY query whenever no `/` menu is open, so
      // the slug set is primed from the moment the plugin activates rather than from the first
      // time the user opens the menu.
      if (entry.trigger === "command" && query === "") {
        publishPrimedCommandSlugs(
          entry.key,
          items.map((item) => item.name.toLowerCase()),
        );
      }
    });

    useEffect(() => {
      if (!overflowed) return;
      reportPluginProblem({
        kind: "error",
        pluginId: entry.pluginId,
        // One problem per plugin per category, however many keystrokes overflow (R3-H4).
        code: "composer-provider-rows",
        title: L(
          `Plugin "${pluginDisplayName(entry.pluginId)}" returned too many composer rows`,
          `Плагин «${pluginDisplayName(entry.pluginId)}» вернул слишком много строк композера`,
        ),
        detail: L(
          `at most ${String(MAX_COMPOSER_PROVIDER_ROWS)} rows per query; the rest are ignored`,
          `не более ${String(MAX_COMPOSER_PROVIDER_ROWS)} строк на запрос; остальные игнорируются`,
        ),
      });
    }, [overflowed]);

    // Unmount only: a provider whose driver goes away must not leave its rows in the menu.
    useEffect(
      () => () => {
        clearProviderRows(entry.key);
      },
      [],
    );

    return null;
  };
}

/**
 * Every render-nothing plugin surface, mounted app-wide.
 *
 * Keyed by the registration key, so a plugin registering a second view never remounts the first.
 */
export const PluginBackgroundSurface = memo(function PluginBackgroundSurface() {
  const views = usePluginBackgroundViews();
  const providers = useComposerProviders();
  return (
    <>
      {views.map((entry) => (
        <BackgroundView entry={entry} key={entry.key} />
      ))}
      {providers.map((entry) => (
        <ComposerProviderDriver entry={entry} key={entry.key} />
      ))}
    </>
  );
});
