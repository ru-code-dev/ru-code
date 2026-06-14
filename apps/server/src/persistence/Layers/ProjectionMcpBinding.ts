import { McpBinding, McpToolPolicy, McpVarValue, NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  BindingsByProjectInput,
  BindingsByServerInput,
  McpBindingRepository,
  RemoveBindingInput,
  type McpBindingRepositoryShape,
} from "../Services/McpBinding.ts";

// `enabled` is stored as 0/1 (SQLite has no boolean); JSON columns decode to
// their domain shapes. We read the row as-is then convert enabled → boolean.
const McpBindingDbRow = McpBinding.mapFields(
  Struct.assign({
    enabled: NonNegativeInt,
    toolPolicy: Schema.fromJsonString(McpToolPolicy),
    varValues: Schema.fromJsonString(Schema.Record(Schema.String, McpVarValue)),
  }),
);
type McpBindingDbRow = typeof McpBindingDbRow.Type;

function rowToBinding(row: McpBindingDbRow): McpBinding {
  return { ...row, enabled: row.enabled !== 0 };
}

const makeMcpBindingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: McpBinding,
    execute: (binding) =>
      sql`
        INSERT INTO mcp_project_binding (
          project_id, server_id, enabled, tool_policy_json, var_values_json, timeout_ms,
          created_at, updated_at
        ) VALUES (
          ${binding.projectId}, ${binding.serverId}, ${binding.enabled ? 1 : 0},
          ${JSON.stringify(binding.toolPolicy)}, ${JSON.stringify(binding.varValues)},
          ${binding.timeoutMs}, ${binding.createdAt}, ${binding.updatedAt}
        )
        ON CONFLICT (project_id, server_id) DO UPDATE SET
          enabled = excluded.enabled,
          tool_policy_json = excluded.tool_policy_json,
          var_values_json = excluded.var_values_json,
          timeout_ms = excluded.timeout_ms,
          updated_at = excluded.updated_at
      `,
  });

  const listByProjectRows = SqlSchema.findAll({
    Request: BindingsByProjectInput,
    Result: McpBindingDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT project_id AS "projectId", server_id AS "serverId", enabled,
               tool_policy_json AS "toolPolicy", var_values_json AS "varValues",
               timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM mcp_project_binding WHERE project_id = ${projectId}
        ORDER BY created_at ASC, server_id ASC
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: McpBindingDbRow,
    execute: () =>
      sql`
        SELECT project_id AS "projectId", server_id AS "serverId", enabled,
               tool_policy_json AS "toolPolicy", var_values_json AS "varValues",
               timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM mcp_project_binding ORDER BY project_id ASC, server_id ASC
      `,
  });

  const removeRow = SqlSchema.void({
    Request: RemoveBindingInput,
    execute: ({ projectId, serverId }) =>
      sql`DELETE FROM mcp_project_binding WHERE project_id = ${projectId} AND server_id = ${serverId}`,
  });

  const removeByProjectRow = SqlSchema.void({
    Request: BindingsByProjectInput,
    execute: ({ projectId }) => sql`DELETE FROM mcp_project_binding WHERE project_id = ${projectId}`,
  });

  const removeByServerRow = SqlSchema.void({
    Request: BindingsByServerInput,
    execute: ({ serverId }) => sql`DELETE FROM mcp_project_binding WHERE server_id = ${serverId}`,
  });

  return {
    upsert: (binding) =>
      upsertRow(binding).pipe(Effect.mapError(toPersistenceSqlError("McpBinding.upsert"))),
    remove: (input) =>
      removeRow(input).pipe(Effect.mapError(toPersistenceSqlError("McpBinding.remove"))),
    listByProject: (input) =>
      listByProjectRows(input).pipe(
        Effect.map((rows) => rows.map(rowToBinding)),
        Effect.mapError(toPersistenceSqlError("McpBinding.listByProject")),
      ),
    removeByProject: (input) =>
      removeByProjectRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("McpBinding.removeByProject")),
      ),
    removeByServer: (input) =>
      removeByServerRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("McpBinding.removeByServer")),
      ),
    listAll: () =>
      listAllRows().pipe(
        Effect.map((rows) => rows.map(rowToBinding)),
        Effect.mapError(toPersistenceSqlError("McpBinding.listAll")),
      ),
  } satisfies McpBindingRepositoryShape;
});

export const McpBindingRepositoryLive = Layer.effect(McpBindingRepository, makeMcpBindingRepository);
