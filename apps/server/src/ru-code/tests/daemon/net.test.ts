// ru-code: the TCP probe every daemon decision rests on (reuse / reclaim /
// port-fallback / the single-instance guard). Proven against REAL loopback
// sockets: a live listener reads as in-use, a released port as free, and
// findFreePort skips a taken port to the next free one.

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { findFreePort, isPortInUse } from "@ru-code/daemon/net";

import { closedLoopbackPort, withLoopbackListener } from "./spawnSleeper.ts";

describe("daemon net probe", () => {
  it.live("a live listener reads as in-use", () =>
    Effect.scoped(
      withLoopbackListener((port) =>
        Effect.gen(function* () {
          assert.isTrue(yield* isPortInUse("127.0.0.1", port));
        }),
      ),
    ),
  );

  it.live("a released ephemeral port reads as free", () =>
    Effect.gen(function* () {
      const port = yield* closedLoopbackPort();
      assert.isFalse(yield* isPortInUse("127.0.0.1", port));
    }),
  );

  it.live("findFreePort returns the desired port when it is free", () =>
    Effect.gen(function* () {
      const port = yield* closedLoopbackPort();
      const found = yield* findFreePort("127.0.0.1", port);
      assert.deepEqual(found, Option.some(port));
    }),
  );

  it.live("findFreePort skips a TAKEN desired port to a free one", () =>
    Effect.scoped(
      withLoopbackListener((takenPort) =>
        Effect.gen(function* () {
          const found = yield* findFreePort("127.0.0.1", takenPort);
          assert.isTrue(Option.isSome(found));
          const freePort = Option.getOrThrow(found);
          assert.notEqual(freePort, takenPort);
          assert.isTrue(freePort > takenPort); // probes upward from desired
          assert.isFalse(yield* isPortInUse("127.0.0.1", freePort));
        }),
      ),
    ),
  );
});
