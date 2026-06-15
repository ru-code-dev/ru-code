import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// The single timestamp source (ISO-8601), read from the Effect clock so tests
// can pin time. Matches ru-fork ws.ts:124.
export const nowIso: Effect.Effect<string> = Effect.map(DateTime.now, DateTime.formatIso);
