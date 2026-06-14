// ru-fork: unit tests for the managed built-ins migrator logic — the content hash (drives
// "shipped template changed → update"), platform resolution, shipped-var origin, the 3-way merge
// (buildSyncedBuiltin: shipped REPLACE, user data PRESERVED), and mergeTemplateVars (a locked
// template's shipped DECLARATIONS are immutable while shipped VALUES + user vars are editable).
// Encodes PART K4–K7.

import { DEFAULT_TOOL_POLICY, McpServerId, ProjectId } from "@t3tools/contracts";
import type {
  McpBinding,
  McpCatalogServer,
  McpServerDraft,
  McpServerDraftPatch,
  McpServerVarDraft,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { ServerSecretStore } from "../../../src/auth/Services/ServerSecretStore.ts";
import {
  applyServerUpdate,
  buildAddedServer,
  buildBinding,
  buildSyncedBuiltin,
  mergeTemplateVars,
} from "../../../src/ru-fork/mcp/McpCatalogBuilders.ts";
import {
  builtinConfigForPlatform,
  builtinHash,
  builtinServerId,
  builtinShippedVars,
  type McpBuiltinDefinition,
} from "../../../src/ru-fork/mcp/McpBuiltins.ts";

function fakeSecretStoreLayer() {
  const store = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore, {
    get: (name: string) => Effect.succeed(store.get(name) ?? null),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    getOrCreateRandom: (name: string, bytes: number) =>
      Effect.sync(() => store.get(name) ?? new Uint8Array(bytes)),
    remove: (name: string) =>
      Effect.sync(() => {
        store.delete(name);
      }),
    pruneByPrefix: () => Effect.void,
  });
}

const SECRET_TEMPLATE: McpBuiltinDefinition = {
  builtinId: "demo",
  name: "demo",
  description: "Demo template",
  config: {
    default: { transport: "stdio", command: "npx", args: ["-y", "demo", "${PROJECT_CWD}"] },
    win32: { transport: "stdio", command: "npx.cmd", args: ["-y", "demo", "${PROJECT_CWD}"] },
  },
  vars: [{ name: "TOKEN", secret: true, perProject: false, required: true, value: null }],
};

describe("builtinConfigForPlatform", () => {
  it("prefers the platform-specific variant, else default", () => {
    expect(builtinConfigForPlatform(SECRET_TEMPLATE, "win32")?.command).toBe("npx.cmd");
    expect(builtinConfigForPlatform(SECRET_TEMPLATE, "linux")?.command).toBe("npx");
  });

  it("returns null when neither a platform variant nor a default exists (skip the built-in)", () => {
    const noDefault: McpBuiltinDefinition = {
      builtinId: "x",
      name: "x",
      config: { win32: { transport: "stdio", command: "x", args: [] } },
      vars: [],
    };
    expect(builtinConfigForPlatform(noDefault, "linux")).toBeNull();
  });
});

describe("builtinShippedVars + builtinHash", () => {
  it("stamps origin:shipped and keeps the declared (null) secret value", () => {
    const [token] = builtinShippedVars(SECRET_TEMPLATE);
    expect(token).toEqual({
      name: "TOKEN",
      secret: true,
      perProject: false,
      required: true,
      value: null,
      origin: "shipped",
      valueLocked: false,
    });
  });

  it("is stable for the same definition+config and changes when the command changes", () => {
    const linux = builtinConfigForPlatform(SECRET_TEMPLATE, "linux")!;
    const win = builtinConfigForPlatform(SECRET_TEMPLATE, "win32")!;
    expect(builtinHash(linux, SECRET_TEMPLATE)).toBe(builtinHash(linux, SECRET_TEMPLATE));
    expect(builtinHash(linux, SECRET_TEMPLATE)).not.toBe(builtinHash(win, SECRET_TEMPLATE));
  });
});

describe("buildSyncedBuiltin — 3-way merge", () => {
  const shipped = builtinShippedVars(SECRET_TEMPLATE);
  const config = builtinConfigForPlatform(SECRET_TEMPLATE, "linux")!;
  const hash = builtinHash(config, SECRET_TEMPLATE);

  it("adds a fresh built-in: locked, source builtin, identity recorded", () => {
    const server = buildSyncedBuiltin({
      serverId: McpServerId.make(builtinServerId("demo")),
      builtinId: "demo",
      builtinHash: hash,
      name: "demo",
      description: "Demo template",
      websiteUrl: null,
      config,
      shippedVars: shipped,
      timeoutMs: null,
      existing: undefined,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(server.source).toBe("builtin");
    expect(server.locked).toBe(true);
    expect(server.builtinId).toBe("demo");
    expect(server.builtinHash).toBe(hash);
    expect(server.vars.map((variable) => variable.name)).toEqual(["TOKEN"]);
  });

  it("preserves the user's configured secret value + user vars + extraArgs across an update", () => {
    const existing: McpCatalogServer = {
      id: McpServerId.make(builtinServerId("demo")),
      name: "demo",
      description: "old",
      websiteUrl: null,
      source: "builtin",
      config: { transport: "stdio", command: "npx", args: ["old"] },
      vars: [
        { name: "TOKEN", secret: true, perProject: false, required: true, value: { secretRef: "kept" }, origin: "shipped" },
        { name: "EXTRA", secret: false, perProject: false, required: false, value: "u", origin: "user" },
      ],
      extraArgs: ["--flag"],
      extraHeaders: {},
      builtinId: "demo",
      builtinHash: "old-hash",
      locked: true,
      enabled: true,
      timeoutMs: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const server = buildSyncedBuiltin({
      serverId: existing.id,
      builtinId: "demo",
      builtinHash: hash,
      name: "demo",
      description: "Demo template",
      websiteUrl: null,
      config,
      shippedVars: shipped,
      timeoutMs: null,
      existing,
      occurredAt: "2026-06-10T00:00:00.000Z",
    });
    // shipped TOKEN keeps the user's stored ref; user EXTRA survives; extraArgs preserved; createdAt kept.
    const token = server.vars.find((variable) => variable.name === "TOKEN");
    expect(token?.value).toEqual({ secretRef: "kept" });
    expect(token?.origin).toBe("shipped");
    expect(server.vars.find((variable) => variable.name === "EXTRA")?.origin).toBe("user");
    expect(server.extraArgs).toEqual(["--flag"]);
    expect(server.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(server.builtinHash).toBe(hash);
  });
});

// A template with an author-fixed value (URL) AND a user-fillable hole (USER) — exercises the
// value-lock / keptValue matrix that a single secret var can't.
const MIXED_TEMPLATE: McpBuiltinDefinition = {
  builtinId: "atl",
  name: "atl",
  description: "Atlassian-like",
  config: { default: { transport: "stdio", command: "uvx", args: ["atl"] } },
  vars: [
    { name: "URL", secret: false, perProject: false, required: true, value: "https://old.example.com" },
    { name: "USER", secret: false, perProject: false, required: true, value: null },
  ],
};

/** Build the catalog row a previous sync of `definition` would have produced (the "installed" state). */
function installedFrom(definition: McpBuiltinDefinition, occurredAt = "2025-01-01T00:00:00.000Z") {
  const config = builtinConfigForPlatform(definition, "linux")!;
  return buildSyncedBuiltin({
    serverId: McpServerId.make(builtinServerId(definition.builtinId)),
    builtinId: definition.builtinId,
    builtinHash: builtinHash(config, definition),
    name: definition.name,
    description: definition.description ?? null,
    websiteUrl: null,
    config,
    shippedVars: builtinShippedVars(definition),
    timeoutMs: null,
    existing: undefined,
    occurredAt,
  });
}

/** Re-sync `next` over an installed `prior` row (what a definition change produces on restart). */
function resync(prior: McpCatalogServer, next: McpBuiltinDefinition, occurredAt = "2026-06-10T00:00:00.000Z") {
  const config = builtinConfigForPlatform(next, "linux")!;
  return buildSyncedBuiltin({
    serverId: prior.id,
    builtinId: next.builtinId,
    builtinHash: builtinHash(config, next),
    name: next.name,
    description: next.description ?? null,
    websiteUrl: null,
    config,
    shippedVars: builtinShippedVars(next),
    timeoutMs: null,
    existing: prior,
    occurredAt,
  });
}

function findVar(server: McpCatalogServer, name: string) {
  return server.vars.find((variable) => variable.name === name);
}

const NOW = "2026-06-10T00:00:00.000Z";

const customServer: McpCatalogServer = {
  id: McpServerId.make("srv-custom"),
  name: "custom",
  description: "old",
  websiteUrl: "https://docs.example.com",
  source: "custom",
  config: { transport: "stdio", command: "uvx", args: ["mine"] },
  vars: [],
  extraArgs: [],
  extraHeaders: {},
  builtinId: null,
  builtinHash: null,
  locked: false,
  enabled: true,
  timeoutMs: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

describe("buildAddedServer (manual/custom add)", () => {
  it("creates a custom, unlocked server with no built-in identity", () => {
    const draft: McpServerDraft = {
      name: "mine",
      description: "my server",
      config: { transport: "stdio", command: "uvx", args: ["mine"] },
      vars: [],
      timeoutMs: null,
    };
    const server = buildAddedServer(McpServerId.make("srv-1"), draft, [], NOW);
    expect(server.source).toBe("custom");
    expect(server.locked).toBe(false);
    expect(server.builtinId).toBeNull();
    expect(server.enabled).toBe(true);
    expect(server.description).toBe("my server");
    expect(server.websiteUrl).toBeNull(); // a manual server has no shipped link
  });
});

describe("applyServerUpdate (patch semantics)", () => {
  it("description: undefined keeps, null clears, string sets", () => {
    expect(applyServerUpdate(customServer, {}, customServer.vars, NOW).description).toBe("old");
    const cleared: McpServerDraftPatch = { description: null };
    expect(applyServerUpdate(customServer, cleared, customServer.vars, NOW).description).toBeNull();
    const set: McpServerDraftPatch = { description: "new" };
    expect(applyServerUpdate(customServer, set, customServer.vars, NOW).description).toBe("new");
  });

  it("websiteUrl is never cleared by an absent patch (patch ?? existing)", () => {
    expect(applyServerUpdate(customServer, {}, customServer.vars, NOW).websiteUrl).toBe(
      "https://docs.example.com",
    );
  });

  it("a LOCKED template ignores a config patch (keeps the shipped command)", () => {
    const locked: McpCatalogServer = { ...customServer, locked: true };
    const patch: McpServerDraftPatch = {
      config: { transport: "stdio", command: "EVIL", args: ["x"] },
    };
    expect(applyServerUpdate(locked, patch, locked.vars, NOW).config).toEqual(locked.config);
  });

  it("an UNLOCKED server applies a config patch", () => {
    const patch: McpServerDraftPatch = {
      config: { transport: "stdio", command: "npx", args: ["y"] },
    };
    expect(applyServerUpdate(customServer, patch, customServer.vars, NOW).config).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["y"],
    });
  });

  it("enabled + timeoutMs patches apply; createdAt is preserved", () => {
    const patch: McpServerDraftPatch = { enabled: false, timeoutMs: 5000 };
    const patched = applyServerUpdate(customServer, patch, customServer.vars, NOW);
    expect(patched.enabled).toBe(false);
    expect(patched.timeoutMs).toBe(5000);
    expect(patched.createdAt).toBe(customServer.createdAt);
    expect(patched.updatedAt).toBe(NOW);
  });
});

describe("buildBinding", () => {
  it("a fresh binding defaults enabled=true + DEFAULT_TOOL_POLICY, stamps createdAt", () => {
    const binding = buildBinding({
      projectId: ProjectId.make("proj"),
      serverId: McpServerId.make("srv"),
      patch: {},
      existing: undefined,
      varValues: {},
      occurredAt: NOW,
    });
    expect(binding.enabled).toBe(true);
    expect(binding.toolPolicy).toEqual(DEFAULT_TOOL_POLICY);
    expect(binding.createdAt).toBe(NOW);
  });

  it("an update preserves the original createdAt and carries the patch + varValues", () => {
    const existing: McpBinding = {
      projectId: ProjectId.make("proj"),
      serverId: McpServerId.make("srv"),
      enabled: true,
      toolPolicy: DEFAULT_TOOL_POLICY,
      varValues: {},
      timeoutMs: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const binding = buildBinding({
      projectId: ProjectId.make("proj"),
      serverId: McpServerId.make("srv"),
      patch: { enabled: false },
      existing,
      varValues: { V: "x" },
      occurredAt: NOW,
    });
    expect(binding.enabled).toBe(false);
    expect(binding.varValues).toEqual({ V: "x" });
    expect(binding.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(binding.updatedAt).toBe(NOW);
  });
});

describe("built-in definition changes drive an update (characterization)", () => {
  it("valueLocked mirrors the shipped value: author-fixed URL locked, hole USER not", () => {
    const [url, user] = builtinShippedVars(MIXED_TEMPLATE);
    expect(url?.valueLocked).toBe(true);
    expect(user?.valueLocked).toBe(false);
  });

  it("any value change flips the hash, so the reactor re-syncs", () => {
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      vars: [
        { name: "URL", secret: false, perProject: false, required: true, value: "https://new.example.com" },
        { name: "USER", secret: false, perProject: false, required: true, value: null },
      ],
    };
    const linux = builtinConfigForPlatform(MIXED_TEMPLATE, "linux")!;
    expect(builtinHash(linux, MIXED_TEMPLATE)).not.toBe(builtinHash(linux, v2));
  });

  it("an author-fixed value change propagates to an existing install (shipped value wins)", () => {
    const prior = installedFrom(MIXED_TEMPLATE);
    expect(findVar(prior, "URL")?.value).toBe("https://old.example.com");
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      vars: [
        { name: "URL", secret: false, perProject: false, required: true, value: "https://new.example.com" },
        { name: "USER", secret: false, perProject: false, required: true, value: null },
      ],
    };
    const updated = resync(prior, v2);
    expect(findVar(updated, "URL")?.value).toBe("https://new.example.com");
    expect(findVar(updated, "URL")?.valueLocked).toBe(true);
  });

  it("required → not-required changes the hash and the synced declaration", () => {
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      vars: [
        { name: "URL", secret: false, perProject: false, required: true, value: "https://old.example.com" },
        { name: "USER", secret: false, perProject: false, required: false, value: null },
      ],
    };
    const linux = builtinConfigForPlatform(MIXED_TEMPLATE, "linux")!;
    expect(builtinHash(linux, MIXED_TEMPLATE)).not.toBe(builtinHash(linux, v2));
    const updated = resync(installedFrom(MIXED_TEMPLATE), v2);
    expect(findVar(updated, "USER")?.required).toBe(false);
  });

  it("a command change re-syncs the locked config", () => {
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      config: { default: { transport: "stdio", command: "uvx", args: ["atl", "--verbose"] } },
    };
    const linux = builtinConfigForPlatform(MIXED_TEMPLATE, "linux")!;
    expect(builtinHash(linux, MIXED_TEMPLATE)).not.toBe(
      builtinHash(builtinConfigForPlatform(v2, "linux")!, v2),
    );
    const updated = resync(installedFrom(MIXED_TEMPLATE), v2);
    expect(updated.config).toEqual({ transport: "stdio", command: "uvx", args: ["atl", "--verbose"] });
  });

  it("a removed var disappears; a user-added var survives", () => {
    const prior: McpCatalogServer = {
      ...installedFrom(MIXED_TEMPLATE),
      vars: [
        ...installedFrom(MIXED_TEMPLATE).vars,
        { name: "MINE", secret: false, perProject: false, required: false, value: "x", origin: "user" },
      ],
    };
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      vars: [{ name: "URL", secret: false, perProject: false, required: true, value: "https://old.example.com" }],
    };
    const updated = resync(prior, v2);
    const names = updated.vars.map((variable) => variable.name);
    expect(names).toContain("URL");
    expect(names).not.toContain("USER"); // shipped var removed from the definition ⇒ gone
    expect(names).toContain("MINE"); // user-added var preserved
  });

  it("a user-filled hole keeps its value across an unrelated re-sync", () => {
    const prior: McpCatalogServer = {
      ...installedFrom(MIXED_TEMPLATE),
      vars: installedFrom(MIXED_TEMPLATE).vars.map((variable) =>
        variable.name === "USER" ? Object.assign({}, variable, { value: "alice" }) : variable,
      ),
    };
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      config: { default: { transport: "stdio", command: "uvx", args: ["atl", "--v2"] } },
    };
    const updated = resync(prior, v2);
    expect(findVar(updated, "USER")?.value).toBe("alice");
  });

  it("a locked value turned into a hole (value→null) clears the old value AND unlocks", () => {
    const prior = installedFrom(MIXED_TEMPLATE); // URL = old, valueLocked true
    const v2: McpBuiltinDefinition = {
      ...MIXED_TEMPLATE,
      vars: [
        { name: "URL", secret: false, perProject: false, required: true, value: null },
        { name: "USER", secret: false, perProject: false, required: true, value: null },
      ],
    };
    const updated = resync(prior, v2);
    expect(findVar(updated, "URL")?.value).toBeNull(); // old author URL is NOT stranded
    expect(findVar(updated, "URL")?.valueLocked).toBe(false); // now a user-fillable hole
  });
});

describe("builtinHash is sensitive to EVERY definition field (no silent no-update)", () => {
  const base = MIXED_TEMPLATE;
  const linux = builtinConfigForPlatform(base, "linux")!;
  const baseHash = builtinHash(linux, base);
  const [url, user] = base.vars;

  // Each case changes exactly one field; the hash must move (so the reactor re-syncs).
  const definitionFieldCases: ReadonlyArray<readonly [string, McpBuiltinDefinition]> = [
    ["name", { ...base, name: "atl-renamed" }],
    ["description", { ...base, description: "changed description" }],
    ["websiteUrl", { ...base, websiteUrl: "https://docs.example.com" }],
    ["timeoutMs", { ...base, timeoutMs: 5000 }],
    ["a var's value", { ...base, vars: [{ ...url!, value: "https://changed" }, user!] }],
    ["a var's required flag", { ...base, vars: [url!, { ...user!, required: false }] }],
    ["a var's secret flag", { ...base, vars: [url!, { ...user!, secret: true }] }],
    ["a var's perProject flag", { ...base, vars: [url!, { ...user!, perProject: true }] }],
    [
      "an added var",
      { ...base, vars: [url!, user!, { name: "NEW", secret: false, perProject: false, required: false, value: null }] },
    ],
    ["a removed var", { ...base, vars: [url!] }],
  ];

  for (const [label, changed] of definitionFieldCases) {
    it(`changes when ${label} changes`, () => {
      expect(builtinHash(linux, changed)).not.toBe(baseHash);
    });
  }

  it("changes when the command args change", () => {
    const v2: McpBuiltinDefinition = {
      ...base,
      config: { default: { transport: "stdio", command: "uvx", args: ["atl", "--verbose"] } },
    };
    expect(builtinHash(builtinConfigForPlatform(v2, "linux")!, v2)).not.toBe(baseHash);
  });

  it("changes when the command itself changes", () => {
    const v2: McpBuiltinDefinition = {
      ...base,
      config: { default: { transport: "stdio", command: "npx", args: ["atl"] } },
    };
    expect(builtinHash(builtinConfigForPlatform(v2, "linux")!, v2)).not.toBe(baseHash);
  });

  it("changes when the transport switches stdio→http", () => {
    const v2: McpBuiltinDefinition = {
      ...base,
      config: { default: { transport: "http", httpUrl: "https://x", headers: {} } },
      vars: [],
    };
    expect(builtinHash(builtinConfigForPlatform(v2, "linux")!, v2)).not.toBe(baseHash);
  });

  it("changes when an http header value changes", () => {
    const v1: McpBuiltinDefinition = {
      ...base,
      config: { default: { transport: "http", httpUrl: "https://x", headers: { A: "1" } } },
      vars: [],
    };
    const v2: McpBuiltinDefinition = {
      ...base,
      config: { default: { transport: "http", httpUrl: "https://x", headers: { A: "2" } } },
      vars: [],
    };
    expect(builtinHash(builtinConfigForPlatform(v1, "linux")!, v1)).not.toBe(
      builtinHash(builtinConfigForPlatform(v2, "linux")!, v2),
    );
  });
});

describe("mergeTemplateVars", () => {
  const lockedExisting: McpCatalogServer = {
    id: McpServerId.make("srv-builtin-demo"),
    name: "demo",
    description: null,
    websiteUrl: null,
    source: "builtin",
    config: { transport: "stdio", command: "npx", args: ["demo"] },
    vars: [
      { name: "TOKEN", secret: true, perProject: false, required: true, value: null, origin: "shipped" },
    ],
    extraArgs: [],
    extraHeaders: {},
    builtinId: "demo",
    builtinHash: "h",
    locked: true,
    enabled: true,
    timeoutMs: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };

  it("locked: re-stamps a shipped-named row to its shipped declaration but takes the new value", async () => {
    const drafts: ReadonlyArray<McpServerVarDraft> = [
      // The UI sends the shipped row (declaration read-only) with a filled value + a new user var.
      { name: "TOKEN", secret: true, perProject: false, required: true, value: "filled" },
      { name: "MINE", secret: false, perProject: false, required: false, value: "v" },
    ];
    const result = await Effect.runPromise(
      mergeTemplateVars(lockedExisting.id, lockedExisting, drafts).pipe(
        Effect.provide(fakeSecretStoreLayer()),
      ),
    );
    const token = result.find((variable) => variable.name === "TOKEN");
    expect(token?.origin).toBe("shipped"); // declaration stays shipped (not flipped to user)
    expect(token?.required).toBe(true);
    expect(token?.value).not.toBeNull(); // the value WAS taken from the draft (stored as a ref)
    expect(result.find((variable) => variable.name === "MINE")?.origin).toBe("user");
  });

  it("locked: a shipped var omitted by the draft is preserved untouched", async () => {
    const result = await Effect.runPromise(
      mergeTemplateVars(lockedExisting.id, lockedExisting, []).pipe(
        Effect.provide(fakeSecretStoreLayer()),
      ),
    );
    expect(result.map((variable) => variable.name)).toEqual(["TOKEN"]);
    expect(result[0]?.origin).toBe("shipped");
  });

  it("unlocked: every draft becomes a user var", async () => {
    const unlocked: McpCatalogServer = { ...lockedExisting, locked: false, vars: [] };
    const drafts: ReadonlyArray<McpServerVarDraft> = [
      { name: "A", secret: false, perProject: false, required: false, value: "1" },
    ];
    const result = await Effect.runPromise(
      mergeTemplateVars(unlocked.id, unlocked, drafts).pipe(Effect.provide(fakeSecretStoreLayer())),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.origin).toBe("user");
  });
});
