// ru-code: host wiring for the CLI-reload engine.
//
// A MODULE-LEVEL layer (the AutoUpdateHostLayer idiom): ws.ts provides it for the RPC
// handler, and layer memoization means any other provider of it sees the SAME instance. The
// engine holds no state of its own — the reload latch, the auth flag, the spawn gate and the
// instance registry are process singletons in reloadRuntime.ts, which is what lets the qwen
// adapter and the text generator reach them without any wiring at all.

import * as Layer from "effect/Layer";

import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { CliReloadEngineLive } from "./CliReloadService.ts";

/**
 * The session directory is a stateless read facade over the runtime-binding repository, so —
 * exactly like the transcript host next door in ws.ts — this builds its own instance rather
 * than widening the route layer's requirements. SqlClient / ProjectionSnapshotQuery /
 * OrchestrationEngine / Crypto / FileSystem / Path stay ambient from the outer runtime.
 */
export const CliReloadHostLayer = CliReloadEngineLive.pipe(
  Layer.provide(ProviderSessionDirectoryLive),
  Layer.provide(ProviderSessionRuntime.layer),
);
