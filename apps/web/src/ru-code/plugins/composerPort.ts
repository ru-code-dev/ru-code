// ru-code: the composer half of `WebPluginHost`, as a PORT A6 fills in.
//
// mvp-plan splits the web work in two: A3 owns the spine (import map, loader, host object,
// panel registry) and A6 owns the composer seams (`ComposerCommandMenu` `plugin-item`, the
// three `ChatComposer` trigger branches, `useComposerDraftStore.addReviewComment`). The host
// object handed to a plugin must carry the FINAL SDK shape from day one — a plugin built
// against `host.composer.registerItem` must not have to change when A6 lands — so the shape
// lives here and the behaviour is swapped in by `setComposerPort(...)`.
//
// The defaults log and ignore rather than throw: a plugin that registers a composer item on a
// build where the seam is not wired yet must still activate its panel (mvp-plan guardrail 8).

import type {
  ComposerTargetHandle,
  PluginComposer,
  PluginComposerCard,
  PluginComposerItem,
  PluginComposerProvider,
} from "@smart-tools/plugin-sdk/host";

export interface ComposerPort {
  registerItem(pluginId: string, item: PluginComposerItem): void;
  /** ru-code (A22, SDK 0.3.0): the dynamic row source. See `composerProviders.ts`. */
  registerProvider(pluginId: string, provider: PluginComposerProvider): void;
  attach(pluginId: string, card: PluginComposerCard): void;
  detach(pluginId: string, cardId: string): void;
  useActiveTarget(): unknown | null;
}

const notWired = (pluginId: string, what: string): void => {
  console.warn(
    `[plugins] ${pluginId}: composer.${what} was called but the composer seam is not wired in this build (arrives with A6)`,
  );
};

const defaultPort: ComposerPort = {
  registerItem: (pluginId) => notWired(pluginId, "registerItem"),
  registerProvider: (pluginId) => notWired(pluginId, "registerProvider"),
  attach: (pluginId) => notWired(pluginId, "attach"),
  detach: (pluginId) => notWired(pluginId, "detach"),
  useActiveTarget: () => null,
};

let port: ComposerPort = defaultPort;

/** A6 calls this once, at module scope, from the composer seam it owns. */
export function setComposerPort(next: ComposerPort): void {
  port = next;
}

/** Test seam. */
export function resetComposerPort(): void {
  port = defaultPort;
}

/** The `composer` member of the host object handed to one plugin. */
export function makePluginComposer(pluginId: string): PluginComposer {
  return {
    registerItem: (item) => port.registerItem(pluginId, item),
    registerProvider: (provider) => port.registerProvider(pluginId, provider),
    attach: (card) => port.attach(pluginId, card),
    detach: (cardId) => port.detach(pluginId, cardId),
    // A HOOK: it must call through on every render, so it reads `port` at call time rather
    // than capturing it — A6 may install the real port after this closure was built.
    //
    // A13-pre made the SDK's return type a BRANDED opaque handle: a plugin may hold the value,
    // pass it back and compare it to `null`, and can read nothing off it. The app's real target
    // (`ComposerThreadTarget` — a draft id string or an `{ environmentId, threadId }` pair) is an
    // app detail that will change, so it is deliberately not part of the SDK contract. THIS is the
    // one place in `apps/**` that builds a `PluginComposer`, so this single cast is the whole
    // seam — exactly one place in the app knows the real shape.
    useActiveTarget: () => port.useActiveTarget() as ComposerTargetHandle | null,
  };
}
