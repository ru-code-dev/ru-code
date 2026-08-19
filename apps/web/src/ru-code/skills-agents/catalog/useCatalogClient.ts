// ru-code: the RPC `client` half of the skills/agents catalog web ports. The catalog packages
// (@smart-tools/qwen-cli-*-manager) render against an `ItemCatalogClient` — 13 promise-returning
// methods (snapshot / rescan / … / remove) that map 1:1 onto the `server.<prefix>.<suffix>` RPCs.
//
// Port runs every RPC through an environment-scoped supervisor, so each call is executed against
// the PRIMARY environment via `createEnvironmentRpcCommand(...).run(registry, {environmentId,input})`,
// then the settled AsyncResult is unwrapped into a resolve/reject promise the panel expects. Each
// method uses its LITERAL WS method tag (from the package's *_CATALOG_METHODS map), so the RPC
// input/success types flow end-to-end with no casts.
import { RegistryContext } from "@effect/atom-react";
import { AGENT_CATALOG_METHODS } from "@smart-tools/qwen-cli-agents-manager/contracts";
import type { ItemCatalogClient } from "@smart-tools/qwen-cli-catalog-core/web";
import { SKILL_CATALOG_METHODS } from "@smart-tools/qwen-cli-skill-manager/contracts";
import { COMMAND_CATALOG_METHODS } from "@smart-tools/qwen-cli-commands-manager/contracts";
import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useMemo } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";

// The literal WS method tag for each of the 13 client methods, per manager. Skill and agent
// share identical payload/success shapes (both minted by the shared catalog RPC factory), so the
// per-prefix tables have matching types — the client body below is written once for both.
const CATALOG_TAGS = {
  skillCatalog: {
    snapshot: SKILL_CATALOG_METHODS.serverSkillCatalogSnapshot,
    rescan: SKILL_CATALOG_METHODS.serverSkillCatalogRescan,
    rescanItem: SKILL_CATALOG_METHODS.serverSkillCatalogRescanItem,
    add: SKILL_CATALOG_METHODS.serverSkillCatalogAdd,
    connect: SKILL_CATALOG_METHODS.serverSkillCatalogConnect,
    delete: SKILL_CATALOG_METHODS.serverSkillCatalogDelete,
    disable: SKILL_CATALOG_METHODS.serverSkillCatalogDisable,
    disconnectAll: SKILL_CATALOG_METHODS.serverSkillCatalogDisconnectAll,
    readFiles: SKILL_CATALOG_METHODS.serverSkillCatalogReadFiles,
    readContent: SKILL_CATALOG_METHODS.serverSkillCatalogReadContent,
    writeFiles: SKILL_CATALOG_METHODS.serverSkillCatalogWriteFiles,
    sync: SKILL_CATALOG_METHODS.serverSkillCatalogSync,
    remove: SKILL_CATALOG_METHODS.serverSkillCatalogRemove,
  },
  agentCatalog: {
    snapshot: AGENT_CATALOG_METHODS.serverAgentCatalogSnapshot,
    rescan: AGENT_CATALOG_METHODS.serverAgentCatalogRescan,
    rescanItem: AGENT_CATALOG_METHODS.serverAgentCatalogRescanItem,
    add: AGENT_CATALOG_METHODS.serverAgentCatalogAdd,
    connect: AGENT_CATALOG_METHODS.serverAgentCatalogConnect,
    delete: AGENT_CATALOG_METHODS.serverAgentCatalogDelete,
    disable: AGENT_CATALOG_METHODS.serverAgentCatalogDisable,
    disconnectAll: AGENT_CATALOG_METHODS.serverAgentCatalogDisconnectAll,
    readFiles: AGENT_CATALOG_METHODS.serverAgentCatalogReadFiles,
    readContent: AGENT_CATALOG_METHODS.serverAgentCatalogReadContent,
    writeFiles: AGENT_CATALOG_METHODS.serverAgentCatalogWriteFiles,
    sync: AGENT_CATALOG_METHODS.serverAgentCatalogSync,
    remove: AGENT_CATALOG_METHODS.serverAgentCatalogRemove,
  },
  commandCatalog: {
    snapshot: COMMAND_CATALOG_METHODS.serverCommandCatalogSnapshot,
    rescan: COMMAND_CATALOG_METHODS.serverCommandCatalogRescan,
    rescanItem: COMMAND_CATALOG_METHODS.serverCommandCatalogRescanItem,
    add: COMMAND_CATALOG_METHODS.serverCommandCatalogAdd,
    connect: COMMAND_CATALOG_METHODS.serverCommandCatalogConnect,
    delete: COMMAND_CATALOG_METHODS.serverCommandCatalogDelete,
    disable: COMMAND_CATALOG_METHODS.serverCommandCatalogDisable,
    disconnectAll: COMMAND_CATALOG_METHODS.serverCommandCatalogDisconnectAll,
    readFiles: COMMAND_CATALOG_METHODS.serverCommandCatalogReadFiles,
    readContent: COMMAND_CATALOG_METHODS.serverCommandCatalogReadContent,
    writeFiles: COMMAND_CATALOG_METHODS.serverCommandCatalogWriteFiles,
    sync: COMMAND_CATALOG_METHODS.serverCommandCatalogSync,
    remove: COMMAND_CATALOG_METHODS.serverCommandCatalogRemove,
  },
} as const;

/** Build a promise-returning catalog client bound to the primary environment. `prefix` selects
 *  which manager's RPCs to drive (`skillCatalog` → `server.skillCatalog.*`). */
export function useCatalogClient(
  prefix: "skillCatalog" | "agentCatalog" | "commandCatalog",
): ItemCatalogClient {
  const registry = useContext(RegistryContext);
  const environmentId = usePrimaryEnvironmentId();

  return useMemo<ItemCatalogClient>(() => {
    const tags = CATALOG_TAGS[prefix];

    // Run one unary catalog RPC against the primary environment and unwrap the settled result:
    // resolve with the success value, reject with the squashed failure cause.
    const runRpc = async <TTag extends EnvironmentUnaryRpcTag>(
      tag: TTag,
      input: EnvironmentRpcInput<TTag>,
    ): Promise<EnvironmentRpcSuccess<TTag>> => {
      if (environmentId === null) {
        throw new Error("Нет активного подключения к серверу.");
      }
      const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
        label: `catalog:${tag}`,
        tag,
      });
      const result = await command.run(registry, { environmentId, input });
      if (AsyncResult.isSuccess(result)) {
        return result.value;
      }
      throw Cause.squash(result.cause);
    };

    return {
      snapshot: () => runRpc(tags.snapshot, {}),
      rescan: () => runRpc(tags.rescan, {}),
      rescanItem: (input) => runRpc(tags.rescanItem, input),
      add: (input) => runRpc(tags.add, input),
      connect: (input) => runRpc(tags.connect, input),
      delete: (input) => runRpc(tags.delete, input),
      disable: (input) => runRpc(tags.disable, input),
      disconnectAll: (input) => runRpc(tags.disconnectAll, input),
      readFiles: (input) => runRpc(tags.readFiles, input),
      readContent: (input) => runRpc(tags.readContent, input),
      writeFiles: (input) => runRpc(tags.writeFiles, input),
      sync: (input) => runRpc(tags.sync, input),
      remove: (input) => runRpc(tags.remove, input),
    };
  }, [registry, environmentId, prefix]);
}
