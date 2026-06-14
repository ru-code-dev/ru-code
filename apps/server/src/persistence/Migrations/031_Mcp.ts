import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// ru-fork: the SINGLE migration for the whole MCP feature (unreleased — final
// users get this final schema, no migration-on-migration stacking; edit THIS
// file rather than adding 032+).
//   - mcp_catalog_server: global catalog. config_json holds secret refs only
//     (plaintext lives in ServerSecretStore). Status + discovered tools live in
//     mcp_probe_cache (keyed by configCacheKey), never on the catalog row.
//   - mcp_project_binding: per-project bindings; cascade with the project on
//     project.deleted (enforced by the projector, indexed below).
//   - mcp_probe_cache: probe result (status + discovered tools) keyed by the
//     AUTHORED config (configCacheKey), so two projects on the catalog default
//     share one entry and a per-project override gets its own.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_catalog_server (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      description        TEXT,
      website_url        TEXT,
      source             TEXT NOT NULL,
      config_json        TEXT NOT NULL,
      vars_json          TEXT NOT NULL DEFAULT '[]',
      extra_args_json    TEXT NOT NULL DEFAULT '[]',
      extra_headers_json TEXT NOT NULL DEFAULT '{}',
      builtin_id         TEXT,
      builtin_hash       TEXT,
      locked             INTEGER NOT NULL DEFAULT 0,
      enabled            INTEGER NOT NULL DEFAULT 1,
      trust              INTEGER NOT NULL DEFAULT 1,
      timeout_ms         INTEGER,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_project_binding (
      project_id       TEXT NOT NULL,
      server_id        TEXT NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      tool_policy_json TEXT NOT NULL DEFAULT '{"defaultDecision":"allow","exceptions":[]}',
      var_values_json  TEXT NOT NULL DEFAULT '{}',
      timeout_ms       INTEGER,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (project_id, server_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mcp_binding_project ON mcp_project_binding(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mcp_binding_server ON mcp_project_binding(server_id)
  `;

  // Probe-result cache, keyed by configCacheKey (authored config, cwd-independent).
  // checked_at = ISO (for display); checked_at_ms = epoch (for the due check on
  // hydration, so a restart doesn't immediately re-probe a fresh config).
  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_probe_cache (
      config_key          TEXT PRIMARY KEY,
      transport           TEXT NOT NULL,
      status              TEXT NOT NULL,
      tools_json          TEXT NOT NULL DEFAULT '[]',
      last_error          TEXT,
      server_description  TEXT,
      server_website_url  TEXT,
      checked_at          TEXT NOT NULL,
      checked_at_ms       INTEGER NOT NULL DEFAULT 0
    )
  `;
});
