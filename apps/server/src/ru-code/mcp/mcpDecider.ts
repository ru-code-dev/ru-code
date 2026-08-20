// ru-code: the MCP command → event decider branches, delegated to from the shared
// orchestration decider's switch (one marked multi-case seam). Bodies are verbatim from
// the pre-extraction app: validate → split secrets → build → emit. The pure builders and
// the secret splitting live in the package; the host owns event-envelope construction
// (withEventBase is injected by the caller so this module never reaches into decider
// internals) and the invariant error type.

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import {
  applyServerUpdate,
  buildAddedServer,
  buildBinding,
  buildSyncedBuiltin,
  configIdentity,
  configPlaceholders,
  MCP_CATALOG_AGGREGATE_ID,
  McpManagerSecretStore,
  mergeTemplateVars,
  resolveBindingVarValues,
  splitServerVars,
  type McpSecretStoreError,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { requireProject } from "../../orchestration/commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import {
  findBinding,
  findCatalogServerById,
  requireCatalogConfigUnique,
  requireCatalogServer,
  requireCatalogServerAbsent,
} from "./mcpInvariants.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The event-envelope builder the shared decider uses, injected so the seam stays one call. */
export type WithEventBase = (
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
) => Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
>;

type McpDeciderCommand = Extract<
  OrchestrationCommand,
  {
    readonly type:
      | "mcp.server-add"
      | "mcp.server-update"
      | "mcp.builtin-sync"
      | "mcp.server-remove"
      | "mcp.binding-set"
      | "mcp.binding-remove";
  }
>;

export const decideMcpCommand = Effect.fn("decideMcpCommand")(function* ({
  command,
  readModel,
  withEventBase,
}: {
  readonly command: McpDeciderCommand;
  readonly readModel: OrchestrationReadModel;
  readonly withEventBase: WithEventBase;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence">,
  OrchestrationCommandInvariantError | McpSecretStoreError | PlatformError.PlatformError,
  Crypto.Crypto | McpManagerSecretStore
> {
  switch (command.type) {
    // ── MCP catalog commands (aggregate = mcp-catalog) ────────────────────────
    case "mcp.server-add": {
      yield* requireCatalogServerAbsent({ readModel, command, serverId: command.serverId });
      // A server's identity is its config, not its name — reject a duplicate of any
      // existing catalog server (incl. built-ins) BEFORE writing secrets.
      yield* requireCatalogConfigUnique({
        readModel,
        command,
        identity: configIdentity(
          command.draft.config,
          command.draft.vars,
          command.draft.extraArgs ?? [],
          command.draft.extraHeaders ?? {},
        ),
        excludeServerId: null,
      });
      // Every ${VAR} in the config must resolve to a declared var (or ${PROJECT_CWD}).
      {
        const declaredVarNames = new Set(command.draft.vars.map((variable) => variable.name));
        const danglingPlaceholders = [...configPlaceholders(command.draft.config)].filter(
          (name) => !declaredVarNames.has(name),
        );
        if (danglingPlaceholders.length > 0) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Шаблон ссылается на необъявленные переменные: ${danglingPlaceholders.join(", ")}.`,
          });
        }
      }
      const vars = yield* splitServerVars(command.serverId, command.draft.vars, []);
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-catalog",
          aggregateId: MCP_CATALOG_AGGREGATE_ID,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "mcp.server-added",
        payload: {
          server: buildAddedServer(command.serverId, command.draft, vars, command.createdAt),
        },
      };
    }

    case "mcp.server-update": {
      const existing = yield* requireCatalogServer({
        readModel,
        command,
        serverId: command.serverId,
      });
      const occurredAt = yield* nowIso;
      // Identity lock: a template's command and shipped var declarations are read-only. A patch that
      // would change the command is rejected; configuring (extraArgs, var values, user vars) is allowed.
      if (existing.locked && command.patch.config !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `MCP server '${command.serverId}' is a locked template; its command cannot be edited.`,
        });
      }
      // Config-uniqueness on edit — only when a config-affecting field changes. Compute the
      // RESULTING identity and reject if it collides with a DIFFERENT server (exclude self).
      if (
        command.patch.config !== undefined ||
        command.patch.vars !== undefined ||
        command.patch.extraArgs !== undefined ||
        command.patch.extraHeaders !== undefined
      ) {
        yield* requireCatalogConfigUnique({
          readModel,
          command,
          identity: configIdentity(
            command.patch.config ?? existing.config,
            command.patch.vars ?? existing.vars,
            command.patch.extraArgs ?? existing.extraArgs,
            command.patch.extraHeaders ?? existing.extraHeaders,
          ),
          excludeServerId: command.serverId,
        });
      }
      const vars = command.patch.vars
        ? yield* mergeTemplateVars(command.serverId, existing, command.patch.vars)
        : existing.vars;
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-catalog",
          aggregateId: MCP_CATALOG_AGGREGATE_ID,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp.server-updated",
        payload: { server: applyServerUpdate(existing, command.patch, vars, occurredAt) },
      };
    }

    // Migrator → catalog. Add/update a managed built-in by its shipped definition (3-way
    // merge preserving user data); emits the existing added/updated event (no fork, no new event).
    case "mcp.builtin-sync": {
      const existing = findCatalogServerById(readModel, command.serverId); // undefined ⇒ add
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-catalog",
          aggregateId: MCP_CATALOG_AGGREGATE_ID,
          occurredAt,
          commandId: command.commandId,
        })),
        type: existing ? "mcp.server-updated" : "mcp.server-added",
        payload: {
          server: buildSyncedBuiltin({
            serverId: command.serverId,
            builtinId: command.builtinId,
            builtinHash: command.builtinHash,
            name: command.name,
            description: command.description,
            websiteUrl: command.websiteUrl,
            config: command.config,
            shippedVars: command.shippedVars,
            timeoutMs: command.timeoutMs,
            existing,
            occurredAt,
          }),
        },
      };
    }

    case "mcp.server-remove": {
      yield* requireCatalogServer({ readModel, command, serverId: command.serverId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-catalog",
          aggregateId: MCP_CATALOG_AGGREGATE_ID,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp.server-removed",
        payload: { serverId: command.serverId, removedAt: occurredAt },
      };
    }

    // ── MCP binding commands (aggregate = project) ────────────────────────────
    case "mcp.binding-set": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const existing = findBinding(readModel, command.projectId, command.serverId);
      const server = yield* requireCatalogServer({
        readModel,
        command,
        serverId: command.serverId,
      });
      // Reject binding varValues whose keys are not declared vars (catches typos that
      // would otherwise be stored and silently ignored).
      {
        const declaredNames = new Set(server.vars.map((declared) => declared.name));
        const unknownKeys = Object.keys(command.patch.varValues ?? {}).filter(
          (key) => !declaredNames.has(key),
        );
        if (unknownKeys.length > 0) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Неизвестные переменные для сервера «${server.name}»: ${unknownKeys.join(", ")}.`,
          });
        }
      }
      const occurredAt = yield* nowIso;
      const varValues = yield* resolveBindingVarValues({
        patch: command.patch.varValues,
        keepNames: command.patch.keepVarValues,
        existing: existing?.varValues ?? {},
        vars: server.vars,
        projectId: command.projectId,
        serverId: command.serverId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp.binding-set",
        payload: {
          binding: buildBinding({
            projectId: command.projectId,
            serverId: command.serverId,
            patch: command.patch,
            existing,
            varValues,
            occurredAt,
          }),
        },
      };
    }

    case "mcp.binding-remove": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp.binding-removed",
        payload: {
          projectId: command.projectId,
          serverId: command.serverId,
          removedAt: occurredAt,
        },
      };
    }
  }
});
