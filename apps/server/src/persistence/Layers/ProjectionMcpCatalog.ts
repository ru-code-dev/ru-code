import { McpCatalogServer, McpServerConfig, McpServerVar, NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  McpCatalogRepository,
  RemoveCatalogServerInput,
  type McpCatalogRepositoryShape,
} from "../Services/McpCatalog.ts";

// config_json / vars_json / extra_headers_json decode into their domain shapes; description +
// website_url + timeout_ms are plain nullable columns; locked + enabled are 0/1 INTEGER columns.
const McpCatalogServerDbRow = McpCatalogServer.mapFields(
  Struct.assign({
    config: Schema.fromJsonString(McpServerConfig),
    vars: Schema.fromJsonString(Schema.Array(McpServerVar)),
    extraArgs: Schema.fromJsonString(Schema.Array(Schema.String)),
    extraHeaders: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    locked: NonNegativeInt, // 0/1 column → converted to boolean by rowToServer
    enabled: NonNegativeInt, // 0/1 column → converted to boolean by rowToServer
    trust: NonNegativeInt, // ru-fork #6: 0/1 column → boolean by rowToServer
  }),
);
type McpCatalogServerDbRow = typeof McpCatalogServerDbRow.Type;

/** `locked`/`enabled`/`trust` are 0/1 (SQLite has no boolean); convert them. JSON columns decode in-schema. */
function rowToServer(row: McpCatalogServerDbRow): McpCatalogServer {
  return { ...row, locked: row.locked !== 0, enabled: row.enabled !== 0, trust: row.trust !== 0 };
}

const makeMcpCatalogRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: McpCatalogServer,
    execute: (server) =>
      sql`
        INSERT INTO mcp_catalog_server (
          id, name, description, website_url, source, config_json, vars_json, extra_args_json,
          extra_headers_json, builtin_id, builtin_hash, locked, enabled, trust, timeout_ms, created_at, updated_at
        ) VALUES (
          ${server.id}, ${server.name}, ${server.description}, ${server.websiteUrl}, ${server.source},
          ${JSON.stringify(server.config)}, ${JSON.stringify(server.vars)},
          ${JSON.stringify(server.extraArgs)}, ${JSON.stringify(server.extraHeaders)},
          ${server.builtinId}, ${server.builtinHash},
          ${server.locked ? 1 : 0}, ${server.enabled ? 1 : 0}, ${server.trust ? 1 : 0}, ${server.timeoutMs},
          ${server.createdAt}, ${server.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          website_url = excluded.website_url,
          source = excluded.source,
          config_json = excluded.config_json,
          vars_json = excluded.vars_json,
          extra_args_json = excluded.extra_args_json,
          extra_headers_json = excluded.extra_headers_json,
          builtin_id = excluded.builtin_id,
          builtin_hash = excluded.builtin_hash,
          locked = excluded.locked,
          enabled = excluded.enabled,
          trust = excluded.trust,
          timeout_ms = excluded.timeout_ms,
          updated_at = excluded.updated_at
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: McpCatalogServerDbRow,
    execute: () =>
      sql`
        SELECT id, name, description, website_url AS "websiteUrl", source, config_json AS "config",
               vars_json AS "vars", extra_args_json AS "extraArgs", extra_headers_json AS "extraHeaders",
               builtin_id AS "builtinId", builtin_hash AS "builtinHash",
               locked AS "locked", enabled AS "enabled", trust AS "trust", timeout_ms AS "timeoutMs",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM mcp_catalog_server ORDER BY created_at ASC, id ASC
      `,
  });

  const removeRow = SqlSchema.void({
    Request: RemoveCatalogServerInput,
    execute: ({ serverId }) => sql`DELETE FROM mcp_catalog_server WHERE id = ${serverId}`,
  });

  return {
    upsert: (server) =>
      upsertRow(server).pipe(Effect.mapError(toPersistenceSqlError("McpCatalog.upsert"))),
    listAll: () =>
      listRows().pipe(
        Effect.map((rows) => rows.map(rowToServer)),
        Effect.mapError(toPersistenceSqlError("McpCatalog.listAll")),
      ),
    remove: (input) =>
      removeRow(input).pipe(Effect.mapError(toPersistenceSqlError("McpCatalog.remove"))),
  } satisfies McpCatalogRepositoryShape;
});

export const McpCatalogRepositoryLive = Layer.effect(McpCatalogRepository, makeMcpCatalogRepository);
