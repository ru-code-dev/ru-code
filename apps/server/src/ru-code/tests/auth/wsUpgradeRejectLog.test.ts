// ru-code: A2 — the WS upgrade auth-reject log line's contract: exactly one
// logError naming the machine-readable reason and the request shape, and the
// presented ticket VALUE never appears anywhere in the log output.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type { HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { logWebSocketUpgradeAuthReject } from "../../auth/wsUpgradeRejectLog.ts";

const makeCapture = () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    if (Array.isArray(message)) {
      messages.push(...message);
    } else {
      messages.push(message);
    }
  });
  return { messages, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const TICKET_VALUE = "SECRET-TICKET-VALUE";

/** Only the fields the logger reads: url + headers (toURL) and source (peer). */
const makeFakeUpgradeRequest = (input: {
  readonly url: string;
  readonly remoteAddress?: string;
}): HttpServerRequest.HttpServerRequest =>
  ({
    url: input.url,
    originalUrl: input.url,
    headers: { host: "127.0.0.1:3773" },
    source: input.remoteAddress ? { remoteAddress: input.remoteAddress } : undefined,
  }) as unknown as HttpServerRequest.HttpServerRequest;

const logRecords = (messages: ReadonlyArray<unknown>) =>
  messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && "reason" in message,
  );

describe("logWebSocketUpgradeAuthReject", () => {
  it.effect("names the reject reason, peer, and ticket presence", () => {
    const { messages, layer } = makeCapture();
    return Effect.gen(function* () {
      yield* logWebSocketUpgradeAuthReject(
        makeFakeUpgradeRequest({
          url: `/ws?wsTicket=${TICKET_VALUE}`,
          remoteAddress: "127.0.0.1",
        }),
        new EnvironmentAuth.ServerAuthInvalidCredentialError({}),
      );

      expect(messages).toContain("websocket upgrade auth rejected");
      const records = logRecords(messages);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        errorTag: "ServerAuthInvalidCredentialError",
        reason: "invalid_credential",
        ticketPresented: true,
        remoteAddress: "127.0.0.1",
      });
      // The credential value itself must never reach the log.
      // @effect-diagnostics-next-line preferSchemaOverJson:off - serializing captured log output to scan for a leaked secret, not decoding data.
      expect(JSON.stringify(messages)).not.toContain(TICKET_VALUE);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a ticketless cookie/header reject logs missing_credential without a peer", () => {
    const { messages, layer } = makeCapture();
    return Effect.gen(function* () {
      yield* logWebSocketUpgradeAuthReject(
        makeFakeUpgradeRequest({ url: "/ws" }),
        new EnvironmentAuth.ServerAuthMissingCredentialError({}),
      );

      const records = logRecords(messages);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        errorTag: "ServerAuthMissingCredentialError",
        reason: "missing_credential",
        ticketPresented: false,
        remoteAddress: "unknown",
      });
    }).pipe(Effect.provide(layer));
  });
});
