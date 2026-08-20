// ru-code: improvements-branch-3 #7 GUARD (green) — the existing orphan-secret GC is the
// transactional safety net (we rely on it instead of decide-phase compensation). This pins that it
// (a) prunes an unreferenced `mcp-var-*` secret, (b) KEEPS a secret still referenced by a catalog
// server, and (c) never touches a non-`mcp-var-*` secret. No production logic touched.

import { afterEach, describe, expect, it } from "vite-plus/test";

import { addServerCmd, makeDeciderSystem } from "./branch3Helpers.ts";

describe("branch-3 #7 — orphan-secret GC is the safety net", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("prunes an orphan mcp-var secret, keeps a referenced one, ignores non-mcp secrets", async () => {
    system = makeDeciderSystem();
    // A referenced secret: a catalog server with a secret var ⇒ its secret is "live".
    await system.dispatch(
      addServerCmd({
        serverId: "live",
        name: "Live",
        args: ["${TOK}"],
        commandId: "u:live",
        vars: [{ name: "TOK", secret: true, perProject: false, required: true, value: "kept" }],
      }),
    );
    const liveName = system.mcpVarSecretName({ serverId: "live", varName: "TOK" });

    // An orphan mcp-var secret (no server references it) + a non-mcp secret (wrong prefix).
    const encoder = new TextEncoder();
    await system.secretSet("mcp-var-orphan-zzz", encoder.encode("orphan"));
    await system.secretSet("auth-session-key", encoder.encode("unrelated"));

    await system.gcOrphans();

    expect(await system.secretGet("mcp-var-orphan-zzz")).toBeNull(); // pruned
    expect(await system.secretGet(liveName)).not.toBeNull(); // referenced ⇒ kept
    expect(await system.secretGet("auth-session-key")).not.toBeNull(); // wrong prefix ⇒ untouched
  });
});
