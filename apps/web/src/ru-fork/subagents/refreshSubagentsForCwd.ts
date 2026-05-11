// ru-fork: imperative refresh hook backing the `/refresh-subagents`
// composer command. Forces a fresh disk scan and invalidates the
// React Query cache so the popup updates immediately.

import type { QueryClient } from "@tanstack/react-query";

import { ensureLocalApi } from "../../localApi";

import { ruForkSubagentsQueryKeys } from "./useSubagentsForCwd";

export const refreshSubagentsForCwd = async (input: {
  readonly cwd: string | null;
  readonly queryClient: QueryClient;
}): Promise<void> => {
  const api = ensureLocalApi();
  const next = await api.server.refreshSubagentsForCwd({ cwd: input.cwd });
  input.queryClient.setQueryData(ruForkSubagentsQueryKeys.forCwd(input.cwd), next);
};
