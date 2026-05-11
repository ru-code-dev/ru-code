import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory, basepath: string = "") {
  const queryClient = new QueryClient();

  return createRouter({
    routeTree,
    history,
    // ru-fork: prefix all internal routes when deployed under a
    // reverse-proxy sub-path. TanStack Router interprets undefined as
    // no prefix, so we only forward a non-empty value.
    ...(basepath.length > 0 ? { basepath } : {}),
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppAtomRegistryProvider, undefined, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
