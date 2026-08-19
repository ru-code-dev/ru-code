// ru-code: the Skills + Agents catalog WS RPC handlers, extracted out of ws.ts so the upstream
// file keeps only a tiny seam. The 39 handlers (13 skill + 13 agent + 13 command) are uniform — each authorizes
// via the host's `observeCatalogRpc` wrapper and forwards the decoded payload to the matching
// `*CatalogShape` method. `CATALOG_RPC_SCOPES` is the per-method auth-scope table
// auth/RpcAuthorization.ts merges into its permission table (reads → orchestration:read, mutations →
// orchestration:operate).

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import {
  AGENT_CATALOG_METHODS,
  type AgentCatalogError,
} from "@smart-tools/qwen-cli-agents-manager/contracts";
import type { AgentCatalogShape } from "@smart-tools/qwen-cli-agents-manager/server";
import { SKILL_CATALOG_METHODS } from "@smart-tools/qwen-cli-skill-manager/contracts";
import type { SkillCatalogShape } from "@smart-tools/qwen-cli-skill-manager/server";
import { COMMAND_CATALOG_METHODS } from "@smart-tools/qwen-cli-commands-manager/contracts";
import type { CommandCatalogShape } from "@smart-tools/qwen-cli-commands-manager/server";
import * as Effect from "effect/Effect";

// The skill + agent catalog errors are the SAME core `CatalogError` (host-agnostic factory);
// `SkillCatalogError`/`AgentCatalogError` are aliases. One is enough to type the wrapper.
type CatalogError = AgentCatalogError;

/** The host's per-call wrapper: authorize (mapping an auth failure into `CatalogError`) + trace.
 *  Kept in ws.ts because it closes over the upstream authorize/instrument helpers. */
export type ObserveCatalogRpc = <A, R>(
  method: string,
  aggregate: string,
  effect: Effect.Effect<A, CatalogError, R>,
) => Effect.Effect<A, CatalogError, R>;

/** Per-method required auth scope, merged into `auth/RpcAuthorization.ts`'s `RPC_REQUIRED_SCOPES`. Reads use the
 *  orchestration read scope, mutations the operate scope — the same scopes the rest of the app uses. */
export const CATALOG_RPC_SCOPES = {
  // Skills catalog — reads use the read scope, mutations use the operate scope.
  [SKILL_CATALOG_METHODS.serverSkillCatalogSnapshot]: AuthOrchestrationReadScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogRescan]: AuthOrchestrationReadScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogRescanItem]: AuthOrchestrationReadScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogAdd]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogConnect]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogDelete]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogDisable]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogDisconnectAll]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogReadFiles]: AuthOrchestrationReadScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogReadContent]: AuthOrchestrationReadScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogWriteFiles]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogSync]: AuthOrchestrationOperateScope,
  [SKILL_CATALOG_METHODS.serverSkillCatalogRemove]: AuthOrchestrationOperateScope,
  // Agents catalog — same read/operate split.
  [AGENT_CATALOG_METHODS.serverAgentCatalogSnapshot]: AuthOrchestrationReadScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogRescan]: AuthOrchestrationReadScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogRescanItem]: AuthOrchestrationReadScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogAdd]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogConnect]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogDelete]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogDisable]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogDisconnectAll]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogReadFiles]: AuthOrchestrationReadScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogReadContent]: AuthOrchestrationReadScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogWriteFiles]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogSync]: AuthOrchestrationOperateScope,
  [AGENT_CATALOG_METHODS.serverAgentCatalogRemove]: AuthOrchestrationOperateScope,
  // Commands catalog — same read/operate split.
  [COMMAND_CATALOG_METHODS.serverCommandCatalogSnapshot]: AuthOrchestrationReadScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogRescan]: AuthOrchestrationReadScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogRescanItem]: AuthOrchestrationReadScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogAdd]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogConnect]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogDelete]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogDisable]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogDisconnectAll]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogReadFiles]: AuthOrchestrationReadScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogReadContent]: AuthOrchestrationReadScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogWriteFiles]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogSync]: AuthOrchestrationOperateScope,
  [COMMAND_CATALOG_METHODS.serverCommandCatalogRemove]: AuthOrchestrationOperateScope,
} as const satisfies Readonly<Record<string, AuthEnvironmentScope>>;

/**
 * Build the 39 catalog RPC handlers. Each forwards the decoded RPC payload 1:1 to the matching
 * shape method (snapshot→getSnapshot, readFiles→readItemFiles, readContent→readItemContent,
 * writeFiles→writeItemFiles; the rest match by name) through `observeCatalogRpc`. Input types come
 * straight from the shape method parameters, so the map stays type-safe with no casts; ws.ts
 * spreads the result into its `WsRpcGroup.toLayer` handler object.
 */
export function buildCatalogRpcHandlers(deps: {
  readonly skillCatalog: SkillCatalogShape;
  readonly agentCatalog: AgentCatalogShape;
  readonly commandCatalog: CommandCatalogShape;
  readonly observeCatalogRpc: ObserveCatalogRpc;
}) {
  const { skillCatalog, agentCatalog, commandCatalog, observeCatalogRpc } = deps;
  const S = SKILL_CATALOG_METHODS;
  const A = AGENT_CATALOG_METHODS;
  const C = COMMAND_CATALOG_METHODS;
  return {
    // ── Skills (13) ──────────────────────────────────────────────────────────
    [S.serverSkillCatalogSnapshot]: (_input: unknown) =>
      observeCatalogRpc(S.serverSkillCatalogSnapshot, "skillCatalog", skillCatalog.getSnapshot()),
    [S.serverSkillCatalogRescan]: (_input: unknown) =>
      observeCatalogRpc(S.serverSkillCatalogRescan, "skillCatalog", skillCatalog.rescan()),
    [S.serverSkillCatalogRescanItem]: (input: Parameters<typeof skillCatalog.rescanItem>[0]) =>
      observeCatalogRpc(
        S.serverSkillCatalogRescanItem,
        "skillCatalog",
        skillCatalog.rescanItem(input),
      ),
    [S.serverSkillCatalogAdd]: (input: Parameters<typeof skillCatalog.add>[0]) =>
      observeCatalogRpc(S.serverSkillCatalogAdd, "skillCatalog", skillCatalog.add(input)),
    [S.serverSkillCatalogConnect]: (input: Parameters<typeof skillCatalog.connect>[0]) =>
      observeCatalogRpc(S.serverSkillCatalogConnect, "skillCatalog", skillCatalog.connect(input)),
    [S.serverSkillCatalogDelete]: (input: Parameters<typeof skillCatalog.delete>[0]) =>
      observeCatalogRpc(S.serverSkillCatalogDelete, "skillCatalog", skillCatalog.delete(input)),
    [S.serverSkillCatalogDisable]: (input: Parameters<typeof skillCatalog.disable>[0]) =>
      observeCatalogRpc(S.serverSkillCatalogDisable, "skillCatalog", skillCatalog.disable(input)),
    [S.serverSkillCatalogDisconnectAll]: (
      input: Parameters<typeof skillCatalog.disconnectAll>[0],
    ) =>
      observeCatalogRpc(
        S.serverSkillCatalogDisconnectAll,
        "skillCatalog",
        skillCatalog.disconnectAll(input),
      ),
    [S.serverSkillCatalogReadFiles]: (input: Parameters<typeof skillCatalog.readItemFiles>[0]) =>
      observeCatalogRpc(
        S.serverSkillCatalogReadFiles,
        "skillCatalog",
        skillCatalog.readItemFiles(input),
      ),
    [S.serverSkillCatalogReadContent]: (
      input: Parameters<typeof skillCatalog.readItemContent>[0],
    ) =>
      observeCatalogRpc(
        S.serverSkillCatalogReadContent,
        "skillCatalog",
        skillCatalog.readItemContent(input),
      ),
    [S.serverSkillCatalogWriteFiles]: (input: Parameters<typeof skillCatalog.writeItemFiles>[0]) =>
      observeCatalogRpc(
        S.serverSkillCatalogWriteFiles,
        "skillCatalog",
        skillCatalog.writeItemFiles(input),
      ),
    [S.serverSkillCatalogSync]: (input: Parameters<typeof skillCatalog.sync>[0]) =>
      observeCatalogRpc(S.serverSkillCatalogSync, "skillCatalog", skillCatalog.sync(input)),
    [S.serverSkillCatalogRemove]: (input: Parameters<typeof skillCatalog.remove>[0]) =>
      observeCatalogRpc(S.serverSkillCatalogRemove, "skillCatalog", skillCatalog.remove(input)),
    // ── Agents (13) ──────────────────────────────────────────────────────────
    [A.serverAgentCatalogSnapshot]: (_input: unknown) =>
      observeCatalogRpc(A.serverAgentCatalogSnapshot, "agentCatalog", agentCatalog.getSnapshot()),
    [A.serverAgentCatalogRescan]: (_input: unknown) =>
      observeCatalogRpc(A.serverAgentCatalogRescan, "agentCatalog", agentCatalog.rescan()),
    [A.serverAgentCatalogRescanItem]: (input: Parameters<typeof agentCatalog.rescanItem>[0]) =>
      observeCatalogRpc(
        A.serverAgentCatalogRescanItem,
        "agentCatalog",
        agentCatalog.rescanItem(input),
      ),
    [A.serverAgentCatalogAdd]: (input: Parameters<typeof agentCatalog.add>[0]) =>
      observeCatalogRpc(A.serverAgentCatalogAdd, "agentCatalog", agentCatalog.add(input)),
    [A.serverAgentCatalogConnect]: (input: Parameters<typeof agentCatalog.connect>[0]) =>
      observeCatalogRpc(A.serverAgentCatalogConnect, "agentCatalog", agentCatalog.connect(input)),
    [A.serverAgentCatalogDelete]: (input: Parameters<typeof agentCatalog.delete>[0]) =>
      observeCatalogRpc(A.serverAgentCatalogDelete, "agentCatalog", agentCatalog.delete(input)),
    [A.serverAgentCatalogDisable]: (input: Parameters<typeof agentCatalog.disable>[0]) =>
      observeCatalogRpc(A.serverAgentCatalogDisable, "agentCatalog", agentCatalog.disable(input)),
    [A.serverAgentCatalogDisconnectAll]: (
      input: Parameters<typeof agentCatalog.disconnectAll>[0],
    ) =>
      observeCatalogRpc(
        A.serverAgentCatalogDisconnectAll,
        "agentCatalog",
        agentCatalog.disconnectAll(input),
      ),
    [A.serverAgentCatalogReadFiles]: (input: Parameters<typeof agentCatalog.readItemFiles>[0]) =>
      observeCatalogRpc(
        A.serverAgentCatalogReadFiles,
        "agentCatalog",
        agentCatalog.readItemFiles(input),
      ),
    [A.serverAgentCatalogReadContent]: (
      input: Parameters<typeof agentCatalog.readItemContent>[0],
    ) =>
      observeCatalogRpc(
        A.serverAgentCatalogReadContent,
        "agentCatalog",
        agentCatalog.readItemContent(input),
      ),
    [A.serverAgentCatalogWriteFiles]: (input: Parameters<typeof agentCatalog.writeItemFiles>[0]) =>
      observeCatalogRpc(
        A.serverAgentCatalogWriteFiles,
        "agentCatalog",
        agentCatalog.writeItemFiles(input),
      ),
    [A.serverAgentCatalogSync]: (input: Parameters<typeof agentCatalog.sync>[0]) =>
      observeCatalogRpc(A.serverAgentCatalogSync, "agentCatalog", agentCatalog.sync(input)),
    [A.serverAgentCatalogRemove]: (input: Parameters<typeof agentCatalog.remove>[0]) =>
      observeCatalogRpc(A.serverAgentCatalogRemove, "agentCatalog", agentCatalog.remove(input)),
    // ── Commands (13) ─────────────────────────────────────────────────────────
    [C.serverCommandCatalogSnapshot]: (_input: unknown) =>
      observeCatalogRpc(
        C.serverCommandCatalogSnapshot,
        "commandCatalog",
        commandCatalog.getSnapshot(),
      ),
    [C.serverCommandCatalogRescan]: (_input: unknown) =>
      observeCatalogRpc(C.serverCommandCatalogRescan, "commandCatalog", commandCatalog.rescan()),
    [C.serverCommandCatalogRescanItem]: (input: Parameters<typeof commandCatalog.rescanItem>[0]) =>
      observeCatalogRpc(
        C.serverCommandCatalogRescanItem,
        "commandCatalog",
        commandCatalog.rescanItem(input),
      ),
    [C.serverCommandCatalogAdd]: (input: Parameters<typeof commandCatalog.add>[0]) =>
      observeCatalogRpc(C.serverCommandCatalogAdd, "commandCatalog", commandCatalog.add(input)),
    [C.serverCommandCatalogConnect]: (input: Parameters<typeof commandCatalog.connect>[0]) =>
      observeCatalogRpc(
        C.serverCommandCatalogConnect,
        "commandCatalog",
        commandCatalog.connect(input),
      ),
    [C.serverCommandCatalogDelete]: (input: Parameters<typeof commandCatalog.delete>[0]) =>
      observeCatalogRpc(
        C.serverCommandCatalogDelete,
        "commandCatalog",
        commandCatalog.delete(input),
      ),
    [C.serverCommandCatalogDisable]: (input: Parameters<typeof commandCatalog.disable>[0]) =>
      observeCatalogRpc(
        C.serverCommandCatalogDisable,
        "commandCatalog",
        commandCatalog.disable(input),
      ),
    [C.serverCommandCatalogDisconnectAll]: (
      input: Parameters<typeof commandCatalog.disconnectAll>[0],
    ) =>
      observeCatalogRpc(
        C.serverCommandCatalogDisconnectAll,
        "commandCatalog",
        commandCatalog.disconnectAll(input),
      ),
    [C.serverCommandCatalogReadFiles]: (
      input: Parameters<typeof commandCatalog.readItemFiles>[0],
    ) =>
      observeCatalogRpc(
        C.serverCommandCatalogReadFiles,
        "commandCatalog",
        commandCatalog.readItemFiles(input),
      ),
    [C.serverCommandCatalogReadContent]: (
      input: Parameters<typeof commandCatalog.readItemContent>[0],
    ) =>
      observeCatalogRpc(
        C.serverCommandCatalogReadContent,
        "commandCatalog",
        commandCatalog.readItemContent(input),
      ),
    [C.serverCommandCatalogWriteFiles]: (
      input: Parameters<typeof commandCatalog.writeItemFiles>[0],
    ) =>
      observeCatalogRpc(
        C.serverCommandCatalogWriteFiles,
        "commandCatalog",
        commandCatalog.writeItemFiles(input),
      ),
    [C.serverCommandCatalogSync]: (input: Parameters<typeof commandCatalog.sync>[0]) =>
      observeCatalogRpc(C.serverCommandCatalogSync, "commandCatalog", commandCatalog.sync(input)),
    [C.serverCommandCatalogRemove]: (input: Parameters<typeof commandCatalog.remove>[0]) =>
      observeCatalogRpc(
        C.serverCommandCatalogRemove,
        "commandCatalog",
        commandCatalog.remove(input),
      ),
  };
}
