// ru-code: a documented, default-OFF same-origin test-trigger route for the live-cycle
// integration harness (ru-code/e2e/integration). The production press path is the authenticated
// WebSocket `install` RPC; driving that whole pairing → session → ws-ticket handshake head-lessly
// is impractical and fragile, so — ONLY when `RU_CODE_UPDATE_TEST_TRIGGER=1` — the running daemon
// arms this loopback endpoint that drives the SAME engine (`checkNow` then `install`) the RPC
// would. Nothing here is production behaviour: with the env unset the route is never armed and
// answers 404, and the engine never fills the box. It is the transport trigger only — the real
// download / verify / pointer-flip / journal / relaunch all run through the untouched engine.
//
// Mirrors the dependency-free `setHealthzLastApply` seam: the engine fills a module-level box at
// boot (under the env gate); the route is a plain, service-free HttpRouter entry so it can never
// fail to register. The bound press runs on the default runtime — the engine's `checkNow`/`install`
// effects require no context (R = never; every service is closed over inside makeUpdateEngine).

// @effect-diagnostics preferSchemaOverJson:off

import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

/** Env gate. Unset/≠"1" ⇒ the route is inert (404) and the engine never arms the box. */
export const AUTO_UPDATE_TEST_TRIGGER_ENV = "RU_CODE_UPDATE_TEST_TRIGGER";

/** What one press reports back to the harness (the transient run state is in-memory only). */
export interface AutoUpdateTestPressResult {
  /** Hero status phase after the press (e.g. "available", "run", "up-to-date"). */
  readonly status: string;
  /** The run phase if a run exists ("flip"/"restart"/"failed"/…), else null. */
  readonly runPhase: string | null;
  /** The machine error code — a run.failed code OR an early install refusal code, else null. */
  readonly errorCode: string | null;
  /** True when the install refused BEFORE starting a run (no-update / node-too-old / …). */
  readonly refused: boolean;
}

interface TriggerBox {
  /** Arm: run checkNow then install once, resolving to a machine-readable summary. */
  press: (() => Promise<AutoUpdateTestPressResult>) | null;
}

const box: TriggerBox = { press: null };

/** Called once at engine boot, ONLY under the env gate, with the bound press. */
export const setAutoUpdateTestPress = (press: () => Promise<AutoUpdateTestPressResult>): void => {
  box.press = press;
};

/**
 * POST /internal/auto-update/test-trigger — armed only under the env gate. Runs one real press
 * (checkNow → install) and returns the machine summary. Registered before the SPA catch-all via
 * the marked seam in apps/server/src/server.ts `makeRoutesLayer`.
 */
export const autoUpdateTestTriggerRouteLayer = HttpRouter.add(
  "POST",
  "/internal/auto-update/test-trigger",
  Effect.gen(function* () {
    if (process.env[AUTO_UPDATE_TEST_TRIGGER_ENV] !== "1" || box.press === null) {
      return HttpServerResponse.text("auto-update test trigger disabled", { status: 404 });
    }
    const press = box.press;
    const result = yield* Effect.promise(() => press());
    return HttpServerResponse.jsonUnsafe(result, {
      headers: { "Cache-Control": "no-store" },
    });
  }),
);
