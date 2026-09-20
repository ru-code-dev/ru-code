// ru-code S38: the PLUGIN WIRE recorder — every `plugin.invoke` frame, by plugin, with its bytes.
//
// Rule 36 asks boot and open paths for FRAME-COUNT and BYTE-COUNT assertions. S37 built exactly that
// for ONE plugin (`analyticsColdOpen.e2e.test.ts` §1.8), and its recorder filters on
// `/"method":"(analytics\.[a-zA-Z]+)"/` — so every catalogs and demo frame was dropped and the
// S37 analyst could say nothing about them (`WORKFLOW/logs/S37-analyst.md` §c, "agreement on
// analytics, silence on catalogs and demo").
//
// This is that recorder widened, and the widening is the whole of it: the outer frame is always
// `plugin.invoke` (`packages/contracts/src/ru-code/plugins/rpc.ts:35`) and the PLUGIN's own method
// and id live inside its payload (`apps/web/src/ru-code/plugins/rpcPort.ts:47-57`
// `{ pluginId, method, payload? }`), so one hook keyed on the payload answers "which plugin asked
// the server for what, how many times, and how many bytes came back" for every plugin at once.
//
// THE ENVELOPE SPELLS THE RPC METHOD `tag`, NOT `method` (effect's own serializer:
// `effect/dist/unstable/rpc/RpcSerialization.js:223-225` writes `{_tag:"Request", id, tag, payload}`),
// so the ONLY `"method"` key in a `plugin.invoke` frame is the plugin's own. Measured, not assumed:
// the first version of this file filtered on `"method":"plugin.invoke"` and recorded nothing at all
// (`WORKFLOW/logs/S38/1-e2e-boot-red.log`).
//
// IT IS AN OBSERVER. It reads `WebSocket.prototype.send`, records, and calls the native send with
// the same bytes. Nothing is injected, delayed or refused (rule 36: an injected fault proves
// nothing unless the product can produce it).
//
// The arrays live on `globalThis` and are installed with `page.addInitScript`, which re-runs on
// every navigation — so an F5 starts a fresh recording, which is exactly what a "what does a reload
// cost" assertion needs.

import type { Page } from "@playwright/test";

/** One outbound `plugin.invoke`. `method` is the PLUGIN's method (`skill.rescan`), not the RPC's. */
export interface PluginRequest {
  readonly at: number;
  readonly id: string;
  readonly pluginId: string;
  readonly method: string;
  readonly bytes: number;
  readonly socket: number;
}

/** One inbound frame, tagged with every request id it answers. */
export interface PluginAnswer {
  readonly at: number;
  readonly ids: ReadonlyArray<string>;
  readonly bytes: number;
  /** The RPC protocol could not encode the answer (the S37 shape). */
  readonly defect: boolean;
  /** A typed `PluginRpcError` — an honest failure, not a squashed one. */
  readonly pluginError: boolean;
}

export interface PluginWire {
  readonly requests: ReadonlyArray<PluginRequest>;
  readonly answers: ReadonlyArray<PluginAnswer>;
  readonly sockets: ReadonlyArray<{ readonly at: number; readonly event: string }>;
}

const EMPTY: PluginWire = { requests: [], answers: [], sockets: [] };

/**
 * The init script. Install with `await page.addInitScript(PLUGIN_WIRE_INIT)` BEFORE the first
 * `goto`; it re-arms itself on every navigation.
 */
export const PLUGIN_WIRE_INIT = `
globalThis.__wire = { requests: [], answers: [], sockets: [] };
const WS = globalThis.WebSocket;
const nativeSend = WS.prototype.send;
const hook = (socket) => {
  if (socket.__wireHooked) return;
  socket.__wireHooked = true;
  const seq = globalThis.__wire.sockets.length;
  socket.__wireSeq = seq;
  globalThis.__wire.sockets.push({ at: Date.now(), event: "created", seq });
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    if (text === "") return;
    const ids = [...text.matchAll(/"requestId":"?(\\d+)/g)].map((match) => match[1]);
    if (ids.length === 0) return;
    globalThis.__wire.answers.push({
      at: Date.now(),
      ids,
      bytes: text.length,
      defect: /"_tag":"Die"|"_tag":"Defect"/.test(text),
      pluginError: /"PluginRpcError"/.test(text),
    });
  }, { capture: true });
  for (const name of ["open", "close", "error"]) {
    socket.addEventListener(name, () =>
      globalThis.__wire.sockets.push({ at: Date.now(), event: name, seq }), { capture: true });
  }
};
WS.prototype.send = function (data) {
  hook(this);
  const text = typeof data === "string" ? data : "";
  // The envelope names the RPC in \`tag\`; the plugin's own method is the \`method\` in its payload.
  if (!/"tag":"plugin\\.invoke"/.test(text)) return nativeSend.call(this, data);
  const id = /"id":"?(\\d+)/.exec(text);
  const pluginId = /"pluginId":"([^"]+)"/.exec(text);
  const method = /"method":"([^"]+)"/.exec(text);
  globalThis.__wire.requests.push({
    at: Date.now(),
    id: id === null ? "" : id[1],
    pluginId: pluginId === null ? "" : pluginId[1],
    method: method === null ? "" : method[1],
    bytes: text.length,
    socket: this.__wireSeq,
  });
  return nativeSend.call(this, data);
};
`;

/** Everything recorded since the last navigation. */
export const pluginWire = (page: Page): Promise<PluginWire> =>
  page
    .evaluate(
      () =>
        ((globalThis as unknown as { __wire?: PluginWire }).__wire ?? {
          requests: [],
          answers: [],
          sockets: [],
        }) as PluginWire,
    )
    .catch(() => EMPTY);

/** `<pluginId> <method>` → how many frames, in the order they were first seen. */
export const frameCounts = (wire: PluginWire): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const request of wire.requests) {
    const key = `${request.pluginId} ${request.method}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

/** How many frames one plugin sent for one method. */
export const frames = (wire: PluginWire, pluginId: string, method: string): number =>
  wire.requests.filter((request) => request.pluginId === pluginId && request.method === method)
    .length;

/** Every frame one plugin sent, whatever the method. */
export const pluginFrames = (wire: PluginWire, pluginId: string): ReadonlyArray<PluginRequest> =>
  wire.requests.filter((request) => request.pluginId === pluginId);

/**
 * The answer frame for one request, and with it the BYTE count rule 36 asks for.
 *
 * A request id can appear in more than one inbound frame (the protocol chunks); the largest is the
 * one carrying the payload, which is the number a byte assertion is about.
 */
export const answerBytes = (wire: PluginWire, id: string): number =>
  wire.answers
    .filter((answer) => answer.ids.includes(id))
    .reduce((most, answer) => Math.max(most, answer.bytes), 0);

/** Total bytes every answer to this plugin's frames carried. */
export const pluginAnswerBytes = (wire: PluginWire, pluginId: string): number =>
  pluginFrames(wire, pluginId).reduce((sum, request) => sum + answerBytes(wire, request.id), 0);
