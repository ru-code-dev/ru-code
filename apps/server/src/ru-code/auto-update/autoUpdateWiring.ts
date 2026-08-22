// ru-code: host wiring for the auto-update engine.
//
// `AutoUpdateHostLayer` is a MODULE-LEVEL layer (like McpManagerHostLayer):
// provided both in server.ts (runtime graph — so the boot reconcile, the facts
// refresh and the scheduler run with the app lifecycle) and in ws.ts (RPC
// handlers). Layer memoization makes both sites see the SAME engine instance.
//
// There is NO apply-on-launch spine any more: the frozen wrapper (cli.js) owns
// version selection through `current.json` (the pointer), so a manual launch
// always boots whatever the last flip pointed at — nothing to finish at startup.

import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { UpdateEngineLive } from "./engine/updateEngineLive.ts";
import { UpdateHttpClientLayer } from "./updateHttpClient.ts";

export const AutoUpdateHostLayer = UpdateEngineLive.pipe(
  Layer.provide(ProcessRunner.layer),
  // ru-code: the engine's own transport — see updateHttpClient.ts. Scoped here so the
  // permissive-TLS agent can never reach any other outbound request in the process.
  Layer.provide(UpdateHttpClientLayer),
);
