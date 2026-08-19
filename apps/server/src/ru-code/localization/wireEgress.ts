// ru-code: SERVER-EGRESS resolution of localization wire tokens.
//
// `"wire": true` dictionary entries compile to `Lc(en, ru, ...args)` — an opaque,
// locale-independent TOKEN (see @ru-code/localization serverToken.ts). Tokens are what
// module-consts hold and what the event store / projection PERSIST, so no display string is
// ever frozen to the locale it was emitted under. They must never reach a client raw.
//
// This module resolves them at the LAST possible server hop — the two doors every
// client-bound byte leaves through:
//   1. the WS RPC serialization (`layerLocalizedJsonRpcSerialization`, replacing
//      `RpcSerialization.layerJson` in ws.ts) — snapshots, live deltas, shell, detail,
//      notifications, message content, archived threads: ALL socket traffic;
//   2. the HTTP snapshot handlers (`localizeWireValue` in orchestration/http.ts) — the
//      cold-cache snapshot GETs the web loads before its WS subscription attaches.
// Resolving at egress (not in the client) means every sink — timeline rows, shell titles,
// `session.lastError`, turn `errorMessage`, assistant-bubble text, and any FUTURE field —
// is covered by construction, the client render layer stays untouched, and a stale web
// bundle can never leak a token (it receives plain text). The locale is the server-global
// `ServerSettings.locale` (synced to the localization singleton in serverSettings.ts); a
// language switch reloads clients, which refetch and get every historical token
// re-resolved in the new locale.
//
// PERFORMANCE (measured in ../tests/localization/wireEgress.perf.test.ts): the WS wrapper
// adds ONE native `String.includes` scan per outgoing message — no parse, no walk, no
// allocation — and only a message that actually carries a token (rare: a handful of
// compaction/error strings) pays the parse → resolve → re-stringify.
import { containsToken, getLocale, resolveDeep } from "@ru-code/localization";
import * as Layer from "effect/Layer";
import { RpcSerialization } from "effect/unstable/rpc";

// JSON.stringify escapes the token sentinel U+001E as the 6-char lowercase sequence
// backslash-u001e, so its presence in the encoded text is an exact "this message carries a
// token" signal (a token cannot ride an encoded JSON string any other way).
const ESCAPED_SENTINEL = "\\u001e";

/**
 * Resolve every wire token in a client-bound value into the server's current locale.
 * For handler-level use on plain schema structs (the HTTP snapshot GETs). `containsToken`
 * is an allocation-free deep scan, so token-free snapshots pass through by reference.
 */
export function localizeWireValue<T>(value: T): T {
  return containsToken(value) ? resolveDeep(value, getLocale()) : value;
}

/**
 * `RpcSerialization.layerJson` + egress localization. The resolve operates on the
 * SERIALIZED JSON TEXT (parse → resolveDeep → re-stringify), never on the live envelope —
 * every `toJSON` (dates etc.) has already fired, so nothing non-plain can be corrupted.
 * Decode (client→server requests) is untouched.
 */
export const localizedJsonSerialization: RpcSerialization.RpcSerialization["Service"] =
  RpcSerialization.RpcSerialization.of({
    contentType: RpcSerialization.json.contentType,
    includesFraming: RpcSerialization.json.includesFraming,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      return {
        decode: parser.decode,
        encode: (response: unknown) => {
          const encoded = parser.encode(response);
          if (typeof encoded !== "string" || !encoded.includes(ESCAPED_SENTINEL)) {
            return encoded;
          }
          return JSON.stringify(resolveDeep(JSON.parse(encoded), getLocale()));
        },
      };
    },
  });

export const layerLocalizedJsonRpcSerialization: Layer.Layer<RpcSerialization.RpcSerialization> =
  Layer.succeed(RpcSerialization.RpcSerialization, localizedJsonSerialization);
