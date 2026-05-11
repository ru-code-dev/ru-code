// ru-fork: imperative refresh hook backing the `/refresh-skills`
// composer command. Forces a fresh disk scan and invalidates the
// React Query cache so the popup updates immediately.

import type { QueryClient } from "@tanstack/react-query";

import { ensureLocalApi } from "../../localApi";

import { ruForkSkillsQueryKeys } from "./useSkillsForCwd";

export async function refreshSkillsForCwd(input: {
  readonly cwd: string | null;
  readonly queryClient: QueryClient;
}): Promise<void> {
  const api = ensureLocalApi();
  const next = await api.server.refreshSkillsForCwd({ cwd: input.cwd });
  input.queryClient.setQueryData(ruForkSkillsQueryKeys.forCwd(input.cwd), next);
}
