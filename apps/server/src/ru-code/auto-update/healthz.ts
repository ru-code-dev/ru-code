// ru-code: same-origin health endpoint for the auto-update restart choreography.
// The service-worker status pages (updating / down) poll this to detect the
// server coming back after a restart; SUCCESS for the updating page is
// `version === targetVersion`, and `lastApply` lets it show a real failure
// instead of pretending progress. Must stay dependency-free and always-on: it
// is the only signal available while the app itself may be mid-update.
//
// `lastApply` is fed through a module-level box the engine wiring fills at boot
// (after the journal reconcile) — the route itself keeps zero service
// dependencies so it can never fail to register or answer.
//
// Registered before the "GET *" SPA catch-all (more-specific routes win), via a
// marked seam in apps/server/src/server.ts `makeRoutesLayer`.

import packageJson from "../../../package.json" with { type: "json" };

import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import type { LastApplyWire } from "@t3tools/contracts";

/** Filled once at boot by the auto-update wiring (journal reconcile). Null until then. */
const lastApplyBox: { value: LastApplyWire | null } = { value: null };

export const setHealthzLastApply = (lastApply: LastApplyWire | null): void => {
  lastApplyBox.value = lastApply;
};

// ru-code: the version /healthz reports. Defaults to the build-baked
// apps/server/package.json version (production truth). The auto-update wiring
// latches it once at boot to the engine's resolved current version — identical
// to the baked value in production. The ONLY case where it differs is the
// documented, default-off test seam RU_CODE_UPDATE_TEST_VERSION_FROM_DIR=1 (see
// updateEngineLive.ts), which lets the live-cycle integration test observe a
// re-versioned payload's version WITHOUT a second full build. Latched (not read
// per-request from the pointer) so the value is truthful to the running code for
// the whole process lifetime — the flip window never makes /healthz lie.
const versionBox: { value: string } = { value: packageJson.version };

export const setHealthzVersion = (version: string): void => {
  versionBox.value = version;
};

/** Wire shape is intentionally tiny and stable — the SW pages parse it standalone. */
export const healthzRouteLayer = HttpRouter.add(
  "GET",
  "/healthz",
  Effect.sync(() =>
    HttpServerResponse.jsonUnsafe(
      {
        ok: true,
        version: versionBox.value,
        pid: process.pid,
        lastApply: lastApplyBox.value,
      },
      {
        headers: {
          // Never cache: the whole point is observing the live process.
          "Cache-Control": "no-store",
        },
      },
    ),
  ),
);
