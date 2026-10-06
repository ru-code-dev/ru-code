/**
 * ru-code: one SQLite file per plugin, plus the plugin migration runner (D2/D10).
 *
 * WHY a separate file per plugin instead of tables in `state.sqlite`.
 * `state.sqlite` is the event-sourced core: its schema is owned by two migration
 * id spaces that must stay append-only, and a corrupt write there costs the user
 * their threads. A plugin is untrusted, user-dropped code, so it gets its own
 * file at `<stateDir>/plugins/<id>/data.sqlite` and a promise handle bound to
 * THAT client. Deleting a plugin folder leaves this file in place (D11).
 *
 * HOW FAR THAT BINDING GOES — read this before repeating the old claim that the
 * app database "is not reachable through the host API at all" (A12 finding
 * R1-H3). It was false as written: `ATTACH DATABASE '<path>' AS app` names a
 * SECOND file on the SAME connection, and the wrapper passed any SQL straight
 * through, so a plugin could read and write `state.sqlite` and every other
 * plugin's `data.sqlite` — verified against the live event store.
 *
 * `node:sqlite` exposes no authorizer callback (SQLite's `sqlite3_set_authorizer`
 * is not bound in this Node), so the enforcement is a STATEMENT-LEVEL GUARD in
 * this module — {@link assertPluginStatementAllowed} — not a sandbox:
 *   - the first keyword of every statement the plugin submits is checked, and
 *     `ATTACH` / `DETACH` are refused;
 *   - `PRAGMA` is refused except a small allowlist, and so is every `pragma_*`
 *     table-valued FUNCTION (A12 finding R2-M2 — `SELECT * FROM
 *     pragma_database_list` was the same pragma under a `SELECT`), in every
 *     spelling SQLite accepts for a table name: bare, double-quoted, bracketed,
 *     backticked, schema-qualified, and — since A12 finding R3-M1 — SINGLE-QUOTED,
 *     which is a legal table name in SQLite and was the one spelling the round-2
 *     guard blanked before it looked;
 *   - the `sqlite_` schema tables may be read but not written (except
 *     `sqlite_sequence`, the plugin's own `AUTOINCREMENT` counters — R3-L2);
 *   - `query` takes exactly one statement, and `exec` checks each of the
 *     statements it runs.
 * That is the whole of it. A SERVER plugin still runs as the server process and
 * can `import fs from "node:fs"` and open any file it likes (README §11: there
 * is no sandboxing, by design, in this MVP). The guard exists so that an HONEST
 * plugin cannot reach the event-sourced core by writing the one SQL statement
 * that looks like a reasonable way to share data.
 *
 * WHY it still goes through the app's own client. `persistence/NodeSqliteClient.ts`
 * is the port of `@effect/sql-sqlite-node` onto `node:sqlite` that the whole app
 * runs on: same prepare cache, same error classification, same connection
 * semaphore, same close-on-scope finalizer. Opening a second sqlite binding for
 * plugins would be a second thing to keep alive across Node upgrades. The runtime
 * split (`bun` vs `node`) is copied from `persistence/Layers/Sqlite.ts` for the
 * same reason. What is deliberately NOT reused is that module's `setup` layer:
 * it runs `runMigrations()` + `runRuCodeMigrations()`, i.e. the APP's schema —
 * running it here would build the entire app schema inside every plugin's file.
 *
 * PRAGMAs mirror the app's: `busy_timeout` (a plugin must wait, not fail, if the
 * CLI touches the file), WAL (concurrent read while the plugin writes) and
 * `foreign_keys` ON (plugins get the same referential integrity the app assumes).
 *
 * MIGRATIONS (D10). The plugin declares `migrations: [{ id, sql }]`, where `sql`
 * is either one text (split into statements here) or an ARRAY of statements taken
 * as they are (A12 finding R3-M2 — the splitter cannot tell a trigger body's `END`
 * from a column named `end`, so a trigger is best shipped as one array element);
 * unapplied ids run in ARRAY order, each inside its own transaction together with its
 * bookkeeping row in `_plugin_migrations`, so an interrupted or failing migration
 * can never record itself as applied. The first failure stops the run and
 * disables that plugin only — its `error` names the migration id, because "the
 * demo plugin failed" without the id is unactionable for the author.
 *
 * @module ru-code/plugins/storage
 */
import type { Migration as PluginMigration, PluginStorage } from "@smart-tools/plugin-sdk/host";
import { migrationIdProblem } from "@smart-tools/plugin-sdk/host-rules";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Bookkeeping table inside the PLUGIN's own file (never in `state.sqlite`). */
export const PLUGIN_MIGRATIONS_TABLE = "_plugin_migrations";

type SqliteClientLayerConfig = {
  readonly filename: string;
  readonly allowExtension?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
};

type SqliteClientLoader = {
  layer: (config: SqliteClientLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};

// Same two loaders as `persistence/Layers/Sqlite.ts` — the plugin file is opened
// by whichever sqlite binding the host process itself runs on.
const sqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../../persistence/NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<SqliteClientLoader>>;

/**
 * Open (creating if needed) the plugin's own database and apply the host PRAGMAs.
 *
 * Scoped: the client's close-on-finalize lives on the caller's scope — the
 * `PluginHost` layer scope, so every plugin database is closed exactly once when
 * the server shuts down.
 */
export const openPluginSqlClient = Effect.fn("plugins.openPluginSqlClient")(function* (input: {
  readonly id: string;
  readonly dbPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(input.dbPath), { recursive: true });

  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = sqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<SqliteClientLoader>(loader);
  const context = yield* Layer.build(
    clientModule.layer({
      filename: input.dbPath,
      // ru-code (A13, A12 finding R1-H3): the most restrictive options this Node's
      // `DatabaseSync` offers. `allowExtension: false` is already the default in
      // `NodeSqliteClient.ts`, but a plugin connection is exactly the place where the
      // default must be written down: loading an extension is arbitrary native code
      // inside the server process. `readOnly` is not available here (plugins write their
      // own file) and there is no `enableForeignKeyConstraints` option on this build —
      // `PRAGMA foreign_keys = ON` below is the equivalent.
      allowExtension: false,
      spanAttributes: {
        "db.name": path.basename(input.dbPath),
        "service.name": "t3-server",
        "plugin.id": input.id,
      },
    }),
  );
  const sql = Context.get(context, SqlClient.SqlClient);

  // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql`PRAGMA foreign_keys = ON;`;

  return sql;
});

/**
 * Split a migration body into individual statements.
 *
 * WHY this exists at all: `node:sqlite`'s `prepare()` compiles only the FIRST
 * statement of the text it is given and silently discards the rest — verified on
 * this Node build. Handing a two-statement migration straight to the client
 * would therefore create the table, skip the index, and still record the
 * migration as applied. That silent half-application is exactly the failure a
 * migration runner exists to prevent, so the text is split here and every
 * statement is executed.
 *
 * String literals (`'..'`), quoted identifiers (`".."`, `[..]`, `` `..` ``), line
 * comments and block comments are honoured.
 *
 * ru-code (A13 round 2, A12 finding R2-M4): `CREATE TRIGGER … BEGIN … END;` IS
 * supported. It is the one compound statement SQLite has, and its body always
 * contains at least one `;` — so the old splitter cut every trigger migration
 * into a truncated `CREATE TRIGGER … BEGIN <stmt>` and a bare `END`, the first
 * of which fails to prepare and disables the plugin with "Failed to prepare
 * statement". The doc here used to offer "put it in a migration of its own" as
 * the workaround; that never worked, because the inner `;` is inside the single
 * migration too. So a depth counter now decides what a `;` means:
 *
 *   · `BEGIN` opens a block only after `CREATE … TRIGGER` (never `BEGIN
 *     TRANSACTION`, which a migration has no business issuing anyway);
 *   · inside a block, `CASE … END` is counted separately, so the `END` of a
 *     `CASE` expression in the body does not close the trigger;
 *   · `;` is a statement boundary only at depth 0.
 *
 * ru-code (A13 round 3, A12 finding R3-M2): ITS DOCUMENTED LIMIT. A splitter
 * that reads keywords without parsing SQL cannot tell the `END` that closes a
 * trigger body from the `END` that is a COLUMN NAME (`SELECT new.end`, `SELECT 1
 * AS end` — both legal SQLite, and `start`/`end` is the ordinary naming for a
 * time range). The auditor's fixture was split in half and disabled the plugin.
 * Rather than grow more heuristics, the CONTRACT gained a shape that needs no
 * guessing at all: `migration.sql` may be a `ReadonlyArray<string>`, one exactly
 * one statement per element, which skips this function entirely (see
 * {@link migrationStatements}). The string form is unchanged and keeps this
 * limit; README §5 says so and shows the array form for triggers.
 *
 * ru-code (S41 item 6, A12/S40 Q4): the walk is shared with the ARRAY form. Comment resolution and
 * statement splitting are two things this one scan does, and the array form needs the first
 * without the second — see {@link resolveSqlComments} and {@link migrationStatements}.
 */
export const splitSqlStatements = (sql: string): ReadonlyArray<string> =>
  scanSqlStatements(sql, true);

/**
 * One statement with its comments RESOLVED and nothing split — the array form's reader.
 *
 * An array element is exactly one statement by contract, `;` and all (a trigger body carries
 * several), so it must never be cut. But it must be READ the way the string form's elements are
 * read before the guard sees them, or the two forms are not checked identically however loudly the
 * docs say they are: measured at S40 Q4, `/* seed *\/ ATTACH DATABASE …` was REFUSED as a string
 * and ALLOWED as an array element (the guard tokenized the comment text as SQL and never saw the
 * `ATTACH`), while `-- see pragma_table_list\nCREATE TABLE …` was allowed as a string and REFUSED
 * as an array element, disabling an honest plugin for a comment.
 *
 * The resolved text is what is guarded AND what is executed — one text, so no statement can be
 * checked in one spelling and run in another.
 */
export const resolveSqlComments = (statement: string): string =>
  scanSqlStatements(statement, false)[0] ?? "";

/**
 * The one scan. `splitOnSemicolon` is the only difference between the two migration forms: with it
 * off, a `;` is ordinary text and the whole input comes back as a single statement.
 */
const scanSqlStatements = (sql: string, splitOnSemicolon: boolean): ReadonlyArray<string> => {
  const statements: Array<string> = [];
  let current = "";
  let index = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "[": "]", "`": "`" };
  /** Set by `CREATE … TRIGGER`; the next bare `BEGIN` opens the body. */
  let expectTriggerBody = false;
  /** 1 while inside a `CREATE TRIGGER … BEGIN … END` body, 0 otherwise. */
  let blockDepth = 0;
  /** Open `CASE` expressions inside that body — each claims one `END`. */
  let caseDepth = 0;

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    const closer = closers[char];
    if (closer !== undefined) {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === closer) {
          // Doubled quote inside a quoted run is an escaped quote, not the end.
          if (sql[cursor + 1] === closer) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      current += sql.slice(index, Math.min(cursor + 1, sql.length));
      index = cursor + 1;
      continue;
    }
    // ru-code (A13 round 2, A12 finding R2-M4): keyword tracking, so `;` inside a trigger body
    // is not a statement boundary. Whole words only — reading them one at a time is also what
    // keeps `ENDING` or `a.begin` from being mistaken for the keywords.
    if (/[A-Za-z_]/.test(char)) {
      let cursor = index;
      while (cursor < sql.length && /[A-Za-z0-9_$]/.test(sql[cursor] ?? "")) cursor += 1;
      const word = sql.slice(index, cursor);
      switch (word.toUpperCase()) {
        case "TRIGGER": {
          if (blockDepth === 0) expectTriggerBody = true;
          break;
        }
        case "BEGIN": {
          if (expectTriggerBody && blockDepth === 0) {
            blockDepth = 1;
            expectTriggerBody = false;
          }
          break;
        }
        case "CASE": {
          if (blockDepth > 0) caseDepth += 1;
          break;
        }
        case "END": {
          if (caseDepth > 0) caseDepth -= 1;
          else if (blockDepth > 0) blockDepth = 0;
          break;
        }
        default:
          break;
      }
      current += word;
      index = cursor;
      continue;
    }
    if (char === ";" && blockDepth === 0 && splitOnSemicolon) {
      if (current.trim().length > 0) statements.push(current.trim());
      current = "";
      expectTriggerBody = false;
      caseDepth = 0;
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }

  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
};

/**
 * The statements of one migration (A12 finding R3-M2).
 *
 * An ARRAY is taken at its word about BOUNDARIES: each element is exactly one statement and is
 * never split — which is the whole point, because the splitter cannot know whether an `END` inside
 * a trigger body is the block terminator or a column called `end`. A STRING keeps the splitter and
 * its documented limit.
 *
 * Both forms are then guard-checked identically by the caller, and THAT is what
 * {@link resolveSqlComments} buys (S40 Q4): every element goes through the same comment-resolving
 * walk the string form's statements already came out of, so a comment cannot hide an `ATTACH` from
 * the guard in one form, nor get an honest `CREATE TABLE` refused for the words inside it in the
 * other. The resolved text is what runs, so the guard and `prepare()` read the same bytes.
 *
 * Empty elements are dropped rather than sent to `prepare()`, so a trailing `""` — or an element
 * that was nothing but a comment — is not a migration failure.
 */
export const migrationStatements = (sql: PluginMigration["sql"]): ReadonlyArray<string> => {
  if (Array.isArray(sql)) {
    return (sql as ReadonlyArray<unknown>)
      .map((statement) => (typeof statement === "string" ? resolveSqlComments(statement) : ""))
      .filter((statement) => statement !== "");
  }
  return splitSqlStatements(typeof sql === "string" ? sql : "");
};

/**
 * ru-code (A13, A12 finding R1-H3): the statement-level guard on everything a plugin submits.
 *
 * NOT A SANDBOX — see the module header. `node:sqlite` binds no `sqlite3_set_authorizer`, so the
 * only place the "one file per plugin" boundary (D2) can be enforced is here, on the text, before
 * it is prepared. Two rules, both about naming a file the connection was not opened with:
 *
 *   1. `ATTACH` / `DETACH` are refused outright. `ATTACH DATABASE '<state.sqlite>' AS app` was the
 *      whole of A12's exploit: one statement and the plugin is reading (and writing) the app's
 *      event store and every other plugin's data.
 *   2. `PRAGMA` is refused except `user_version`, `table_info`, `foreign_keys` and a READ of
 *      `journal_mode`. The allowlist is a list of names, so a schema-qualified pragma
 *      (`PRAGMA app.table_info(...)`, `PRAGMA main.database_list`) never matches — the first
 *      identifier is the schema, and no schema name is on the list.
 *
 * ru-code (A13 round 2, A12 finding R2-M2): rules 3 and 4, both about the SAME pragmas reached by
 * another spelling.
 *
 *   3. Every pragma SQLite exposes ALSO has a table-valued-function form whose first keyword is
 *      `SELECT` — `SELECT * FROM pragma_database_list` served the absolute path of the plugin's
 *      own file, `pragma_table_list` its whole schema, `pragma_compile_options` the sqlite build.
 *      Rule 2 never looked at them, because it keys off the first keyword. So a `pragma_*`
 *      IDENTIFIER anywhere in a statement is refused outright: the allowlist form of a pragma is
 *      the `PRAGMA` statement, full stop. (Nothing today makes the TVF form WRITABLE — I checked
 *      `pragma_journal_mode('delete')`, `pragma_user_version(7)` and `pragma_temp_store_directory`
 *      and all three fail inside SQLite — but that is SQLite's choice, not this host's guarantee,
 *      which is exactly why the guard must not depend on it.)
 *   4. The `sqlite_` schema tables are READ-ONLY: `INSERT`/`UPDATE`/`DELETE`/`REPLACE` naming one
 *      is refused. `PRAGMA writable_schema` is already refused by rule 2, so this is defence in
 *      depth on the same surface — the one place a plugin could rewrite what its file IS.
 *
 * ru-code (A13 round 3, A12 findings R3-M1 / R3-L1 / R3-L2): rules 3 and 4 read TOKENS.
 *
 *   3. an identifier matching `pragma_*` is refused wherever it appears, AND a string literal in
 *      TABLE POSITION is checked as an identifier — `SELECT * FROM 'pragma_database_list'` is the
 *      same table-valued function in SQLite and walked past the round-2 guard, which blanked
 *      quoted runs before it looked. A string literal in a VALUE position is still unchecked, so
 *      `INSERT INTO notes (body) VALUES ('pragma_table_list')` is allowed;
 *   4. a `sqlite_*` name in a WRITE position is refused, wherever the write keyword sits — behind
 *      a CTE (`WITH c AS (…) UPDATE sqlite_master …`) or inside a trigger body, both of which rode
 *      past the round-2 check on the statement's FIRST keyword (R3-L1). `sqlite_sequence` is the
 *      one exception (R3-L2): it is the counter table of the plugin's own `AUTOINCREMENT` columns.
 *
 * See {@link sqlTokens} and {@link tableNames} for how a table position is recognised.
 *
 * The check runs on the statements {@link migrationStatements} produces — the string form's
 * through {@link splitSqlStatements}, the array form's through {@link resolveSqlComments} — and
 * BOTH have already had comments resolved, so `/*x*\/ATTACH` and `--\nATTACH` are the same
 * statement as `ATTACH` in either form, and a `;` inside a literal (or a trigger body) does not
 * split anything.
 */
const PLUGIN_ALLOWED_PRAGMAS: ReadonlySet<string> = new Set([
  "user_version",
  "table_info",
  "foreign_keys",
  "journal_mode",
]);

/** Statement keywords that WRITE — the ones rule 4 refuses over a `sqlite_` table. */
const PLUGIN_WRITE_KEYWORDS: ReadonlySet<string> = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
]);

/**
 * ru-code (A13 round 3, A12 finding R3-L2): the one `sqlite_` table SQLite lets an application
 * write.
 *
 * `sqlite_sequence` holds the counters behind `INTEGER PRIMARY KEY AUTOINCREMENT` — the shape
 * README §5's own example ships — and `DELETE FROM sqlite_sequence WHERE name = 'x'` is the
 * documented way to reset one. Rule 4 refused it, so a plugin could not clear a counter in its own
 * file. Nothing about the D2 boundary depends on that refusal: the table lives INSIDE the plugin's
 * own database, and every other `sqlite_` table stays read-only.
 */
const PLUGIN_WRITABLE_SCHEMA_TABLES: ReadonlySet<string> = new Set(["sqlite_sequence"]);

/**
 * ru-code (A13 round 3, A12 finding R3-M1): the guard TOKENIZES instead of blanking.
 *
 * Round 2 blanked single-quoted runs before rules 3 and 4 read the text, so that a row containing
 * the word `pragma_x` was not refused for saying it. But SQLite accepts a STRING LITERAL WHERE A
 * TABLE NAME IS EXPECTED and resolves it to the same object: `SELECT * FROM 'pragma_database_list'`
 * returned the absolute path of the plugin's own file, `'pragma_table_list'` its whole schema — and
 * `CREATE VIEW v AS SELECT * FROM 'pragma_table_list'` parked the answer in the plugin's own schema
 * where a later statement mentioning no pragma at all could read it back. The guard blanked exactly
 * the text it exists to find.
 *
 * So the statement is read as TOKENS and a name is judged BY ITS POSITION:
 *
 *   · a quoted string, a quoted identifier or a bare word following `FROM`, `JOIN`, `INTO`,
 *     `UPDATE`, `TABLE`, `VIEW`, or the `ON` of `CREATE INDEX … ON` / `CREATE TRIGGER … ON`, is a
 *     TABLE NAME — unescaped, lower-cased and checked against the `pragma_` / `sqlite_` rules;
 *   · a string literal ANYWHERE ELSE is a value and is not checked, so
 *     `INSERT INTO notes (body) VALUES ('pragma_table_list')` is still allowed;
 *   · an identifier (bare or quoted) matching `pragma_*` is refused wherever it appears, which is
 *     round 2's rule 3 unchanged — a CTE aliased `pragma_x` is refused with it, the false positive
 *     that ruling accepted.
 *
 * A `CREATE VIEW … AS SELECT` and a `CREATE TABLE … AS SELECT` are one statement, so their bodies
 * go through the same walk with no special case.
 */
type SqlToken =
  /** A bare word: a keyword or an unquoted identifier. */
  | { readonly kind: "word"; readonly value: string }
  /** A quoted identifier — `"x"`, `[x]`, `` `x` `` — already unescaped. */
  | { readonly kind: "name"; readonly value: string }
  /** A single-quoted string literal, already unescaped. */
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string };

const QUOTE_CLOSERS: Record<string, string> = { "'": "'", '"': '"', "[": "]", "`": "`" };

/** Comments are already resolved by the caller's own reader; this only has to read quotes. */
const sqlTokens = (statement: string): ReadonlyArray<SqlToken> => {
  const tokens: Array<SqlToken> = [];
  let index = 0;
  while (index < statement.length) {
    const char = statement[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const closer = QUOTE_CLOSERS[char];
    if (closer !== undefined) {
      let value = "";
      let cursor = index + 1;
      while (cursor < statement.length) {
        if (statement[cursor] === closer) {
          // A doubled quote inside a quoted run is an escaped quote, not the end (`[..]` has no
          // escape, but doubling `]` there is not legal SQLite either, so one rule covers both).
          if (statement[cursor + 1] === closer && closer !== "]") {
            value += closer;
            cursor += 2;
            continue;
          }
          break;
        }
        value += statement[cursor] ?? "";
        cursor += 1;
      }
      tokens.push({ kind: char === "'" ? "text" : "name", value });
      index = cursor + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let cursor = index;
      while (cursor < statement.length && /[A-Za-z0-9_$]/.test(statement[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({ kind: "word", value: statement.slice(index, cursor) });
      index = cursor;
      continue;
    }
    tokens.push({ kind: "punct", value: char });
    index += 1;
  }
  return tokens;
};

/** Words that may stand between a table introducer and the name itself. */
const NAME_NOISE: ReadonlySet<string> = new Set([
  "IF",
  "NOT",
  "EXISTS",
  "TEMP",
  "TEMPORARY",
  "VIRTUAL",
  "UNIQUE",
  "OR",
  "ROLLBACK",
  "ABORT",
  "FAIL",
  "IGNORE",
]);

/** One name found in TABLE position, and whether the statement WRITES through it. */
type TableName = { readonly name: string; readonly write: boolean; readonly verb: string };

/**
 * Every name the statement uses in a table position (R3-M1).
 *
 * Deliberately forgiving: this is a guard, not a parser. A construct it does not understand simply
 * yields no table for that clause, and the identifier rule below still sees every `pragma_*` word.
 */
const tableNames = (tokens: ReadonlyArray<SqlToken>): ReadonlyArray<TableName> => {
  const found: Array<TableName> = [];
  let expecting: "read" | "write" | null = null;
  let writeVerb = "";
  let deleting = false;
  let namedObject = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.kind === "punct") {
      // `FROM (SELECT …)` is a subquery, not a table; `a.b` keeps the qualified tail in position.
      if (expecting !== null && token.value === "(") expecting = null;
      continue;
    }
    if (token.kind === "word") {
      const upper = token.value.toUpperCase();
      if (PLUGIN_WRITE_KEYWORDS.has(upper)) {
        writeVerb = upper;
        if (upper === "DELETE") deleting = true;
      }
      if (upper === "INDEX" || upper === "TRIGGER") namedObject = true;
      if (expecting === null) {
        if (upper === "FROM") expecting = deleting ? "write" : "read";
        else if (upper === "JOIN") expecting = "read";
        else if (upper === "INTO" || upper === "UPDATE") expecting = "write";
        else if (upper === "TABLE" || upper === "VIEW") expecting = "read";
        else if (upper === "ON" && namedObject) expecting = "read";
        continue;
      }
      if (NAME_NOISE.has(upper)) continue;
    }
    if (expecting === null) continue;
    found.push({ name: token.value, write: expecting === "write", verb: writeVerb });
    // A schema qualifier (`main.notes`, `'main'.'notes'`) puts the real name after the dot.
    expecting = tokens[index + 1]?.value === "." ? expecting : null;
  }
  return found;
};

/** The refused construct, for the error message — or `null` when the statement is allowed. */
export const pluginStatementRejection = (statement: string): string | null => {
  const trimmed = statement.trim();
  const keyword = (/^[A-Za-z_]+/.exec(trimmed)?.[0] ?? "").toUpperCase();
  if (keyword === "ATTACH" || keyword === "DETACH") return keyword;

  // Rules 3 and 4 are keyword-independent: the pragma TVFs ride `SELECT`, and a write to
  // `sqlite_master` rides `INSERT`/`UPDATE`/`DELETE` — which, since R3-L1, may sit behind a CTE or
  // inside a trigger body rather than at the head of the statement.
  const tokens = sqlTokens(trimmed);
  for (const token of tokens) {
    if (token.kind === "text") continue; // a value; only a table position is checked, below.
    if (/^pragma_/i.test(token.value)) return token.value.toLowerCase();
  }
  for (const table of tableNames(tokens)) {
    const name = table.name.toLowerCase();
    if (name.startsWith("pragma_")) return name;
    if (table.write && name.startsWith("sqlite_") && !PLUGIN_WRITABLE_SCHEMA_TABLES.has(name)) {
      return `${table.verb} ${name}`;
    }
  }

  if (keyword !== "PRAGMA") return null;

  const rest = trimmed.slice(keyword.length).trim();
  const name = (/^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0] ?? "").toLowerCase();
  if (!PLUGIN_ALLOWED_PRAGMAS.has(name)) {
    return `PRAGMA ${name === "" ? rest.slice(0, 24) : name}`;
  }
  // `journal_mode` may be READ (the plugin can ask what mode its file is in) but never set: the
  // host opens every plugin file in WAL on purpose (concurrent read while the plugin writes).
  if (name === "journal_mode" && /[=(]/.test(rest)) return "PRAGMA journal_mode (write)";
  return null;
};

/**
 * A statement the guard refused. A separate class from {@link PluginStorageError} so the plugin
 * author reads the RULE (`storage: statement not allowed: ATTACH`) rather than a sqlite error
 * wrapped in "plugin storage query failed". Reaches the web half as `PluginRpcError`
 * `plugin-failed` with this text as `detail`, like any other rejection out of a handler.
 */
export class PluginStorageStatementError extends Schema.TaggedErrorClass<PluginStorageStatementError>()(
  "PluginStorageStatementError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `storage: statement not allowed: ${this.reason}`;
  }
}

/**
 * Split, then check. `allowMultiple: false` is `query` — one statement per call, because
 * `node:sqlite` compiles only the first anyway and silently dropping the rest is how a guard gets
 * bypassed by accident.
 */
const guardedStatements = (
  sqlText: string,
  options: { readonly allowMultiple: boolean },
): Effect.Effect<ReadonlyArray<string>, PluginStorageStatementError> =>
  Effect.suspend(() => {
    const statements = splitSqlStatements(sqlText);
    if (statements.length === 0) {
      return Effect.fail(new PluginStorageStatementError({ reason: "(empty)" }));
    }
    if (!options.allowMultiple && statements.length > 1) {
      return Effect.fail(
        new PluginStorageStatementError({
          reason: `${String(statements.length)} statements in one call`,
        }),
      );
    }
    for (const statement of statements) {
      const rejected = pluginStatementRejection(statement);
      if (rejected !== null) {
        return Effect.fail(new PluginStorageStatementError({ reason: rejected }));
      }
    }
    return Effect.succeed(statements as ReadonlyArray<string>);
  });

/** What one `runPluginMigrations` pass did. `ok: false` disables that plugin. */
export type PluginMigrationOutcome =
  | { readonly ok: true; readonly applied: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly applied: ReadonlyArray<string>;
      readonly failedId: string;
      readonly error: string;
    };

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * What a failed `host.storage.*` call rejects with.
 *
 * A tagged error rather than a bare `Error`: it keeps the failure typed inside
 * the host (untagged errors merge in the Effect failure channel) while still
 * being a real `Error` subclass, so a plugin author sees a normal rejected
 * promise with a readable `message` and the sqlite text intact.
 */
export class PluginStorageError extends Schema.TaggedErrorClass<PluginStorageError>()(
  "PluginStorageError",
  { sql: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `plugin storage query failed: ${describeError(this.cause)}`;
  }
}

/**
 * Run every not-yet-applied migration, in declaration order, in the plugin's own
 * file. Never fails — the outcome is data, because a broken migration disables
 * ONE plugin and must not propagate into the host's startup.
 */
export const runPluginMigrations = (
  sql: SqlClient.SqlClient,
  migrations: ReadonlyArray<PluginMigration>,
): Effect.Effect<PluginMigrationOutcome> =>
  Effect.gen(function* () {
    const applied: Array<string> = [];

    // S111 #15 / F4 — the WHOLE list first (`@smart-tools/plugin-sdk/host-rules`
    // `migrationIdProblem`, the rule the playground and the fakes import too): a blank or repeated
    // id fails the plugin, named, and NOTHING runs — not the migrations declared before it either
    // (V2-64, rule 37 "boundaries validate").
    const problem = migrationIdProblem(migrations);
    if (problem !== null)
      return { ok: false, applied, ...problem } satisfies PluginMigrationOutcome;

    const bootstrap = yield* Effect.result(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `CREATE TABLE IF NOT EXISTS ${PLUGIN_MIGRATIONS_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
        );
        return yield* sql.unsafe<{ readonly id: string }>(
          `SELECT id FROM ${PLUGIN_MIGRATIONS_TABLE}`,
        );
      }),
    );
    if (Result.isFailure(bootstrap)) {
      return {
        ok: false,
        applied,
        failedId: PLUGIN_MIGRATIONS_TABLE,
        error: describeError(bootstrap.failure),
      } satisfies PluginMigrationOutcome;
    }

    const alreadyApplied = new Set(bootstrap.success.map((row) => row.id));
    for (const migration of migrations) {
      if (alreadyApplied.has(migration.id)) continue;

      const statements = migrationStatements(migration.sql);
      // ru-code (A13, A12 finding R1-H3): a migration is plugin-authored SQL too, and it runs
      // BEFORE `activate` with the same connection — so it goes through the same guard. A refused
      // statement fails the migration (and disables that plugin) rather than being skipped.
      const rejected = statements
        .map((statement) => pluginStatementRejection(statement))
        .find((reason) => reason !== null);
      if (rejected !== undefined && rejected !== null) {
        return {
          ok: false,
          applied,
          failedId: migration.id,
          error: `storage: statement not allowed: ${rejected}`,
        } satisfies PluginMigrationOutcome;
      }
      const outcome = yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            for (const statement of statements) {
              yield* sql.unsafe(statement);
            }
            const appliedAt = DateTime.formatIso(yield* DateTime.now);
            yield* sql`INSERT INTO ${sql(PLUGIN_MIGRATIONS_TABLE)} (id, applied_at) VALUES (${migration.id}, ${appliedAt})`;
          }),
        ),
      );

      if (Result.isFailure(outcome)) {
        return {
          ok: false,
          applied,
          failedId: migration.id,
          error: describeError(outcome.failure),
        } satisfies PluginMigrationOutcome;
      }
      applied.push(migration.id);
      alreadyApplied.add(migration.id);
    }

    return { ok: true, applied } satisfies PluginMigrationOutcome;
  }).pipe(
    // A defect anywhere in the runner (a plugin handing us a non-array, a
    // malformed migration object) must still only disable that plugin.
    Effect.catchCause((cause) =>
      Effect.succeed({
        ok: false,
        applied: [],
        failedId: "(unknown)",
        error: describeError(cause),
      } satisfies PluginMigrationOutcome),
    ),
    Effect.withSpan("plugins.runPluginMigrations"),
  );

/**
 * The promise-based handle handed to the plugin (D6 — no `effect` value crosses
 * the boundary). Bound to one client; there is no way to name another file.
 *
 * `run` is the captured runtime's `Effect.runPromiseWith(context)` — the plugin
 * calls this from ordinary async code, so the effect has to be executed on the
 * server's runtime rather than yielded.
 */
export const makePluginStorage = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}): PluginStorage => {
  const execute = <Row extends object>(sqlText: string, params?: ReadonlyArray<unknown>) =>
    input.sql
      .unsafe<Row>(sqlText, params === undefined ? undefined : [...params])
      .pipe(Effect.mapError((cause) => new PluginStorageError({ sql: sqlText, cause })));

  return {
    query: <Row = Record<string, unknown>>(sqlText: string, params?: ReadonlyArray<unknown>) =>
      input.run(
        guardedStatements(sqlText, { allowMultiple: false }).pipe(
          Effect.flatMap((statements) =>
            execute<Record<string, unknown>>(statements[0] ?? sqlText, params),
          ),
        ),
      ) as Promise<ReadonlyArray<Row>>,
    // `exec` MAY carry several statements — that is what a plugin reaches for when it seeds a
    // couple of tables — and each one is checked. With bound parameters it is one statement only:
    // a parameter list cannot be shared across statements without guessing which `?` belongs where.
    exec: (sqlText: string, params?: ReadonlyArray<unknown>) =>
      input.run(
        guardedStatements(sqlText, { allowMultiple: params === undefined }).pipe(
          Effect.flatMap((statements) =>
            Effect.gen(function* () {
              for (const statement of statements) {
                yield* execute<Record<string, unknown>>(statement, params);
              }
            }),
          ),
          Effect.asVoid,
        ),
      ),
  };
};
