// ru-fork: editor-side metadata + signature helpers for the `#agent`
// chip. Kept in an ru-fork-only file so ComposerPromptEditor.tsx
// stays a one-import per concern.

import type { ServerProviderSubagent } from "@t3tools/contracts";

import { formatProviderSubagentDisplayName } from "./providerSubagentSearch";

export interface ComposerSubagentMetadata {
  label: string;
  description: string | null;
}

export const subagentMetadataByName = (
  subagents: ReadonlyArray<ServerProviderSubagent>,
): ReadonlyMap<string, ComposerSubagentMetadata> =>
  new Map(
    subagents.map((agent) => [
      agent.name,
      {
        label: formatProviderSubagentDisplayName(agent),
        description: agent.description?.trim() ?? null,
      },
    ]),
  );

// Stable string used by hooks that need to bust caches when the agents
// list changes — parallels skillSignature in ComposerPromptEditor.tsx.
export const subagentSignature = (subagents: ReadonlyArray<ServerProviderSubagent>): string =>
  subagents
    .map((agent) =>
      [
        agent.name,
        agent.description ?? "",
        agent.scope,
        agent.color ?? "",
        (agent.tools ?? []).join(","),
        agent.path ?? "",
        agent.enabled ? "1" : "0",
      ].join(""),
    )
    .join("");
