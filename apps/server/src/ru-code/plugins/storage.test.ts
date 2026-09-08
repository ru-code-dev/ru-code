// ru-code: the statement splitter that stands between a plugin migration and a
// SILENTLY half-applied schema.
//
// `node:sqlite`'s `prepare()` compiles only the FIRST statement of the text it is
// handed and discards the rest, so a two-statement migration body would create
// the table, skip the index, and still record itself as applied in
// `_plugin_migrations` — the exact failure a migration runner exists to prevent
// (D10). `splitSqlStatements` is therefore load-bearing, hand-rolled and worth
// pinning: every case below is a body a plugin author can plausibly write where a
// naive `split(";")` would cut a statement in half.
//
// The end-to-end behaviour (a multi-statement migration really creating both
// objects in the plugin's own file) is asserted in `PluginHost.test.ts`; this
// suite is the character-level matrix underneath it.
import { describe, expect, it } from "@effect/vitest";

import { migrationStatements, pluginStatementRejection, splitSqlStatements } from "./storage.ts";

describe("splitSqlStatements", () => {
  it("returns a single-statement body unchanged, with or without a trailing ;", () => {
    expect(splitSqlStatements("CREATE TABLE notes (id INTEGER)")).toEqual([
      "CREATE TABLE notes (id INTEGER)",
    ]);
    expect(splitSqlStatements("CREATE TABLE notes (id INTEGER);")).toEqual([
      "CREATE TABLE notes (id INTEGER)",
    ]);
  });

  it("splits several statements and drops empty ones", () => {
    expect(
      splitSqlStatements(`
        CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        ;
        CREATE INDEX notes_body ON notes (body);
      `),
    ).toEqual([
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
      "CREATE INDEX notes_body ON notes (body)",
    ]);
  });

  it("never cuts inside a string literal", () => {
    expect(splitSqlStatements("INSERT INTO t (a) VALUES ('x; y'); SELECT 1")).toEqual([
      "INSERT INTO t (a) VALUES ('x; y')",
      "SELECT 1",
    ]);
  });

  it("honours a doubled quote as an escape, not as the end of the literal", () => {
    expect(splitSqlStatements("INSERT INTO t (a) VALUES ('it''s; fine'); SELECT 2")).toEqual([
      "INSERT INTO t (a) VALUES ('it''s; fine')",
      "SELECT 2",
    ]);
  });

  it("never cuts inside a quoted identifier in any of sqlite's three spellings", () => {
    expect(splitSqlStatements('CREATE TABLE "a;b" (x INTEGER); SELECT 3')).toEqual([
      'CREATE TABLE "a;b" (x INTEGER)',
      "SELECT 3",
    ]);
    expect(splitSqlStatements("CREATE TABLE [a;b] (x INTEGER); SELECT 4")).toEqual([
      "CREATE TABLE [a;b] (x INTEGER)",
      "SELECT 4",
    ]);
    expect(splitSqlStatements("CREATE TABLE `a;b` (x INTEGER); SELECT 5")).toEqual([
      "CREATE TABLE `a;b` (x INTEGER)",
      "SELECT 5",
    ]);
  });

  it("strips line and block comments, including a ; hidden inside one", () => {
    expect(
      splitSqlStatements(`
        -- a note; with a semicolon
        CREATE TABLE notes (id INTEGER);
        /* another; note
           over two lines */
        CREATE INDEX i ON notes (id);
      `),
    ).toEqual(["CREATE TABLE notes (id INTEGER)", "CREATE INDEX i ON notes (id)"]);
  });

  it("yields nothing for an empty or comment-only body", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("   \n  ")).toEqual([]);
    expect(splitSqlStatements("-- nothing to do\n")).toEqual([]);
  });

  it("tolerates an unterminated literal or comment instead of looping forever", () => {
    expect(splitSqlStatements("SELECT 'unterminated")).toEqual(["SELECT 'unterminated"]);
    expect(splitSqlStatements("SELECT 1; /* unterminated")).toEqual(["SELECT 1"]);
  });

  // ── A12 round 2, finding R2-M4 ──────────────────────────────────────────────────────────────
  //
  // A trigger body ALWAYS contains at least one `;`, so the old splitter cut the auditor's
  // migration into `CREATE TRIGGER … BEGIN UPDATE …` and a bare `END`, and the plugin was
  // disabled with `migration "002" failed: Failed to prepare statement`. The doc comment's
  // workaround ("put it in a migration of its own") could not work either — this fixture IS a
  // migration of its own.
  it("keeps a CREATE TRIGGER … BEGIN … END body intact (R2-M4)", () => {
    const trigger =
      "CREATE TRIGGER t_ins AFTER INSERT ON t BEGIN UPDATE t SET n = 1 WHERE id = new.id; END";
    expect(splitSqlStatements(`${trigger};`)).toEqual([trigger]);
    expect(
      splitSqlStatements(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER);\n${trigger};`),
    ).toEqual(["CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)", trigger]);
  });

  it("does not let a CASE … END inside a trigger body close the block (R2-M4)", () => {
    const trigger =
      "CREATE TRIGGER t_upd AFTER UPDATE ON t BEGIN " +
      "UPDATE t SET n = CASE WHEN new.n > 0 THEN 1 ELSE 0 END WHERE id = new.id; " +
      "INSERT INTO log (id) VALUES (new.id); END";
    expect(splitSqlStatements(`${trigger}; SELECT 1;`)).toEqual([trigger, "SELECT 1"]);
  });

  it("still splits after the trigger, and leaves BEGIN TRANSACTION alone (R2-M4)", () => {
    // A bare `BEGIN` is not a trigger body: only one that follows `CREATE … TRIGGER` opens a
    // block, so an ordinary transaction keyword cannot swallow the rest of the migration.
    expect(splitSqlStatements("BEGIN; SELECT 1; COMMIT;")).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    // `ENDING` is not `END`, and `DROP TRIGGER` opens nothing.
    expect(splitSqlStatements("DROP TRIGGER t_ins; SELECT ending FROM t;")).toEqual([
      "DROP TRIGGER t_ins",
      "SELECT ending FROM t",
    ]);
  });
});

// ru-code (A13) — A12 finding R1-H3: the statement guard, character by character.
//
// `node:sqlite` binds no authorizer, so the "one file per plugin" boundary (D2) is enforced on the
// TEXT. What matters is that the keyword cannot be hidden: behind a comment, behind whitespace,
// behind a schema qualifier, or behind a second statement in the same call.
describe("pluginStatementRejection", () => {
  const allowed = (sql: string) => expect(pluginStatementRejection(sql)).toBeNull();
  const refused = (sql: string, reason: string) =>
    expect(pluginStatementRejection(sql)).toBe(reason);

  it("passes ordinary DDL and DML through", () => {
    allowed("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
    allowed("INSERT INTO notes (body) VALUES (?)");
    allowed("SELECT id, body FROM notes ORDER BY id");
    allowed("DELETE FROM notes");
    allowed("BEGIN");
    // A string literal that merely CONTAINS the word is not a statement keyword.
    allowed("INSERT INTO notes (body) VALUES ('ATTACH DATABASE x')");
  });

  it("refuses ATTACH and DETACH in any casing or spacing", () => {
    refused("ATTACH DATABASE '/x/state.sqlite' AS app", "ATTACH");
    refused("attach database 'x' as app", "ATTACH");
    refused("   \n\t ATTACH DATABASE 'x' AS app", "ATTACH");
    refused("DETACH DATABASE app", "DETACH");
    refused("detach app", "DETACH");
  });

  it("refuses every pragma outside the allowlist, schema-qualified ones included", () => {
    refused("PRAGMA database_list", "PRAGMA database_list");
    refused("PRAGMA main.database_list", "PRAGMA main");
    refused("PRAGMA app.table_info(notes)", "PRAGMA app");
    refused("pragma temp_store_directory = '/tmp'", "PRAGMA temp_store_directory");
    refused("PRAGMA journal_mode = DELETE", "PRAGMA journal_mode (write)");
  });

  it("allows the small read-only set a plugin legitimately needs", () => {
    allowed("PRAGMA user_version");
    allowed("PRAGMA user_version = 3");
    allowed("PRAGMA table_info(notes)");
    allowed("PRAGMA foreign_keys = ON");
    allowed("PRAGMA journal_mode");
  });

  it("cannot be hidden behind a comment, because the splitter removes them first", () => {
    // This is how the guard is actually reached: `splitSqlStatements` normalises the text, then
    // every statement it returns is checked.
    const statements = splitSqlStatements("-- share data\n/* really */ ATTACH DATABASE 'x' AS app");
    expect(statements).toHaveLength(1);
    refused(statements[0] ?? "", "ATTACH");
  });

  it("catches a refused statement hidden behind an innocent first one", () => {
    const statements = splitSqlStatements("SELECT 1; ATTACH DATABASE 'x' AS app");
    expect(statements.map((statement) => pluginStatementRejection(statement))).toEqual([
      null,
      "ATTACH",
    ]);
  });

  // ── A12 round 2, finding R2-M2 ──────────────────────────────────────────────────────────────
  //
  // Every pragma also has a table-valued-FUNCTION form whose first keyword is `SELECT`, so the
  // keyword check never looked at it: `SELECT * FROM pragma_database_list` served the absolute
  // path of the plugin's own file, `pragma_table_list` its whole schema, `pragma_function_list`
  // the sqlite build. The guard's documented rule was sidesteppable by a mechanical rewrite.
  it("refuses the pragma_* table-valued functions, in every spelling (R2-M2)", () => {
    refused("SELECT * FROM pragma_database_list", "pragma_database_list");
    refused("SELECT * FROM pragma_database_list()", "pragma_database_list");
    refused("select name from PRAGMA_TABLE_LIST", "pragma_table_list");
    refused("SELECT * FROM pragma_compile_options", "pragma_compile_options");
    refused("SELECT name FROM pragma_function_list", "pragma_function_list");
    refused("SELECT * FROM main.pragma_module_list", "pragma_module_list");
    refused('SELECT * FROM "pragma_table_list"', "pragma_table_list");
    refused("SELECT * FROM pragma_journal_mode('delete')", "pragma_journal_mode");
    // Even inside a CTE or a subquery — the name is refused wherever it appears.
    refused(
      "WITH x AS (SELECT * FROM pragma_database_list) SELECT * FROM x",
      "pragma_database_list",
    );
  });

  it("does not mistake a plugin's own data for a pragma function (R2-M2)", () => {
    // A single-quoted literal is blanked before the check: storing the word is not calling it.
    allowed("INSERT INTO notes (body) VALUES ('see pragma_table_list for details')");
    // `_` is a word character, so a table whose name merely ends in the prefix is untouched.
    allowed("SELECT * FROM my_pragma_notes");
  });

  it("keeps the sqlite_ schema tables READ-only (R2-M2)", () => {
    allowed("SELECT name FROM sqlite_master WHERE type = 'table'");
    refused("INSERT INTO sqlite_master (name) VALUES ('x')", "INSERT sqlite_master");
    refused("UPDATE sqlite_master SET sql = 'x'", "UPDATE sqlite_master");
    refused("delete from sqlite_temp_master", "DELETE sqlite_temp_master");
  });

  // ── A12 round 3 ───────────────────────────────────────────────────────────────────────────
  //
  // R3-M1: SQLite accepts a STRING LITERAL where a table name is expected and resolves it to the
  // same object — so `SELECT * FROM 'pragma_database_list'` is the pragma the guard exists to
  // refuse, and round 2 blanked single-quoted runs BEFORE it looked. The auditor read the file
  // path out of the plugin's own database with it and then parked the whole schema in a VIEW,
  // where no later statement mentions `pragma_` at all.
  it("refuses a pragma_* SINGLE-QUOTED in table position (R3-M1)", () => {
    refused("SELECT * FROM 'pragma_database_list'", "pragma_database_list");
    refused("SELECT * FROM 'pragma_table_list' LIMIT 6", "pragma_table_list");
    refused("SELECT * FROM 'pragma_table_info'('bookmarks')", "pragma_table_info");
    refused(
      "SELECT name FROM 'pragma_function_list' WHERE name LIKE 'load%'",
      "pragma_function_list",
    );
    refused("SELECT * FROM 'pragma_compile_options' LIMIT 4", "pragma_compile_options");
    // The parking spots: one allowed statement and the answer lives in the plugin's own schema.
    refused("CREATE VIEW v_leak AS SELECT * FROM 'pragma_database_list'", "pragma_database_list");
    refused("CREATE TABLE leak AS SELECT * FROM 'pragma_table_list'", "pragma_table_list");
    refused("SELECT * FROM notes JOIN 'pragma_table_list' ON 1 = 1", "pragma_table_list");
  });

  it("still reads a string in a VALUE position as data (R3-M1)", () => {
    allowed("INSERT INTO notes (body) VALUES ('pragma_table_list')");
    allowed("INSERT INTO notes (body) VALUES ('pragma_x')");
    allowed("SELECT * FROM notes WHERE body = 'pragma_database_list'");
    allowed("UPDATE notes SET body = 'pragma_table_info' WHERE id = 1");
    // …and an ordinary quoted table name is still an ordinary table.
    allowed("SELECT * FROM 'notes'");
    allowed("INSERT INTO 'notes' (body) VALUES (?)");
  });

  // R3-L1: rule 4 keyed on the statement's FIRST keyword, so a write hidden behind a CTE or
  // inside a trigger body passed the guard. SQLite refuses the write itself — but the TRIGGER is
  // created, and every later INSERT into the plugin's own table then fails to prepare, i.e. a
  // plugin could brick its own table through a statement the guard advertised as refused.
  it("finds a sqlite_ write wherever the write keyword sits (R3-L1)", () => {
    refused("WITH c AS (SELECT 1) UPDATE sqlite_master SET sql = 'x'", "UPDATE sqlite_master");
    refused(
      "CREATE TRIGGER t AFTER INSERT ON notes BEGIN UPDATE sqlite_master SET sql = 'x'; END",
      "UPDATE sqlite_master",
    );
    // A READ of the schema table from inside the same shapes is still fine.
    allowed("WITH c AS (SELECT name FROM sqlite_master) SELECT * FROM c");
  });

  // R3-L2: `sqlite_sequence` is the one schema table SQLite deliberately lets an application
  // write — it is how an `AUTOINCREMENT` counter is reset, and README §5's own example ships that
  // column shape.
  it("lets a plugin reset its own AUTOINCREMENT counters (R3-L2)", () => {
    allowed("DELETE FROM sqlite_sequence WHERE name = 'notes'");
    allowed("delete from sqlite_sequence");
    allowed("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'notes'");
  });
});

/**
 * R3-M2: inside a trigger body the WORD `END` closes the block — and `end` is a legal SQLite
 * column name (`start`/`end` is the ordinary naming for a time range), so the splitter cut the
 * auditor's migration in half and disabled the plugin with the pre-fix message. The answer is not
 * another heuristic: the contract now takes an ARRAY of statements, which is not split at all.
 */
describe("migrationStatements (R3-M2)", () => {
  it("takes each element of an array as exactly one statement, unsplit", () => {
    const trigger =
      "CREATE TRIGGER s_ins AFTER INSERT ON spans BEGIN INSERT INTO log (m) SELECT new.end; END";
    expect(migrationStatements(["CREATE TABLE log (m INTEGER)", trigger])).toEqual([
      "CREATE TABLE log (m INTEGER)",
      trigger,
    ]);
    // BEFORE: the string form cuts exactly this body in two — which is the finding.
    expect(splitSqlStatements(`${trigger};`)).toHaveLength(2);
  });

  it("keeps the splitter for the string form, and drops empty elements", () => {
    expect(migrationStatements("CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER)")).toEqual([
      "CREATE TABLE a (x INTEGER)",
      "CREATE TABLE b (y INTEGER)",
    ]);
    expect(migrationStatements(["SELECT 1", "  ", ""])).toEqual(["SELECT 1"]);
    expect(migrationStatements(undefined as unknown as string)).toEqual([]);
  });
});
