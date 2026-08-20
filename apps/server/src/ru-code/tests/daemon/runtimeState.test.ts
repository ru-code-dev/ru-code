// @effect-diagnostics preferSchemaOverJson:off
// ru-code: the runtime-state decoder is the daemon's contract with the on-disk
// `server-runtime.json` the server writes. Every stop / reuse / status decision
// reads through it, so its "every failure mode collapses to None" promise must
// hold — a false Some would make `stop` chase a bogus pid. We drive the real
// reader against temp files (absent / empty / garbage / wrong-shape / valid).

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readRuntimeState } from "@ru-code/daemon/runtimeState";

const VALID = {
  version: 1,
  pid: 4242,
  host: "127.0.0.1",
  port: 7777,
  origin: "http://127.0.0.1:7777",
  startedAt: "2026-07-15T10:00:00.000Z",
  pairingUrl: "http://127.0.0.1:7777/?pair=abc",
};

// Write `contents` to a fresh temp file and decode it through the real reader.
const readContents = (contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-daemon-state-" });
    const statePath = path.join(root, "server-runtime.json");
    yield* fileSystem.writeFileString(statePath, contents);
    return yield* readRuntimeState(statePath);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("daemon runtimeState decoder", () => {
  it.effect("decodes a complete, valid state file", () =>
    Effect.gen(function* () {
      const state = Option.getOrThrow(yield* readContents(JSON.stringify(VALID)));
      assert.equal(state.pid, 4242);
      assert.equal(state.port, 7777);
      assert.equal(state.origin, VALID.origin);
      assert.equal(state.startedAt, VALID.startedAt);
      assert.equal(state.host, "127.0.0.1");
      assert.equal(state.pairingUrl, VALID.pairingUrl);
    }),
  );

  it.effect("decodes a minimal state file (optional host + pairingUrl absent)", () =>
    Effect.gen(function* () {
      const state = Option.getOrThrow(
        yield* readContents(
          JSON.stringify({
            version: 1,
            pid: 10,
            port: 7777,
            origin: "http://127.0.0.1:7777",
            startedAt: "2026-07-15T10:00:00.000Z",
          }),
        ),
      );
      assert.equal(state.pid, 10);
      assert.isUndefined(state.host);
      assert.isUndefined(state.pairingUrl);
    }),
  );

  it.effect("returns None when the file is absent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-daemon-state-" });
      assert.isTrue(Option.isNone(yield* readRuntimeState(path.join(root, "nope.json"))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns None for an empty / whitespace-only file", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* readContents("")));
      assert.isTrue(Option.isNone(yield* readContents("   \n  ")));
    }),
  );

  it.effect("returns None for malformed JSON", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* readContents("{ not json")));
    }),
  );

  it.effect("returns None for a future/unknown schema version (contract literal is 1)", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* readContents(JSON.stringify({ ...VALID, version: 2 }))));
    }),
  );

  it.effect("returns None when a required field is missing or wrong-typed", () =>
    Effect.gen(function* () {
      const { pid: _dropPid, ...noPid } = VALID;
      assert.isTrue(Option.isNone(yield* readContents(JSON.stringify(noPid))));
      assert.isTrue(
        Option.isNone(yield* readContents(JSON.stringify({ ...VALID, pid: "not-a-number" }))),
      );
    }),
  );
});
