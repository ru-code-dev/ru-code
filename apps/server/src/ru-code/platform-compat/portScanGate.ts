// ru-code: the ONE opt-in gate for everything the preview port scanner drives (seams:
// preview/PortScanner.ts scanOnce + terminal/Manager.ts pollSubprocessActivity). Port scanning
// spawns child processes on a poll loop — needless background churn on every platform — so it is
// OFF unless the user enables `preview.portScanEnabled` in Settings. The setting's schema
// decode-default is `false` (see PORT_SCAN_DEFAULT_ENABLED), which covers every install:
// fresh, upgraded, or reinstalled with an old settings.json.
//
// The service is captured ONCE at layer construction (`capturePortScanGate` runs inside the
// consumer's `make`) — deterministic regardless of which fiber later calls scan/poll. A graph
// without ServerSettingsService (isolated tests, stripped runtimes) is treated as DISABLED —
// fail-closed, never fail-open. The returned check re-reads the live value on every use, so a
// Settings toggle applies immediately with no restart (the live ServerSettingsService writes
// through on update; the storage primitive behind it is that service's business, not ours).

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../../serverSettings.ts";

/** Run inside a layer's `make`; yields the per-use enabled check described above. */
export const capturePortScanGate: Effect.Effect<Effect.Effect<boolean>> = Effect.serviceOption(
  ServerSettingsService,
).pipe(
  Effect.map(
    Option.match({
      onNone: () => Effect.succeed(false),
      onSome: (settings) =>
        settings.getSettings.pipe(
          Effect.map((current) => current.preview.portScanEnabled),
          Effect.orElseSucceed(() => false),
        ),
    }),
  ),
);
