// ru-fork: React Query hook that fetches filesystem-scanned subagents
// for the active chat's cwd. Powers the `#` composer popup.
//
// `cwd: null` returns builtin + user only — covers the home screen and any
// virtual chat opened without a project picked yet.

import type { ServerProviderSubagent } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ensureLocalApi } from "../../localApi";

export const ruForkSubagentsQueryKeys = {
  all: ["ru-fork-subagents"] as const,
  forCwd: (cwd: string | null) => ["ru-fork-subagents", cwd] as const,
};

export interface SubagentsForCwd {
  readonly builtin: ReadonlyArray<ServerProviderSubagent>;
  readonly user: ReadonlyArray<ServerProviderSubagent>;
  readonly project: ReadonlyArray<ServerProviderSubagent>;
}

const EMPTY: SubagentsForCwd = { builtin: [], user: [], project: [] };

const DEFAULT_STALE_MS = 60_000;

export const subagentsForCwdQueryOptions = (input: { cwd: string | null; enabled?: boolean }) =>
  queryOptions({
    queryKey: ruForkSubagentsQueryKeys.forCwd(input.cwd),
    queryFn: async (): Promise<SubagentsForCwd> => {
      const api = ensureLocalApi();
      return api.server.listSubagentsForCwd({ cwd: input.cwd });
    },
    enabled: input.enabled ?? true,
    staleTime: DEFAULT_STALE_MS,
    placeholderData: (previous) => previous ?? EMPTY,
  });

export const useSubagentsForCwd = (cwd: string | null) =>
  useQuery(subagentsForCwdQueryOptions({ cwd }));
