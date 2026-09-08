// ru-code: `host.invoke(method, payload)` → `plugin.invoke` (mvp-plan D3, §1.3).
//
// The client is the `analyticsActions.ts:runAnalyticsRpc` idiom, so the properties worth
// pinning are the same ones that idiom gets wrong when it is copied carelessly: the primary
// environment is read at CALL time (not captured at build time), the input is exactly
// `{ pluginId, method, payload }`, a failure REJECTS rather than resolving undefined, and no
// connection is a `PluginRpcError` a plugin can tell apart from a server refusal.

import { PluginRpcError } from "@smart-tools/plugin-sdk/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  makePluginInvoke,
  makePluginRpcClient,
  resetRpcPort,
  setRpcPort,
  type PluginInvokeInput,
} from "./rpcPort";

const ENV = "env-1" as EnvironmentId;

const clientWith = (
  environmentId: EnvironmentId | null,
  transport: (args: { environmentId: EnvironmentId; input: PluginInvokeInput }) => Promise<unknown>,
) => makePluginRpcClient({ readEnvironmentId: () => environmentId, transport });

beforeEach(() => {
  resetRpcPort();
});

describe("makePluginRpcClient", () => {
  it("sends exactly { pluginId, method, payload } against the primary environment", async () => {
    const seen: Array<{ environmentId: EnvironmentId; input: PluginInvokeInput }> = [];
    const invoke = clientWith(ENV, async (args) => {
      seen.push(args);
      return { ok: true };
    });
    await expect(invoke("demo", "notes.add", { text: "hi" })).resolves.toEqual({ ok: true });
    expect(seen).toEqual([
      {
        environmentId: ENV,
        input: { pluginId: "demo", method: "notes.add", payload: { text: "hi" } },
      },
    ]);
  });

  it("omits `payload` entirely when the plugin passed none", async () => {
    const seen: PluginInvokeInput[] = [];
    const invoke = clientWith(ENV, async ({ input }) => {
      seen.push(input);
      return null;
    });
    await invoke("demo", "notes.list");
    expect(seen[0]).toEqual({ pluginId: "demo", method: "notes.list" });
    expect("payload" in (seen[0] as object)).toBe(false);
  });

  it("passes an explicit null payload through (null is a value, undefined is not)", async () => {
    const seen: PluginInvokeInput[] = [];
    const invoke = clientWith(ENV, async ({ input }) => {
      seen.push(input);
      return null;
    });
    await invoke("demo", "notes.list", null);
    expect(seen[0]).toEqual({ pluginId: "demo", method: "notes.list", payload: null });
  });

  it("rejects with PluginRpcError(plugin-failed / no active connection) when nothing is connected", async () => {
    let called = false;
    const invoke = clientWith(null, async () => {
      called = true;
      return null;
    });
    await expect(invoke("demo", "notes.list")).rejects.toBeInstanceOf(PluginRpcError);
    await invoke("demo", "notes.list").catch((error: unknown) => {
      expect(error).toBeInstanceOf(PluginRpcError);
      expect((error as PluginRpcError).reason).toBe("plugin-failed");
      expect((error as PluginRpcError).detail).toBe("no active connection");
    });
    expect(called).toBe(false);
  });

  it("reads the environment at CALL time, so a connection that appears later works", async () => {
    let environmentId: EnvironmentId | null = null;
    const invoke = makePluginRpcClient({
      readEnvironmentId: () => environmentId,
      transport: async ({ environmentId: id }) => id,
    });
    await expect(invoke("demo", "m")).rejects.toBeInstanceOf(PluginRpcError);
    environmentId = ENV;
    await expect(invoke("demo", "m")).resolves.toBe(ENV);
  });

  it("propagates a transport failure as a PluginRpcError, never as an undefined result", async () => {
    // A7 finding M1: a TRANSPORT failure (no socket yet on a fresh reload, a dropped
    // connection) used to reject with the raw app error — a localized host string with no
    // `reason` on it — even though the module header promises one error type for every
    // rejection. It is normalised to `plugin-failed` (the reason enum has no transport
    // member) with the underlying message as `detail`.
    const underlying = new Error("handler threw");
    const invoke = clientWith(ENV, () => Promise.reject(underlying));
    const error = await invoke("demo", "boom").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginRpcError);
    expect((error as PluginRpcError).reason).toBe("plugin-failed");
    expect((error as PluginRpcError).detail).toContain("handler threw");
    expect((error as PluginRpcError).cause).toBe(underlying);
  });

  it("passes a PluginRpcError from the server through UNWRAPPED (no double wrap)", async () => {
    // The `boom` path proven over the real socket: `reason: "plugin-failed"`,
    // `detail: "kaboom"` — the plugin's own message, not "Plugin RPC error (…): kaboom".
    const fromServer = new PluginRpcError({ reason: "plugin-failed", detail: "kaboom" });
    const invoke = clientWith(ENV, () => Promise.reject(fromServer));
    const error = await invoke("demo", "boom").catch((caught: unknown) => caught);
    expect(error).toBe(fromServer);
    expect((error as PluginRpcError).detail).toBe("kaboom");
  });

  it("keeps a server refusal's own reason (unknown-method survives the normalisation)", async () => {
    const invoke = clientWith(ENV, () =>
      Promise.reject(
        new PluginRpcError({ reason: "unknown-method", detail: "demo.no.such.method" }),
      ),
    );
    const error = await invoke("demo", "no.such.method").catch((caught: unknown) => caught);
    expect((error as PluginRpcError).reason).toBe("unknown-method");
    expect((error as PluginRpcError).detail).toBe("demo.no.such.method");
  });

  it("normalises a rejection that is not an Error at all", async () => {
    const invoke = clientWith(ENV, () => Promise.reject("just a string"));
    const error = await invoke("demo", "boom").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginRpcError);
    expect((error as PluginRpcError).reason).toBe("plugin-failed");
    expect((error as PluginRpcError).detail).toBe("just a string");
  });
});

describe("the port a plugin actually holds", () => {
  it("rejects with PluginRpcError while nothing is installed", async () => {
    await expect(makePluginInvoke("demo")("notes.list")).rejects.toBeInstanceOf(PluginRpcError);
  });

  it("binds the plugin id, so a plugin can never invoke as another plugin", async () => {
    const seen: PluginInvokeInput[] = [];
    setRpcPort(
      clientWith(ENV, async ({ input }) => {
        seen.push(input);
        return null;
      }),
    );
    await makePluginInvoke("demo")("notes.list", 1);
    await makePluginInvoke("other")("notes.list", 2);
    expect(seen.map((input) => input.pluginId)).toEqual(["demo", "other"]);
  });
});
