// ru-code delta coverage: the `hasParkedRequests` provider capability.
//
// The fork added an optional `hasParkedRequests` capability across the provider
// stack so the orchestration command reactor can auto-interrupt a session that
// is holding a parked permission/plan/user-input request before starting a new
// turn (the "send-while-parked" deadlock guard):
//   - src/provider/Services/ProviderAdapter.ts:111  -> optional on the adapter
//   - src/provider/Services/ProviderService.ts:96    -> required on the service
//   - src/provider/Layers/ProviderService.ts:1066    -> service impl (safe false)
//   - src/ru-code/qwen/QwenAdapter.ts:1712           -> qwen's real impl
//
// The QwenAdapter is the only built-in adapter that actually implements
// parking, so we exercise its real `hasParkedRequests` here. The core contract
// the whole guard relies on is: with NO active session for the thread, it
// returns `false` safely (never throws). That is exactly the "not parked"
// default the Layers/ProviderService impl documents.
//
// NOTE (deferred to Phase 3 e2e): the Layers/ProviderService `hasParkedRequests`
// closure (route-without-recovery, catchCause -> false, absent-capability ->
// false) is not exported and requires the full ProviderService registry +
// directory + routing runtime to instantiate; covering it in isolation would
// stand up far more than the delta. Its building block (adapter returns false
// with no session) is covered below.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import { makeQwenAdapter } from "../../qwen/QwenAdapter.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

it.layer(NodeServices.layer)("QwenAdapter hasParkedRequests (ru-code capability)", (it) => {
  it.effect("exposes hasParkedRequests as a callable capability", () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      assert.isFunction(adapter.hasParkedRequests);
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-parked-cap-" })),
    ),
  );

  it.effect("returns false safely for a thread with no active session", () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const parked = yield* adapter.hasParkedRequests(ThreadId.make("thread-no-session"));
      assert.strictEqual(parked, false);
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-parked-none-" })),
    ),
  );
});
