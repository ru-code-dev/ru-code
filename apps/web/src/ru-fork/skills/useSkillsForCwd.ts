// ru-fork: React Query hook that fetches filesystem-scanned skills
// for the active chat's cwd. Powers the `$` composer popup and replaces
// the old `provider.skills` snapshot read.
//
// `cwd: null` returns globals only — covers the home screen and any
// virtual chat opened without a project picked yet.

import type { ServerProviderSkill } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ensureLocalApi } from "../../localApi";

export const ruForkSkillsQueryKeys = {
  all: ["ru-fork-skills"] as const,
  forCwd: (cwd: string | null) => ["ru-fork-skills", cwd] as const,
};

export interface SkillsForCwd {
  readonly global: ReadonlyArray<ServerProviderSkill>;
  readonly project: ReadonlyArray<ServerProviderSkill>;
}

const EMPTY: SkillsForCwd = { global: [], project: [] };

const DEFAULT_STALE_MS = 60_000;

export function skillsForCwdQueryOptions(input: { cwd: string | null; enabled?: boolean }) {
  return queryOptions({
    queryKey: ruForkSkillsQueryKeys.forCwd(input.cwd),
    queryFn: async (): Promise<SkillsForCwd> => {
      const api = ensureLocalApi();
      return api.server.listSkillsForCwd({ cwd: input.cwd });
    },
    enabled: input.enabled ?? true,
    staleTime: DEFAULT_STALE_MS,
    placeholderData: (previous) => previous ?? EMPTY,
  });
}

export function useSkillsForCwd(cwd: string | null) {
  return useQuery(skillsForCwdQueryOptions({ cwd }));
}
