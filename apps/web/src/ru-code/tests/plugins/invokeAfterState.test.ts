// ru-code S104 (V2-73, option 1): a command's `ctx.invoke` resolves only once `ctx.state` holds every
// value the server published before it answered — path table rows 1–9 (`WORKFLOW/logs/S104-brief.md`
// §H), one case per row.
//
// THE HOST'S REAL CODE, the order forced by hand (rule 61): the real `plugin.invoke` client
// (`rpcPort.ts` `makePluginRpcClient`) with only its transport injected — the transport hands back
// what the wire answered — and the real state registry (`state.ts`), whose `plugin.state` frames the
// test delivers through `deliverPluginStateFrame`, the function the stream's transform calls. The
// cells are the SDK's `makeStateCell`, the ones every plugin's `ctx.state` hands out.
//
// Positions: the server's hub numbers every change it accepts (`seq`) and names its process
// (`boot`); an answer carries the hub's position when the handler returned, a snapshot the position
// it was taken at, and a `value` frame the `floor` — every change up to it has reached this tab.
import type { PluginConnection } from "@smart-tools/plugin-sdk/host";
import { PluginId } from "@smart-tools/plugin-sdk/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resetPluginProblems } from "../../plugins/problems";
import { makePluginQuery } from "../../plugins/query";
import {
  makePluginInvoke,
  makePluginRead,
  makePluginRpcClient,
  resetPluginRpcParkingForTests,
  setPluginRpcPortForTests,
  type PluginInvokeOutcome,
} from "../../plugins/rpcPort";
import { makeSignal } from "../../plugins/signals";
import {
  deliverPluginStateFrame,
  endPluginStateStream,
  makePluginState,
  pendingPluginStateWaits,
  resetPluginState,
  setPluginStateStreamMountForTests,
  type PluginStateSource,
} from "../../plugins/state";

const ENV = "env-1" as EnvironmentId;
const BOOT = "boot-1";
const ALPHA = PluginId.make("alpha");
const BETA = PluginId.make("beta");

/** This file's one stream, as the transform would hold it (`state.ts` `PluginStateSource`). */
const source: PluginStateSource = { boot: null };

const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const snapshot = (values: ReadonlyArray<readonly [string, unknown]>, seq: number, boot = BOOT) => {
  deliverPluginStateFrame(
    {
      _tag: "snapshot",
      values: values.map(([name, value]) => ({ pluginId: ALPHA, name, value })),
      boot,
      seq,
    },
    source,
  );
};

const frame = (name: string, value: unknown, floor: number, pluginId = ALPHA) => {
  deliverPluginStateFrame({ _tag: "value", pluginId, name, value, floor }, source);
};

/** The wire's answer: the handler's value and the hub's position when the handler returned. */
const answered = (value: unknown, seq: number, boot = BOOT): PluginInvokeOutcome => ({
  _tag: "Answered",
  value,
  state: { boot, seq },
});

/** A client on a LIVE transport whose every answer the test decides. */
const client = (transport: () => Promise<PluginInvokeOutcome>) =>
  makePluginRpcClient({
    readEnvironmentId: () => ENV,
    readConnection: () => "ready",
    awaitLiveSession: async () => {},
    transport,
  });

/** A call's settlement, observable without awaiting it — and what `ctx.state` held right then. */
const track = (call: Promise<unknown>, held: () => unknown) => {
  const seen: { done: boolean; value?: unknown; heldThen?: unknown; error?: unknown } = {
    done: false,
  };
  call.then(
    (value) => {
      seen.done = true;
      seen.value = value;
      seen.heldThen = held();
    },
    (error: unknown) => {
      seen.done = true;
      seen.error = error;
    },
  );
  return seen;
};

beforeEach(() => {
  resetPluginState();
  source.boot = null;
  resetPluginProblems();
  setPluginStateStreamMountForTests(() => () => {});
});

afterEach(() => {
  setPluginStateStreamMountForTests(null);
  setPluginRpcPortForTests(null);
  resetPluginRpcParkingForTests();
  resetPluginState();
});

describe("a command's invoke resolves only once ctx.state holds what the server published before it answered", () => {
  it("row 1 — the answer arrives BEFORE the frame published before it: resolves after the frame, with the value held", async () => {
    const scan = makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    const call = track(client(async () => answered("started", 4))("alpha", "scan.start"), scan.get);
    await flush();
    expect(call.done, "the answer alone does not resolve it").toBe(false);
    expect(scan.get()).toBe("idle");

    frame("scan", "running", 4);
    await flush();
    expect(call).toEqual({ done: true, value: "started", heldThen: "running" });
    expect(pendingPluginStateWaits()).toBe(0);
  });

  it("row 2 — the frames arrive before the answer: resolves at the answer", async () => {
    const scan = makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    frame("scan", "running", 4);
    const call = track(client(async () => answered("started", 4))("alpha", "scan.start"), scan.get);
    await flush();
    expect(call).toEqual({ done: true, value: "started", heldThen: "running" });
  });

  it("row 3 — answered, then the socket drops before the frame: the next session's snapshot releases it, with the TRUE current value", async () => {
    const scan = makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    const call = track(client(async () => answered("started", 4))("alpha", "scan.start"), scan.get);
    await flush();
    // The drop takes the `running` frame queued for this tab with it; another tab cancels meanwhile.
    expect(call.done).toBe(false);
    snapshot([["scan", "idle"]], 5);
    await flush();
    expect(call).toEqual({ done: true, value: "started", heldThen: "idle" });
    expect(pendingPluginStateWaits()).toBe(0);
  });

  it("row 4 — answered, then the server restarts: a snapshot from a NEW process releases it", async () => {
    const scan = makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    const call = track(
      client(async () => answered("started", 40))("alpha", "scan.start"),
      scan.get,
    );
    await flush();
    expect(call.done).toBe(false);
    // The new process has published one value (its at-rest state); its count starts again.
    snapshot([["scan", "at-rest"]], 1, "boot-2");
    await flush();
    expect(call).toEqual({ done: true, value: "started", heldThen: "at-rest" });
  });

  it("row 5 — connected: another tab's cancel REPLACED the pending frame (latest-wins): the replacement releases it", async () => {
    const scan = makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    let told = 0;
    scan.subscribe(() => {
      told += 1;
    });
    const call = track(client(async () => answered("started", 4))("alpha", "scan.start"), scan.get);
    await flush();
    expect(call.done).toBe(false);
    // `running` (4) was replaced in the hub by `idle` (5) before this tab pulled: one frame, `idle`,
    // equal to the value held — nobody is told, and the wait still ends.
    frame("scan", "idle", 5);
    await flush();
    expect(call).toEqual({ done: true, value: "started", heldThen: "idle" });
    expect(told).toBe(0);
  });

  it("the floor is the hub's: a frame below the answer holds it, any frame reaching it — any plugin's — releases it", async () => {
    const scan = makePluginState("alpha")("scan");
    makePluginState("beta")("rows");
    snapshot([["scan", "idle"]], 3);
    const call = track(client(async () => answered("started", 6))("alpha", "scan.start"), scan.get);
    await flush();
    frame("scan", "running", 5);
    await flush();
    expect(call.done, "floor 5 < 6").toBe(false);
    frame("rows", [1], 6, BETA);
    await flush();
    expect(call).toEqual({ done: true, value: "started", heldThen: "running" });
  });

  it("row 6 — rejected before the answer: rejects as it always did, and nothing is left waiting", async () => {
    makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    const call = client(async () => ({
      _tag: "Failed",
      failure: { _tag: "PluginRpcError", reason: "plugin-failed", detail: "refused" },
    }))("alpha", "scan.start");
    await expect(call).rejects.toMatchObject({ reason: "plugin-failed" });
    expect(pendingPluginStateWaits()).toBe(0);
  });

  it("row 7 — the page holds no plugin.state stream: resolves at the answer", async () => {
    const call = track(
      client(async () => answered("started", 99))("alpha", "scan.start"),
      () => null,
    );
    await flush();
    expect(call.done).toBe(true);
    expect(call.value).toBe("started");
  });

  it("row 8 — the stream ends (its environment removed, or it failed): every wait is released", async () => {
    makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    const call = track(
      client(async () => answered("started", 4))("alpha", "scan.start"),
      () => null,
    );
    await flush();
    expect(call.done).toBe(false);
    endPluginStateStream(source);
    await flush();
    expect(call.done).toBe(true);
    expect(pendingPluginStateWaits()).toBe(0);
  });

  it("row 9 — a ctx.query READ is never held; the same answer through invoke is", async () => {
    makePluginState("alpha")("scan");
    snapshot([["scan", "idle"]], 3);
    setPluginRpcPortForTests(client(async () => answered({ rows: 1 }, 4)));
    const { query } = makePluginQuery("alpha", {
      connection: makeSignal<PluginConnection>("ready"),
      invoke: makePluginRead("alpha"),
    });
    const read = query<{ rows: number }>("snapshot");
    read.subscribe(() => {});
    const command = track(makePluginInvoke("alpha")("snapshot"), () => null);
    await flush();
    expect(read.get()).toEqual({ phase: "ready", value: { rows: 1 } });
    expect(command.done, "the command waits for the frame at 4").toBe(false);
    frame("scan", "running", 4);
    await flush();
    expect(command.done).toBe(true);
  });
});
