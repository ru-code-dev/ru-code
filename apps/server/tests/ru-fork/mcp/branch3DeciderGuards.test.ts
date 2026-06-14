// ru-fork: improvements-branch-3 — RED feature tests for the decider-level guards (#2 config
// uniqueness + built-in skip, #8 var/${VAR} validation). Written to the CORRECT expected behaviour;
// they currently FAIL because the guards are not implemented yet. The failure IS the spec.
// No production logic is touched — these only drive the REAL engine via shared test scaffolding.

import { afterEach, describe, expect, it } from "vitest";

import {
  addServerCmd,
  bindWithVarsCmd,
  builtinDefForArgs,
  makeDeciderSystem,
  projectCreateCmd,
  setTrustCmd,
  updateConfigCmd,
  updateNameCmd,
} from "./branch3Helpers.ts";

describe("branch-3 #2 — catalog config-uniqueness", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("rejects a second server with the SAME config under a different name (RED)", async () => {
    system = makeDeciderSystem();
    await system.dispatch(addServerCmd({ serverId: "a", name: "Server A", args: ["ctx7"], commandId: "u:a" }));
    // Same config (uvx ctx7), different id + name ⇒ must be rejected once uniqueness lands.
    await expect(
      system.dispatch(addServerCmd({ serverId: "b", name: "Server B", args: ["ctx7"], commandId: "u:b" })),
    ).rejects.toThrow();
    expect((await system.catalog()).filter((server) => server.config.args?.[0] === "ctx7")).toHaveLength(1);
  });

  it("rejects an edit that makes one server collide with another (RED)", async () => {
    system = makeDeciderSystem();
    await system.dispatch(addServerCmd({ serverId: "a", name: "A", args: ["x"], commandId: "u:a" }));
    await system.dispatch(addServerCmd({ serverId: "b", name: "B", args: ["y"], commandId: "u:b" }));
    await expect(system.dispatch(updateConfigCmd("a", ["y"], "u:collide"))).rejects.toThrow();
  });

  it("ALLOWS a non-config edit (name only) — must not false-positive against itself (GUARD)", async () => {
    system = makeDeciderSystem();
    await system.dispatch(addServerCmd({ serverId: "a", name: "A", args: ["x"], commandId: "u:a" }));
    await system.dispatch(updateNameCmd("a", "A renamed", "u:rename"));
    expect((await system.catalog()).find((server) => server.id === "a")?.name).toBe("A renamed");
  });

  it("skips a built-in whose config collides with an existing custom server (RED)", async () => {
    system = makeDeciderSystem();
    await system.dispatch(addServerCmd({ serverId: "custom", name: "Custom", args: ["demo"], commandId: "u:c" }));
    await system.reconcile([builtinDefForArgs("demo", ["demo"])]);
    // The built-in must be skipped (not duplicated): no catalog row carries its builtinId.
    expect((await system.catalog()).filter((server) => server.builtinId === "demo")).toHaveLength(0);
  });
});

describe("branch-3 #8 — varValues / ${VAR} ↔ declared-vars validation", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("rejects adding a server whose config references an undeclared ${VAR} (RED)", async () => {
    system = makeDeciderSystem();
    await expect(
      system.dispatch(
        addServerCmd({ serverId: "s", name: "S", args: ["--key=${UNDECLARED}"], commandId: "u:s", vars: [] }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a binding whose varValues key is not a declared var (RED)", async () => {
    system = makeDeciderSystem();
    await system.dispatch(addServerCmd({ serverId: "s", name: "S", args: ["s"], commandId: "u:s" }));
    await system.dispatch(projectCreateCmd("p", "u:p"));
    await expect(
      system.dispatch(
        bindWithVarsCmd({ projectId: "p", serverId: "s", varValues: { UNKNOWN_VAR: "x" }, commandId: "u:bind" }),
      ),
    ).rejects.toThrow();
  });
});

describe("branch-3 #6 — catalog trust flag", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("defaults trust=true on add; an update can turn it off", async () => {
    system = makeDeciderSystem();
    await system.dispatch(addServerCmd({ serverId: "t", name: "T", args: ["t"], commandId: "u:t" }));
    expect((await system.catalog()).find((server) => server.id === "t")?.trust).toBe(true);
    await system.dispatch(setTrustCmd("t", false, "u:t-off"));
    expect((await system.catalog()).find((server) => server.id === "t")?.trust).toBe(false);
  });
});
