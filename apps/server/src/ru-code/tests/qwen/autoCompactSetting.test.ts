// ru-code: pins the settings-key seam between the server settings and the
// adapter's auto-compact reader — `readAutoCompactContext` over the REAL
// ServerSettingsService test layer, so a rename/typo on either side fails here.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { layerTest, ServerSettingsService } from "../../../serverSettings.ts";
import { readAutoCompactContext } from "../../qwen/autoCompactSetting.ts";

describe("readAutoCompactContext", () => {
  it.effect("returns false when settings disable autoCompactContext", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const autoCompactContext = yield* readAutoCompactContext(serverSettings.getSettings);
      assert.strictEqual(autoCompactContext, false);
    }).pipe(Effect.provide(layerTest({ autoCompactContext: false }))),
  );

  it.effect("returns true for default settings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const autoCompactContext = yield* readAutoCompactContext(serverSettings.getSettings);
      assert.strictEqual(autoCompactContext, true);
    }).pipe(Effect.provide(layerTest())),
  );
});
