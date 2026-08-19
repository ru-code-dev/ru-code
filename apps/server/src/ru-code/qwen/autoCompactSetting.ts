import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../../serverSettings.ts";

/**
 * Live reader for the `autoCompactContext` setting — read per turn end, so
 * toggling it applies immediately (settings-file read errors degrade to "off"
 * for that check).
 */
export const readAutoCompactContext = (
  getSettings: ServerSettingsService["Service"]["getSettings"],
): Effect.Effect<boolean> =>
  getSettings.pipe(
    Effect.map((settings) => settings.autoCompactContext),
    Effect.orElseSucceed(() => false),
  );
