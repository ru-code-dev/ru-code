// ru-code v2 (S28, V2-35): `ctx.invoke` never fails for a reason the plugin cannot see.
//
// The client is built with every dependency injected — the environment and connection reads, the
// two waits and the transport — so straight-through dispatch, parking, cancellation, the cap and
// the reason mapping are proved here without an atom runtime. The browser half (a real socket, a
// real socket death) is `ru-code/e2e/tests-plugins/{analyticsColdOpen,invokeReadiness}.e2e.test.ts`.
//
// S37 removed the S28/S33 re-dispatch and everything that served it (`isPreSendFailure`, the
// `InvalidStateError` matcher, the session-skipping wait, `PluginInvokeOutcome.session`): the only
// producer of the fault it answered was a spec hooking `WebSocket.prototype.send` (rule 36). What
// is left is the rule itself — a call waits for a live session, is sent ONCE, and whatever comes
// back is either the server's own typed error or `transport`.
import { PluginRpcError } from "@smart-tools/plugin-sdk/contracts";
import type { PluginConnection } from "@smart-tools/plugin-sdk/host";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MAX_PARKED_INVOKES_PER_PLUGIN } from "../../plugins/caps";
import { resetPluginProblems } from "../../plugins/problems";
// V2-42: a host finding about a plugin is a status row and a console line, never a toast — so this
// is where every assertion below reads it from.
import { getPluginProblems as getPendingPluginProblems } from "../../plugins/status";
import {
  failureOfCause,
  makePluginRpcClient,
  resetPluginRpcParkingForTests,
  type PluginInvokeOutcome,
} from "../../plugins/rpcPort";

const ENV = "env-1" as EnvironmentId;

/** A wait the test releases by hand. */
const gate = () => {
  let release: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
};

const answered = (value: unknown): PluginInvokeOutcome => ({ _tag: "Answered", value });
const failed = (failure: unknown): PluginInvokeOutcome => ({ _tag: "Failed", failure });

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as PluginRpcError).reason;
  }
};

const capProblems = () =>
  getPendingPluginProblems().filter((problem) => problem.code === "cap:invoke-parked");

/** A client on a LIVE transport: chosen environment, `ready`, a session wait that must never run. */
const liveClient = (transport: (method: string) => Promise<PluginInvokeOutcome>) => {
  const waits: EnvironmentId[] = [];
  const port = makePluginRpcClient({
    readEnvironmentId: () => ENV,
    readConnection: () => "ready",
    awaitLiveSession: async (environmentId) => {
      waits.push(environmentId);
    },
    transport: ({ input }) => transport(input.method),
  });
  return { port, waits };
};

afterEach(() => {
  resetPluginRpcParkingForTests();
  resetPluginProblems();
});

describe("failureOfCause", () => {
  it("hands back a typed failure and a defect as themselves, and an INTERRUPT as a mid-call marker", () => {
    const typed = { _tag: "RpcClientError", message: "closed" };
    expect(failureOfCause(Cause.fail(typed))).toBe(typed);
    const defect = new Error("the request fiber threw");
    expect(failureOfCause(Cause.die(defect))).toBe(defect);
    // The interrupt is the socket dropping MID-CALL; `Cause.squash` would hand back a bare
    // `Error` with nothing the plugin could show.
    expect(failureOfCause(Cause.interrupt())).toMatchObject({
      _tag: "RpcInterrupted",
      message: "the connection was lost while the call was in flight",
    });
  });
});

describe("plugin rpc client (S28)", () => {
  it("PARKS a call made with no live session and sends it when the session is up — no timer", async () => {
    const session = gate();
    const sent: string[] = [];
    const port = makePluginRpcClient({
      readEnvironmentId: () => ENV,
      readConnection: () => "lost",
      awaitLiveSession: () => session.promise,
      transport: async ({ input }) => {
        sent.push(input.method);
        return answered("ok");
      },
    });
    const call = port("demo", "notes.list");
    await Promise.resolve();
    expect(sent, "nothing sent while parked").toEqual([]);
    session.release();
    await expect(call).resolves.toBe("ok");
    expect(sent).toEqual(["notes.list"]);
  });

  it("waits for the primary environment first when none is chosen yet", async () => {
    const primary = gate();
    const seen: EnvironmentId[] = [];
    const port = makePluginRpcClient({
      readEnvironmentId: () => null,
      readConnection: () => "connecting",
      awaitPrimaryEnvironment: () => primary.promise.then(() => ENV),
      awaitLiveSession: async (environmentId) => {
        seen.push(environmentId);
      },
      transport: async () => answered(1),
    });
    const call = port("demo", "projects.count");
    primary.release();
    await expect(call).resolves.toBe(1);
    expect(seen).toEqual([ENV]);
  });

  // S33 A2: the cap counts calls that WAIT. A healthy connection parks nothing, so nothing can
  // trip it — a panel mapping 17 rows to `ctx.invoke` in one tick is 17 frames, not 16 and a lie.
  it("dispatches STRAIGHT THROUGH on a live session: 17 concurrent calls → 17 sent, 0 rejected", async () => {
    const sent: string[] = [];
    const { port, waits } = liveClient(async (method) => {
      sent.push(method);
      return answered("ok");
    });
    const calls = Array.from({ length: MAX_PARKED_INVOKES_PER_PLUGIN + 1 }, (_, index) =>
      port("busy", `m${String(index)}`),
    );
    await expect(Promise.all(calls)).resolves.toHaveLength(MAX_PARKED_INVOKES_PER_PLUGIN + 1);
    expect(sent).toHaveLength(MAX_PARKED_INVOKES_PER_PLUGIN + 1);
    expect(waits, "no call waited for a session").toEqual([]);
    expect(capProblems()).toEqual([]);
  });

  it("while DOWN, 17 concurrent calls → 16 parked and sent on reconnect, 1 `transport`, told once", async () => {
    const session = gate();
    const sent: string[] = [];
    const port = makePluginRpcClient({
      readEnvironmentId: () => ENV,
      readConnection: () => "lost",
      awaitLiveSession: () => session.promise,
      transport: async ({ input }) => {
        sent.push(input.method);
        return answered("ok");
      },
    });
    const calls = Array.from({ length: MAX_PARKED_INVOKES_PER_PLUGIN + 1 }, (_, index) =>
      port("flood", `m${String(index)}`),
    );
    const other = port("other", "m");
    const last = calls[MAX_PARKED_INVOKES_PER_PLUGIN];
    if (last === undefined) throw new Error("unreachable");
    await expect(reasonOf(last)).resolves.toBe("transport");
    expect(capProblems()).toHaveLength(1);
    expect(sent, "nothing sent while down").toEqual([]);
    session.release();
    for (const kept of calls.slice(0, MAX_PARKED_INVOKES_PER_PLUGIN)) {
      await expect(kept).resolves.toBe("ok");
    }
    await expect(other, "another plugin's call is not the excess").resolves.toBe("ok");
    expect(sent).toHaveLength(MAX_PARKED_INVOKES_PER_PLUGIN + 1);
    // …and the count drains: a new call parks again.
    const again = gate();
    const port2 = makePluginRpcClient({
      readEnvironmentId: () => ENV,
      readConnection: () => "lost",
      awaitLiveSession: () => again.promise,
      transport: async () => answered("later"),
    });
    const late = port2("flood", "m");
    again.release();
    await expect(late).resolves.toBe("later");
  });

  // S37: ONE dispatch, whatever the failure. The host cannot prove a frame never left — the one
  // thing that ever looked like proof was a hooked `send` — and `plugin.invoke` may have written
  // to the plugin's database, so a second frame would run a handler twice with no idempotency key.
  it("is sent ONCE: every failure after the dispatch is the plugin's to see, never a re-send", async () => {
    for (const failure of [
      { _tag: "EnvironmentRpcUnavailableError", message: "ubuntu is not connected." },
      { _tag: "RpcClientError", message: "socket closed" },
      new DOMException("Failed to execute 'send' on 'WebSocket'.", "InvalidStateError"),
      new Error("something the host has never seen"),
      failureOfCause(Cause.interrupt()),
    ]) {
      resetPluginRpcParkingForTests();
      let attempts = 0;
      const { port, waits } = liveClient(async () => {
        attempts += 1;
        return failed(failure);
      });
      await expect(reasonOf(port("demo", "notes.add"))).resolves.toBe("transport");
      expect(attempts, `${String(failure)}: sent once`).toBe(1);
      expect(waits, `${String(failure)}: nothing waited`).toEqual([]);
    }
  });

  it("a MID-CALL failure keeps the underlying sentence as `detail`", async () => {
    const { port } = liveClient(async () =>
      failed({ _tag: "RpcClientError", message: "socket closed" }),
    );
    await expect(port("demo", "notes.add", { body: "x" })).rejects.toMatchObject({
      _tag: "PluginRpcError",
      reason: "transport",
      detail: "socket closed",
    });
  });

  it("the server's own PluginRpcError passes through untouched, whatever its reason", async () => {
    for (const reason of ["plugin-failed", "invalid-answer", "unknown-method"] as const) {
      const { port } = liveClient(async () =>
        failed(new PluginRpcError({ reason, detail: "boom", data: { kind: "x" } })),
      );
      // S37: `invalid-answer` is the host's own SERVER-side verdict on the handler's value; the
      // client must hand it to the plugin verbatim, never bury it behind `transport`.
      await expect(port("demo", "notes.add")).rejects.toMatchObject({
        reason,
        detail: "boom",
        data: { kind: "x" },
      });
    }
  });

  it("a parked call is CANCELLED with `transport` when the environment is removed", async () => {
    const session = gate();
    const port = makePluginRpcClient({
      readEnvironmentId: () => ENV,
      readConnection: () => "lost",
      awaitLiveSession: () => session.promise,
      transport: async () => answered("never"),
    });
    const call = port("demo", "notes.list");
    session.fail({ _tag: "EnvironmentNotRegisteredError", environmentId: ENV });
    await expect(reasonOf(call)).resolves.toBe("transport");
  });

  it("still refuses an id that could never name a plugin, as `invalid-payload`", async () => {
    const { port } = liveClient(async () => answered("ok"));
    await expect(reasonOf(port("Not A Slug", "m"))).resolves.toBe("invalid-payload");
  });

  it("a connection that is not `ready` parks even when the environment is chosen", async () => {
    for (const phase of ["connecting", "lost"] as const satisfies ReadonlyArray<PluginConnection>) {
      const session = gate();
      const waits: EnvironmentId[] = [];
      const port = makePluginRpcClient({
        readEnvironmentId: () => ENV,
        readConnection: () => phase,
        awaitLiveSession: async (environmentId) => {
          waits.push(environmentId);
          await session.promise;
        },
        transport: async () => answered(phase),
      });
      const call = port("demo", "m");
      session.release();
      await expect(call).resolves.toBe(phase);
      expect(waits, `${phase}: waited for the session`).toEqual([ENV]);
    }
  });
});
