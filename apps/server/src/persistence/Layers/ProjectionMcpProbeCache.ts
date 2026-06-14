import { McpProbeRecord, McpTool } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProbeRecordInput,
  McpProbeCacheRepository,
  type McpProbeCacheRepositoryShape,
} from "../Services/McpProbeCache.ts";

// tools_json decodes into McpTool[]; the rest are plain TEXT.
const McpProbeRecordDbRow = McpProbeRecord.mapFields(
  Struct.assign({ tools: Schema.fromJsonString(Schema.Array(McpTool)) }),
);

const makeMcpProbeCacheRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: McpProbeRecord,
    execute: (record) =>
      sql`
        INSERT INTO mcp_probe_cache (
          config_key, transport, status, tools_json, last_error,
          server_description, server_website_url, checked_at, checked_at_ms
        )
        VALUES (
          ${record.configKey}, ${record.transport}, ${record.status},
          ${JSON.stringify(record.tools)}, ${record.lastError},
          ${record.serverDescription}, ${record.serverWebsiteUrl}, ${record.checkedAt}, ${record.checkedAtMs}
        )
        ON CONFLICT (config_key) DO UPDATE SET
          transport = excluded.transport,
          status = excluded.status,
          tools_json = excluded.tools_json,
          last_error = excluded.last_error,
          server_description = excluded.server_description,
          server_website_url = excluded.server_website_url,
          checked_at = excluded.checked_at,
          checked_at_ms = excluded.checked_at_ms
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProbeRecordInput,
    Result: McpProbeRecordDbRow,
    execute: ({ configKey }) =>
      sql`
        SELECT config_key AS "configKey", transport, status, tools_json AS "tools",
               last_error AS "lastError", server_description AS "serverDescription",
               server_website_url AS "serverWebsiteUrl", checked_at AS "checkedAt",
               checked_at_ms AS "checkedAtMs"
        FROM mcp_probe_cache WHERE config_key = ${configKey}
      `,
  });

  return {
    upsert: (record) =>
      upsertRow(record).pipe(Effect.mapError(toPersistenceSqlError("McpProbeCache.upsert"))),
    getByKey: (input) =>
      getRow(input).pipe(Effect.mapError(toPersistenceSqlError("McpProbeCache.getByKey"))),
    deleteKeysNotIn: (configKeys) =>
      (configKeys.length === 0
        ? sql`DELETE FROM mcp_probe_cache`
        : sql`DELETE FROM mcp_probe_cache WHERE config_key NOT IN ${sql.in(configKeys)}`
      ).pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("McpProbeCache.deleteKeysNotIn")),
      ),
  } satisfies McpProbeCacheRepositoryShape;
});

export const McpProbeCacheRepositoryLive = Layer.effect(
  McpProbeCacheRepository,
  makeMcpProbeCacheRepository,
);
