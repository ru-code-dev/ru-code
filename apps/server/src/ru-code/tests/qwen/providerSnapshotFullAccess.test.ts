// ru-code: the qwen provider snapshot must LOCK full-access for the composer —
// its presentation stamps `allowsFullAccess: false` (yolo bypasses the CLI's L4
// PermissionManager rules), buildServerProvider passes it through to the draft,
// and the ServerProvider wire schema the web decodes must carry it verbatim.
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  QwenSettings,
  ServerProvider,
} from "@t3tools/contracts";
import { QWEN_KIND } from "@ru-code/branding";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildInitialQwenProviderSnapshot } from "../../qwen/QwenProvider.ts";

const decodeQwenSettings = Schema.decodeUnknownSync(QwenSettings);
const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeServerProvider = Schema.encodeSync(ServerProvider);

describe("qwen provider snapshot — full-access lock", () => {
  it.effect("the built draft carries allowsFullAccess === false", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(decodeQwenSettings({}), "Qwen");
      expect(draft.allowsFullAccess).toBe(false);
    }),
  );

  it.effect("a disabled instance still stamps allowsFullAccess === false", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(
        decodeQwenSettings({ enabled: false }),
        "Qwen",
      );
      expect(draft.allowsFullAccess).toBe(false);
    }),
  );

  it.effect("allowsFullAccess: false survives the ServerProvider wire round-trip", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(decodeQwenSettings({}), "Qwen");
      // Complete the draft to the full snapshot the server serves (the driver
      // stamps instanceId/driver) and push it through the exact schema the web
      // decodes.
      const served = decodeServerProvider(
        encodeServerProvider({
          ...draft,
          instanceId: ProviderInstanceId.make(QWEN_KIND),
          driver: ProviderDriverKind.make(QWEN_KIND),
        }),
      );
      expect(served.allowsFullAccess).toBe(false);
    }),
  );
});
