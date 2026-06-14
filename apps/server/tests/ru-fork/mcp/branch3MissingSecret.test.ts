// ru-fork: improvements-branch-3 #9 — RED test for excluding a server whose required secret's stored
// value is gone (deleted out-of-band / failed write). Today the binding still resolves (secret → "")
// and the instance is probed/launched with a blank credential; the fix must treat it as incomplete
// and EXCLUDE it from the desired set. No production logic touched.

import { afterEach, describe, expect, it } from "vitest";

import { addServerCmd, makeDeciderSystem } from "./branch3Helpers.ts";

describe("branch-3 #9 — missing secret ⇒ incomplete (excluded)", () => {
  let system: ReturnType<typeof makeDeciderSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("excludes a catalog server whose required secret file is missing (RED)", async () => {
    system = makeDeciderSystem();
    await system.dispatch(
      addServerCmd({
        serverId: "sec",
        name: "Sec",
        args: ["${TOK}"],
        commandId: "u:sec",
        vars: [{ name: "TOK", secret: true, perProject: false, required: true, value: "stored" }],
      }),
    );
    // Decider stored the secret on add; now delete it out-of-band to simulate corruption / failed write.
    await system.secretRemove(system.mcpVarSecretName({ serverId: "sec", varName: "TOK" }));
    const desired = await system.computeDesired();
    const refs: string[] = [];
    for (const instance of desired.values()) {
      for (const ref of instance.refs) {
        refs.push(ref);
      }
    }
    // RED today: the instance is still desired (resolves to "") — the fix must exclude it.
    expect(refs).not.toContain("catalog:sec");
  });
});
