// ru-code S76 (V2-59): the WEB host's half of `ctx.query` — WIRING ONLY.
//
// The rule — read on subscribe, again on every connected generation, one read in flight, ONE
// result each settled read replaces (V2-60: an equal `ready` is a no-op, `failed` → `ready` is not),
// a failure retried on the next ready edge or `refresh()` only, disposal on the last unsubscribe,
// the per-plugin live cap — is `@smart-tools/plugin-sdk/state` `makeQueryHost`, written once and run
// by this host, the playground and the fakes alike. What this file supplies is what only the app
// has: this plugin's `invoke` as a READ (which parks while the socket is down, V2-35, and is not
// held for the tab's state the way a command is, S104), `ctx.connection`'s
// own signal, and the V2-42 problem channel.

import type { QuerySignal, Signal, PluginConnection, WebCtx } from "@smart-tools/plugin-sdk/host";
import { makeQueryHost, type QueryHost } from "@smart-tools/plugin-sdk/state";
import { L } from "@ru-code/localization";

import { pluginConnectionSignal } from "./connectionAtom";
import { reportPluginProblem } from "./problems";
import { makePluginRead } from "./rpcPort";

export type PluginQueryDeps = {
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
  readonly connection: Signal<PluginConnection>;
};

/** The `query` member of one plugin's ctx — one query host per ctx, so the cap is per plugin. */
export function makePluginQuery(
  pluginId: string,
  deps: PluginQueryDeps = {
    invoke: makePluginRead(pluginId),
    connection: pluginConnectionSignal(),
  },
): { readonly query: WebCtx["query"]; readonly host: QueryHost } {
  const host = makeQueryHost({
    invoke: deps.invoke,
    connection: deps.connection,
    report: (code, detail) => {
      reportPluginProblem({
        kind: "error",
        pluginId,
        code,
        title:
          code === "cap:queries"
            ? L(
                `Plugin "${pluginId}" holds too many live queries`,
                `Плагин «${pluginId}» держит слишком много активных запросов`,
              )
            : L(
                `Plugin "${pluginId}" has a query listener that throws`,
                `У плагина «${pluginId}» слушатель запроса выбрасывает исключение`,
              ),
        detail,
      });
    },
  });
  return {
    query: <T>(method: string, input?: Parameters<WebCtx["query"]>[1]): QuerySignal<T> =>
      host.query<T>(method, input),
    host,
  };
}
