// ru-code S76 (V2-59), S81 (V2-60): the web host WIRES `ctx.query` — the rule itself is
// `@smart-tools/plugin-sdk/state` `makeQueryHost`, tested once in the SDK (`tests/query.test.ts`).
// What is proved here is only what this host adds: the plugin's own `invoke`, `ctx.connection`,
// the V2-42 problem channel, and that the ctx carries it.
import type { PluginConnection } from "@smart-tools/plugin-sdk/host";
import { MAX_ACTIVE_QUERIES_PER_PLUGIN } from "@smart-tools/plugin-sdk/state";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { makeWebCtx } from "../../plugins/ctx";
import { resetPluginProblems } from "../../plugins/problems";
import { makePluginQuery } from "../../plugins/query";
import { makeSignal } from "../../plugins/signals";
import { getPluginProblems } from "../../plugins/status";

beforeEach(() => {
  resetPluginProblems();
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe("ctx.query — the web host's wiring (V2-59)", () => {
  it("every plugin's ctx carries query", () => {
    expect(typeof makeWebCtx({ id: "demo", name: "Demo" }).query).toBe("function");
  });

  it("reads through the plugin's invoke, and again when ctx.connection comes back", async () => {
    const connection = makeSignal<PluginConnection>("ready");
    const calls: Array<{ method: string; payload: unknown }> = [];
    let answer = 1;
    const { query } = makePluginQuery("demo", {
      connection,
      invoke: async (method, payload) => {
        calls.push({ method, payload });
        return answer;
      },
    });
    const snapshot = query<number>("snapshot", { at: 0 });
    snapshot.subscribe(() => {});
    await flush();
    expect(snapshot.get()).toEqual({ phase: "ready", value: 1 });
    answer = 2;
    connection.set("lost");
    connection.set("ready");
    await flush();
    expect(calls).toEqual([
      { method: "snapshot", payload: { at: 0 } },
      { method: "snapshot", payload: { at: 0 } },
    ]);
    expect(snapshot.get()).toEqual({ phase: "ready", value: 2 });
  });

  it("a refusal lands on the plugin's status record under the engine's code", () => {
    const { query } = makePluginQuery("demo", {
      connection: makeSignal<PluginConnection>("ready"),
      invoke: () => new Promise(() => {}),
    });
    for (let index = 0; index <= MAX_ACTIVE_QUERIES_PER_PLUGIN; index += 1) {
      query(`q${String(index)}`).subscribe(() => {});
    }
    const problems = getPluginProblems();
    expect(problems.map((problem) => problem.code)).toEqual(["cap:queries"]);
    expect(problems[0]?.pluginId).toBe("demo");
  });
});
