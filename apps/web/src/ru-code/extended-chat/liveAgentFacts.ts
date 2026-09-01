// ru-code: W1 host adapter — the main chat's live agent registry (ChatView's
// `agentPanelModel`, already derived for `MessagesTimeline`) → the extended-chat
// package's `LiveAgentFacts` contract. The package matches a fact to a launch card by
// `taskId` = the launch result's `task_id:` = the registry row's id (RuntimeSubagent.id
// is qwen's own agent id), so a live thread's cards read the registry's status and
// progress first (concept §3 G2 priority 1, §9 A2); every agent not listed falls back
// to file evidence inside the package. Zero new server events.
import type {
  AgentPanelModel,
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  LiveAgentFact,
  LiveAgentFacts,
  LiveAgentStatus,
} from "@smart-tools/qwen-cli-extended-chat/web";

/**
 * The registry's eight statuses onto the contract's four: pending/waiting are still
 * running from the reader's side; IDLE (settled-ish, resumable) yields no fact at all —
 * the file speaks for it.
 *
 * INTERRUPTED → cancelled, NOT failed (deviates from impl-p-report §5's first guess, on
 * proof): a qwen background agent the user cancels reaches this registry as `interrupted`
 * — the poll reads qwen's `cancelled` as `stopped` ("a cancel is a STOP, not a failure",
 * apps/server/src/ru-code/qwen/background/backgroundPoll.ts:87-89) and the fold maps
 * `stopped` → `interrupted` (packages/client-runtime/src/state/subagentRuntime.ts:509),
 * which the Agents panel renders «Остановлен». Reading it as «ошибка» here would put a red
 * lie on the card the concept exists to remove; the registry's `error` text still rides
 * along, so a process that actually died keeps its reason on the card's second line.
 */
const toLiveStatus = (status: RuntimeSubagentStatus): LiveAgentStatus | null => {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "failed":
      return "failed";
    case "idle":
      return null;
  }
};

const toFact = (agent: RuntimeSubagent): LiveAgentFact | null => {
  // Only genuine `subagent` rows carry a launch-result task id; workflow rows have no
  // transcript counterpart to join.
  if (agent.kind !== "subagent") return null;
  const status = toLiveStatus(agent.status);
  if (status === null) return null;
  return {
    taskId: agent.id,
    status,
    progress: agent.progress,
    lastToolName: agent.lastToolName,
    error: agent.error,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
  };
};

/** Every subagent row of the panel model — direct agents plus workflow members. */
const panelRows = (model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> => [
  ...model.directAgents,
  ...model.workflows.flatMap((group) => [
    ...group.phases.flatMap((phase) => phase.members),
    ...group.unphasedMembers,
  ]),
];

/** `null` when nothing is known live — the package prop's default (file evidence only). */
export function deriveLiveAgentFacts(model: AgentPanelModel | null): LiveAgentFacts | null {
  if (model === null || !model.hasAgents) return null;
  const facts = panelRows(model).flatMap((agent) => {
    const fact = toFact(agent);
    return fact === null ? [] : [fact];
  });
  return facts.length > 0 ? facts : null;
}
