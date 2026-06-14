// ru-fork: unit tests for the secret keep-on-edit machinery — splitServerVars' `keepSecret`
// (catalog edit that leaves a masked secret blank must REUSE the stored ref, not wipe it) and
// splitBindingVarValues' `keepNames` (per-project masked secret left blank is preserved). A fake
// Map-backed ServerSecretStore stands in for the filesystem store. These encode items 13/14.

import { McpServerId, ProjectId } from "@t3tools/contracts";
import type { McpServerVar, McpServerVarDraft } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { ServerSecretStore } from "../../../src/auth/Services/ServerSecretStore.ts";
import {
  collectVarSecretRefs,
  materializeSecretValues,
  splitBindingVarValues,
  splitServerVars,
} from "../../../src/ru-fork/mcp/McpSecrets.ts";

const decoder = new TextDecoder();

/** A Map-backed ServerSecretStore; `store` is exposed so tests assert what was persisted. */
function fakeSecretStore() {
  const store = new Map<string, Uint8Array>();
  const layer = Layer.succeed(ServerSecretStore, {
    get: (name: string) => Effect.succeed(store.get(name) ?? null),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    getOrCreateRandom: (name: string, bytes: number) =>
      Effect.sync(() => {
        const existing = store.get(name);
        if (existing) {
          return existing;
        }
        const created = new Uint8Array(bytes);
        store.set(name, created);
        return created;
      }),
    remove: (name: string) =>
      Effect.sync(() => {
        store.delete(name);
      }),
    pruneByPrefix: (prefix: string, keep: ReadonlySet<string>) =>
      Effect.sync(() => {
        for (const key of store.keys()) {
          if (key.startsWith(prefix) && !keep.has(key)) {
            store.delete(key);
          }
        }
      }),
  });
  return { store, layer };
}

const SERVER = McpServerId.make("srv-x");

describe("splitServerVars — keepSecret reuses the stored ref", () => {
  it("keepSecret + a blank value reuses the existing secret ref (no overwrite)", async () => {
    const { store, layer } = fakeSecretStore();
    const existing: ReadonlyArray<McpServerVar> = [
      { name: "TOKEN", secret: true, perProject: false, required: false, value: { secretRef: "mcp-var-srv-x-TOKEN" }, origin: "user" },
    ];
    store.set("mcp-var-srv-x-TOKEN", new TextEncoder().encode("kept-secret"));
    const drafts: ReadonlyArray<McpServerVarDraft> = [
      { name: "TOKEN", secret: true, perProject: false, required: false, value: null, keepSecret: true },
    ];
    const result = await Effect.runPromise(
      splitServerVars(SERVER, drafts, existing).pipe(Effect.provide(layer)),
    );
    expect(result[0]?.value).toEqual({ secretRef: "mcp-var-srv-x-TOKEN" });
    expect(result[0]?.origin).toBe("user");
    // The stored secret is untouched.
    expect(decoder.decode(store.get("mcp-var-srv-x-TOKEN"))).toBe("kept-secret");
  });

  it("a fresh secret value is stored under a per-server ref and the var holds that ref", async () => {
    const { store, layer } = fakeSecretStore();
    const drafts: ReadonlyArray<McpServerVarDraft> = [
      { name: "TOKEN", secret: true, perProject: false, required: false, value: "new-token" },
    ];
    const result = await Effect.runPromise(
      splitServerVars(SERVER, drafts, []).pipe(Effect.provide(layer)),
    );
    const value = result[0]?.value;
    const ref = value !== null && typeof value === "object" ? value.secretRef : null;
    expect(ref).not.toBeNull();
    expect(ref?.startsWith("mcp-var-")).toBe(true);
    // The plaintext is persisted under exactly that ref name.
    expect(decoder.decode(store.get(ref!))).toBe("new-token");
  });

  it("keepSecret with no prior ref falls through to treating the value normally (cleared)", async () => {
    const { layer } = fakeSecretStore();
    const drafts: ReadonlyArray<McpServerVarDraft> = [
      { name: "TOKEN", secret: true, perProject: false, required: false, value: null, keepSecret: true },
    ];
    const result = await Effect.runPromise(
      splitServerVars(SERVER, drafts, []).pipe(Effect.provide(layer)),
    );
    expect(result[0]?.value).toBeNull();
  });
});

describe("splitBindingVarValues — keepNames preserves untouched entries", () => {
  const vars: ReadonlyArray<McpServerVar> = [
    { name: "TOKEN", secret: true, perProject: true, required: true, value: null, origin: "user" },
    { name: "ROOT", secret: false, perProject: true, required: false, value: null, origin: "user" },
  ];

  it("keeps an untouched secret's existing ref while updating a plain value", async () => {
    const { layer } = fakeSecretStore();
    const existing = { TOKEN: { secretRef: "mcp-var-srv-x-proj1-TOKEN" } as const };
    const result = await Effect.runPromise(
      splitBindingVarValues({
        projectId: ProjectId.make("proj1"),
        serverId: SERVER,
        vars,
        draftVarValues: { ROOT: "/work" },
        keepNames: ["TOKEN"],
        existing,
      }).pipe(Effect.provide(layer)),
    );
    expect(result.TOKEN).toEqual({ secretRef: "mcp-var-srv-x-proj1-TOKEN" });
    expect(result.ROOT).toBe("/work");
  });

  it("a kept name with no prior value is simply absent", async () => {
    const { layer } = fakeSecretStore();
    const result = await Effect.runPromise(
      splitBindingVarValues({
        projectId: ProjectId.make("proj1"),
        serverId: SERVER,
        vars,
        draftVarValues: {},
        keepNames: ["TOKEN"],
        existing: {},
      }).pipe(Effect.provide(layer)),
    );
    expect("TOKEN" in result).toBe(false);
  });
});

describe("collectVarSecretRefs + materializeSecretValues", () => {
  it("collects effective secret refs (binding override + catalog default; plain ignored)", () => {
    const vars: McpServerVar[] = [
      { name: "A", secret: true, perProject: false, required: true, value: { secretRef: "ref-a" }, origin: "user" },
      { name: "B", secret: true, perProject: true, required: true, value: null, origin: "user" },
      { name: "C", secret: false, perProject: false, required: false, value: "plain", origin: "user" },
    ];
    // A from the catalog default; B filled per-project with a ref; C is plain ⇒ not collected.
    const refs = collectVarSecretRefs(vars, { B: { secretRef: "ref-b" } });
    expect([...refs].toSorted()).toEqual(["ref-a", "ref-b"]);
  });

  it("materializes each ref to plaintext from the store (ref-name → value)", async () => {
    const { store, layer } = fakeSecretStore();
    store.set("ref-a", new TextEncoder().encode("alpha"));
    store.set("ref-b", new TextEncoder().encode("beta"));
    const vars: McpServerVar[] = [
      { name: "A", secret: true, perProject: false, required: true, value: { secretRef: "ref-a" }, origin: "user" },
      { name: "B", secret: true, perProject: true, required: true, value: null, origin: "user" },
    ];
    const result = await Effect.runPromise(
      materializeSecretValues(vars, { B: { secretRef: "ref-b" } }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ "ref-a": "alpha", "ref-b": "beta" });
  });

  it("a missing ref materializes to empty string (no crash)", async () => {
    const { layer } = fakeSecretStore();
    const vars: McpServerVar[] = [
      { name: "A", secret: true, perProject: false, required: true, value: { secretRef: "gone" }, origin: "user" },
    ];
    const result = await Effect.runPromise(
      materializeSecretValues(vars, {}).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ gone: "" });
  });
});
