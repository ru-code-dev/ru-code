// ru-code: call-site guard for the coerce seam in protocol.ts. Drives the REAL
// `makeAcpPatchedProtocol` over in-memory stdio and injects a raw JSON-RPC error
// frame carrying a protocol-shaped `Die` cause — the exact shape a plain
// JSON-RPC agent (qwen) sends for a core method. It asserts the routed message
// the RpcClient receives has been rewritten Die→Fail, proving the coercion is
// wired at the `!pendingRequest` branch (not just that the helper is correct).
// If someone removes the call in protocol.ts, this fails even though the pure
// unit test still passes.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpProtocol from "../../../protocol.ts";
import { makeInMemoryStdio } from "../../../_internal/stdio.ts";

// ru-code: `Schema.UnknownFromJsonString` exists at runtime (effect's dist/Schema.js)
// but is missing from this base's dist/Schema.d.ts — a publish-artifact gap, not a
// removal. `fromJsonString(Unknown)` is its own definition upstream, so this is the
// identical schema, just built explicitly instead of read off the missing export.
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

type RoutedExit = {
  readonly _tag: string;
  readonly requestId: string;
  readonly exit: {
    readonly _tag: string;
    readonly cause: ReadonlyArray<{
      readonly _tag: string;
      readonly error?: unknown;
      readonly defect?: unknown;
    }>;
  };
};

const offerFrame = (input: Queue.Queue<Uint8Array, Cause.Done<void>>, frame: unknown) =>
  Queue.offer(input, encoder.encode(`${encodeUnknownJsonString(frame)}\n`));

it.layer(NodeServices.layer)(
  "coerceProtocolErrorDefects — wired in makeAcpPatchedProtocol",
  (it) => {
    it.effect(
      "rewrites a raw protocol-error Die on the core (non-extension) path into a Fail, preserving code + data",
      () =>
        Effect.gen(function* () {
          const { stdio, input } = yield* makeInMemoryStdio();
          const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
            stdio,
            serverRequestMethods: new Set(),
          });
          const routed = yield* Deferred.make<RoutedExit>();
          // clientProtocol.run(0, …) receives every message offered to clientQueue —
          // i.e. exactly what the RpcClient would decode. Capture the first Exit.
          yield* transport.clientProtocol
            .run(0, (message) => {
              const routedMessage = message as unknown as RoutedExit;
              return routedMessage._tag === "Exit"
                ? Deferred.succeed(routed, routedMessage).pipe(Effect.asVoid)
                : Effect.void;
            })
            .pipe(Effect.forkScoped);

          // A core-method error the way qwen sends it: a Die whose defect is the raw
          // {code,message,data}. The id (7) is NOT a pending extension request, so
          // handleExitEncoded takes the coercion branch.
          yield* offerFrame(input, {
            jsonrpc: "2.0",
            id: 7,
            error: {
              _tag: "Cause",
              code: -32000,
              message: "auth required",
              data: [
                {
                  _tag: "Die",
                  defect: { code: -32000, message: "auth required", data: { details: "no key" } },
                },
              ],
            },
          });

          const message = yield* Deferred.await(routed);
          assert.equal(message._tag, "Exit");
          assert.equal(message.exit._tag, "Failure");
          const entry = message.exit.cause[0]!;
          assert.equal(entry._tag, "Fail"); // was Die on the wire → coerced
          assert.deepEqual(entry.error, {
            code: -32000,
            message: "auth required",
            data: { details: "no key" },
          });
        }),
    );

    it.effect("leaves a non-protocol Die (no numeric code) as a Die — coercion is selective", () =>
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
        });
        const routed = yield* Deferred.make<RoutedExit>();
        yield* transport.clientProtocol
          .run(0, (message) => {
            const routedMessage = message as unknown as RoutedExit;
            return routedMessage._tag === "Exit"
              ? Deferred.succeed(routed, routedMessage).pipe(Effect.asVoid)
              : Effect.void;
          })
          .pipe(Effect.forkScoped);

        yield* offerFrame(input, {
          jsonrpc: "2.0",
          id: 8,
          error: {
            _tag: "Cause",
            code: 0,
            message: "boom",
            data: [{ _tag: "Die", defect: { kind: "GenericError", message: "boom" } }],
          },
        });

        const message = yield* Deferred.await(routed);
        assert.equal(message.exit.cause[0]!._tag, "Die"); // untouched: not protocol-shaped
      }),
    );
  },
);
