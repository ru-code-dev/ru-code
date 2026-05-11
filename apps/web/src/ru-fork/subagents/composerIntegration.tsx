// ru-fork: composer/picker glue for the `#agent` chip. Keeps upstream
// files (ChatComposer, ComposerCommandMenu) limited to a small set of
// dispatch lines that re-sync cleanly. Everything substantive lives here.

import type { ServerProviderSubagent } from "@t3tools/contracts";

import type { ComposerCommandItem } from "../../components/chat/ComposerCommandMenu";
import type { SubagentsForCwd } from "./useSubagentsForCwd";
import {
  formatProviderSubagentDisplayName,
  formatProviderSubagentInstallSource,
  searchProviderSubagents,
} from "./providerSubagentSearch";

// ── ChatComposer ─────────────────────────────────────────────────────

// Project ▸ user ▸ builtin order: project agents win the picker rank when
// names collide.
export const flattenSubagentBuckets = (
  data: SubagentsForCwd | undefined,
): ServerProviderSubagent[] => [
  ...(data?.project ?? []),
  ...(data?.user ?? []),
  ...(data?.builtin ?? []),
];

export type SubagentComposerMenuItem = Extract<ComposerCommandItem, { type: "subagent" }>;

export const buildSubagentMenuItems = (
  subagents: ReadonlyArray<ServerProviderSubagent>,
  query: string,
): SubagentComposerMenuItem[] =>
  searchProviderSubagents(subagents, query).map((agent) => ({
    id: `subagent:${agent.scope}:${agent.name}`,
    type: "subagent" as const,
    subagent: agent,
    label: formatProviderSubagentDisplayName(agent),
    description: agent.description ?? `${agent.scope} agent`,
  }));

// `agent:name` wire format — server detects it (no name lookup needed)
// and injects the subagent system-reminder before sending to CLI. The
// chip's visual label stays human-friendly.
export const subagentInsertReplacement = (subagent: ServerProviderSubagent): string =>
  `agent:${subagent.name} `;

// ── ComposerCommandMenu ─────────────────────────────────────────────

// Distinct from the skill hexagon — uses a bot silhouette so the picker
// rows are visually distinguishable at a glance.
export const SubagentGlyph = (props: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.85"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className}
    aria-hidden="true"
  >
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

export const formatSubagentSourceLabel = (item: ComposerCommandItem): string | null =>
  item.type === "subagent" ? formatProviderSubagentInstallSource(item.subagent) : null;

// Split the flat picker list into project/user/builtin buckets and return
// `ComposerCommandGroup[]`-shaped objects. Groups with empty buckets are
// omitted so the menu doesn't render empty headers.
export interface SubagentComposerCommandGroup {
  id: string;
  label: string;
  items: ComposerCommandItem[];
}

export const groupSubagentCommandItems = (
  items: ComposerCommandItem[],
): SubagentComposerCommandGroup[] => {
  if (items.length === 0) return [];
  const project: ComposerCommandItem[] = [];
  const user: ComposerCommandItem[] = [];
  const builtin: ComposerCommandItem[] = [];
  for (const item of items) {
    if (item.type !== "subagent") continue;
    if (item.subagent.scope === "project") project.push(item);
    else if (item.subagent.scope === "user") user.push(item);
    else builtin.push(item);
  }
  const groups: SubagentComposerCommandGroup[] = [];
  if (project.length > 0) groups.push({ id: "subagents-project", label: "Проект", items: project });
  if (user.length > 0) groups.push({ id: "subagents-user", label: "Личные", items: user });
  if (builtin.length > 0) {
    groups.push({ id: "subagents-builtin", label: "Встроенные", items: builtin });
  }
  return groups;
};
