// ru-code: Wire model for the CLI reload feature (one unary command: kill every CLI process
// this server owns, close the work they left parked, delete the configured profile-dir
// entries, and re-arm the auth gate so the next spawn re-authenticates).
//
// Localization invariant (same as the auto-update zone): the wire carries MACHINE DATA ONLY.
// The failure line the user reads is a client-side constant — owner ruling R7 is ONE generic
// sentence with no details, and the details live in the server's debug log — so this error
// deliberately carries NO fields. A detail field would be a display string on the wire that
// nothing is allowed to show.

import * as Schema from "effect/Schema";

/**
 * The reload finished: every CLI process this server owned is dead, the parked work is
 * closed, and the configured deletions ran. `ok` is always `true` — it exists so the
 * success payload is a struct (extensible without a wire break) rather than `void`.
 */
export const CliReloadResult = Schema.Struct({ ok: Schema.Boolean });
export type CliReloadResult = typeof CliReloadResult.Type;

/**
 * The reload failed somewhere. Fieldless BY DESIGN (see the header): the client renders one
 * generic sentence, the cause is logged server-side at debug.
 */
export class CliReloadError extends Schema.TaggedErrorClass<CliReloadError>()(
  "CliReloadError",
  {},
) {}
