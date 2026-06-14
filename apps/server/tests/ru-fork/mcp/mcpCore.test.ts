// ru-fork: unit tests for the pure @ru-fork/mcp-core logic — template + vars
// resolution, the cache key, dedup hash, tool-policy intersection, the overlay
// fingerprint, and the incomplete-gating check. These encode the vars/template
// config model (mcp-vars-redesign.md).

import type { McpServerConfig, McpServerVar, McpTool, McpToolPolicy, McpVarValue } from "@t3tools/contracts";
import {
  configCacheKey,
  dedupHash,
  effectiveAllowedTools,
  missingRequiredVars,
  overlayFingerprint,
  paramsFromInputSchema,
  resolveConfig,
  resolveVarValues,
  type ResolveContext,
  type ResolvedServerConfig,
} from "@ru-fork/mcp-core";
import { describe, expect, it } from "vitest";

// A Confluence-style stdio server: a secret token (env), a per-project space id
// referenced in args, and `${PROJECT_CWD}` in args.
const stdioConfig: McpServerConfig = {
  transport: "stdio",
  command: "uvx",
  args: ["mcp-atlassian", "--root", "${PROJECT_CWD}", "--space", "${SPACE_ID}"],
};

const vars: ReadonlyArray<McpServerVar> = [
  { name: "CONFLUENCE_TOKEN", secret: true, perProject: false, required: false, value: { secretRef: "tok" }, origin: "user" },
  { name: "SPACE_ID", secret: false, perProject: true, required: true, value: null, origin: "user" },
];

const secretValues = { tok: "ATATT-secret" };

const context = (projectCwd: string): ResolveContext => ({ projectCwd, secretValues });

const resolve = (input: {
  varValues?: Record<string, McpVarValue>;
  projectCwd?: string;
  timeoutMs?: number;
}): ResolvedServerConfig =>
  resolveConfig({
    config: stdioConfig,
    vars,
    varValues: input.varValues ?? { SPACE_ID: "ENG" },
    extraArgs: [],
    extraHeaders: {},
    timeoutMs: input.timeoutMs,
    context: context(input.projectCwd ?? "/work/proj-a"),
  });

describe("resolveConfig — template + vars", () => {
  it("materializes secrets into env and substitutes vars + ${PROJECT_CWD} in args", () => {
    const resolved = resolve({});
    expect(resolved.transport).toBe("stdio");
    expect(resolved.cwd).toBe("/work/proj-a");
    // every var is exported as an env var (secret materialized, plain as-is)
    expect(resolved.env).toEqual({ CONFLUENCE_TOKEN: "ATATT-secret", SPACE_ID: "ENG" });
    // ${PROJECT_CWD} → project dir; ${SPACE_ID} → the per-project value
    expect(resolved.args).toEqual(["mcp-atlassian", "--root", "/work/proj-a", "--space", "ENG"]);
  });

  it("carries the timeout through when provided", () => {
    expect(resolve({ timeoutMs: 12_000 }).timeoutMs).toBe(12_000);
    expect(resolve({}).timeoutMs).toBeUndefined();
  });

  it("a per-project hole with no value resolves to an empty string", () => {
    const resolved = resolve({ varValues: {} });
    expect(resolved.env?.SPACE_ID).toBe("");
    expect(resolved.args).toContain("--space");
  });
});

describe("resolveConfig — http", () => {
  const httpConfig: McpServerConfig = {
    transport: "http",
    httpUrl: "https://${HOST}/mcp",
    headers: { Authorization: "Bearer ${TOKEN}", "X-Space": "${SPACE_ID}" },
  };
  const httpVars: ReadonlyArray<McpServerVar> = [
    { name: "HOST", secret: false, perProject: false, required: true, value: "api.example.com", origin: "user" },
    { name: "TOKEN", secret: true, perProject: false, required: true, value: { secretRef: "tok" }, origin: "user" },
    { name: "SPACE_ID", secret: false, perProject: true, required: false, value: null, origin: "user" },
  ];
  const resolveHttp = (input: {
    varValues?: Record<string, McpVarValue>;
    extraHeaders?: Record<string, string>;
  }): ResolvedServerConfig =>
    resolveConfig({
      config: httpConfig,
      vars: httpVars,
      varValues: input.varValues ?? { SPACE_ID: "ENG" },
      extraArgs: [],
      extraHeaders: input.extraHeaders ?? {},
      timeoutMs: undefined,
      context: { projectCwd: "/work", secretValues: { tok: "ATATT" } },
    });

  it("expands ${VAR} in httpUrl and headers, materializing the secret", () => {
    const resolved = resolveHttp({});
    if (resolved.transport !== "http") throw new Error("expected http transport");
    expect(resolved.httpUrl).toBe("https://api.example.com/mcp");
    expect(resolved.headers).toEqual({ Authorization: "Bearer ATATT", "X-Space": "ENG" });
  });

  it("merges extraHeaders OVER config headers (and expands them too)", () => {
    const resolved = resolveHttp({ extraHeaders: { "X-Space": "${SPACE_ID}-x", "X-New": "1" } });
    if (resolved.transport !== "http") throw new Error("expected http transport");
    expect(resolved.headers["X-Space"]).toBe("ENG-x"); // extra wins
    expect(resolved.headers["X-New"]).toBe("1"); // extra adds
    expect(resolved.headers.Authorization).toBe("Bearer ATATT"); // base kept
  });

  it("http resolve carries the timeout and has no env/cwd", () => {
    const resolved = resolveConfig({
      config: httpConfig,
      vars: httpVars,
      varValues: { SPACE_ID: "ENG" },
      extraArgs: [],
      extraHeaders: {},
      timeoutMs: 9000,
      context: { projectCwd: "/work", secretValues: { tok: "ATATT" } },
    });
    if (resolved.transport !== "http") throw new Error("expected http transport");
    expect(resolved.timeoutMs).toBe(9000);
    expect("env" in resolved).toBe(false);
  });
});

describe("substitution rules", () => {
  const run = (args: ReadonlyArray<string>, lookup: Record<string, McpVarValue>) =>
    resolveConfig({
      config: { transport: "stdio", command: "x", args },
      vars: Object.keys(lookup).map((name) => ({
        name,
        secret: false,
        perProject: false,
        required: false,
        value: null,
        origin: "user" as const,
      })),
      varValues: lookup,
      extraArgs: [],
      extraHeaders: {},
      timeoutMs: undefined,
      context: context("/cwd"),
    }).args;

  it("only braced ${NAME} is a placeholder — bare $NAME stays literal", () => {
    expect(run(["${V}", "$V", "a$Vb"], { V: "x" })).toEqual(["x", "$V", "a$Vb"]);
  });

  it("$$ escapes a literal $", () => {
    expect(run(["price$$5", "$${V}"], { V: "x" })).toEqual(["price$5", "${V}"]);
  });

  it("undeclared ${X} resolves to empty", () => {
    expect(run(["a${MISSING}b"], {})).toEqual(["ab"]);
  });

  it("secret values are opaque — a $ / ${} inside a secret is inserted verbatim", () => {
    const resolved = resolveConfig({
      config: { transport: "stdio", command: "x", args: ["--t", "${TOKEN}"] },
      vars: [
        { name: "TOKEN", secret: true, perProject: false, required: false, value: { secretRef: "r" }, origin: "user" as const },
      ],
      varValues: {},
      extraArgs: [],
      extraHeaders: {},
      timeoutMs: undefined,
      context: { projectCwd: "/cwd", secretValues: { r: "pa$$w${HOME}rd" } },
    });
    expect(resolved.args?.[1]).toBe("pa$$w${HOME}rd");
  });
});

describe("resolveVarValues", () => {
  it("binding value overrides the catalog default; plain expands ${PROJECT_CWD}", () => {
    const resolved = resolveVarValues(
      [
        { name: "ROOT", secret: false, perProject: true, required: false, value: "${PROJECT_CWD}", origin: "user" },
        { name: "TOKEN", secret: true, perProject: false, required: false, value: { secretRef: "tok" }, origin: "user" },
      ],
      { ROOT: "${PROJECT_CWD}/sub" },
      context("/work/p"),
    );
    expect(resolved).toEqual({ ROOT: "/work/p/sub", TOKEN: "ATATT-secret" });
  });
});

describe("configCacheKey", () => {
  it("is stable for the same config + vars + values", () => {
    expect(configCacheKey(stdioConfig, vars, { SPACE_ID: "ENG" }, [], {})).toBe(
      configCacheKey(stdioConfig, vars, { SPACE_ID: "ENG" }, [], {}),
    );
  });

  it("differs when a per-project value differs (separate cache rows)", () => {
    expect(configCacheKey(stdioConfig, vars, { SPACE_ID: "ENG" }, [], {})).not.toBe(
      configCacheKey(stdioConfig, vars, { SPACE_ID: "OPS" }, [], {}),
    );
  });

  it("is the same across projects on the catalog default (no per-project values)", () => {
    expect(configCacheKey(stdioConfig, vars, {}, [], {})).toBe(
      configCacheKey(stdioConfig, vars, {}, [], {}),
    );
  });

  it("differs when extraArgs differ (a template's extra args reset the cache → status)", () => {
    expect(configCacheKey(stdioConfig, vars, {}, [], {})).not.toBe(
      configCacheKey(stdioConfig, vars, {}, ["--read-only"], {}),
    );
  });

  it("differs when extraHeaders differ (an http template's extra headers reset the cache → status)", () => {
    expect(configCacheKey(stdioConfig, vars, {}, [], {})).not.toBe(
      configCacheKey(stdioConfig, vars, {}, [], { Authorization: "Bearer x" }),
    );
  });
});

describe("dedupHash", () => {
  it("differs by resolved cwd, collapses when cwd + values match", () => {
    expect(dedupHash(resolve({ projectCwd: "/a" }))).not.toBe(dedupHash(resolve({ projectCwd: "/b" })));
    expect(dedupHash(resolve({ projectCwd: "/x" }))).toBe(dedupHash(resolve({ projectCwd: "/x" })));
  });
});

describe("missingRequiredVars", () => {
  it("flags a required per-project var with no value or default", () => {
    expect(missingRequiredVars(vars, {})).toEqual(["SPACE_ID"]);
    expect(missingRequiredVars(vars, { SPACE_ID: "ENG" })).toEqual([]);
  });

  it("a required var with a catalog default is satisfied", () => {
    const withDefault: ReadonlyArray<McpServerVar> = [
      { name: "X", secret: false, perProject: true, required: true, value: "def", origin: "user" },
    ];
    expect(missingRequiredVars(withDefault, {})).toEqual([]);
  });

  it("flags a CATALOG-level required var with no value (widened — not only per-project)", () => {
    const catalogRequired: ReadonlyArray<McpServerVar> = [
      { name: "TOKEN", secret: true, perProject: false, required: true, value: null, origin: "shipped" },
    ];
    expect(missingRequiredVars(catalogRequired, {})).toEqual(["TOKEN"]);
    // A catalog default satisfies it without any per-project value.
    const withCatalogValue: ReadonlyArray<McpServerVar> = [
      { name: "TOKEN", secret: false, perProject: false, required: true, value: "abc", origin: "shipped" },
    ];
    expect(missingRequiredVars(withCatalogValue, {})).toEqual([]);
  });
});

describe("effectiveAllowedTools", () => {
  const tools: ReadonlyArray<McpTool> = [
    { name: "read_file", description: "" },
    { name: "write_file", description: "" },
    { name: "list_dir", description: "" },
  ];

  it("allow-by-default returns all except the exceptions", () => {
    const policy: McpToolPolicy = { defaultDecision: "allow", exceptions: ["write_file"] };
    expect(effectiveAllowedTools(policy, tools)).toEqual(["read_file", "list_dir"]);
  });

  it("deny-by-default returns only the discovered exceptions", () => {
    const policy: McpToolPolicy = { defaultDecision: "deny", exceptions: ["read_file", "nope"] };
    expect(effectiveAllowedTools(policy, tools)).toEqual(["read_file"]);
  });
});

describe("overlayFingerprint", () => {
  const resolvedA = resolve({});
  const allowAll: McpToolPolicy = { defaultDecision: "allow", exceptions: [] };

  it("is independent of entry order", () => {
    const a = [
      { serverName: "fs", resolved: resolvedA, toolPolicy: allowAll },
      { serverName: "c7", resolved: resolve({ projectCwd: "/other" }), toolPolicy: allowAll },
    ];
    expect(overlayFingerprint(a)).toBe(overlayFingerprint(a.toReversed()));
  });

  it("flips when a tool policy changes", () => {
    const before = [{ serverName: "fs", resolved: resolvedA, toolPolicy: allowAll }];
    const after = [
      { serverName: "fs", resolved: resolvedA, toolPolicy: { defaultDecision: "deny", exceptions: ["x"] } },
    ];
    expect(overlayFingerprint(before)).not.toBe(overlayFingerprint(after));
  });
});

describe("paramsFromInputSchema", () => {
  it("maps properties → name/type/required/description and resolves the required set", () => {
    const params = paramsFromInputSchema({
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "number" },
      },
      required: ["path"],
    });
    expect(params).toEqual([
      { name: "path", type: "string", required: true, description: "File path" },
      { name: "limit", type: "number", required: false, description: "" },
    ]);
  });

  it("labels an array as `<item>[]`, falling back to `array` when items are untyped", () => {
    const params = paramsFromInputSchema({
      properties: {
        tags: { type: "array", items: { type: "string" } },
        mixed: { type: "array" },
      },
    });
    expect(params[0]?.type).toBe("string[]");
    expect(params[1]?.type).toBe("array");
  });

  it("a property with no `type` is labelled `any`; no properties ⇒ no params", () => {
    expect(paramsFromInputSchema({ properties: { x: { description: "?" } } })[0]?.type).toBe("any");
    expect(paramsFromInputSchema({})).toEqual([]);
  });
});
