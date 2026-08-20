// ru-code: user-facing hard-stop for the launcher — print a clean message and exit
// non-zero (no stack trace). The launcher owns no resources, so a direct exit is
// fine here.

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { formatErrorNotice } from "./banner.ts";

export const failWith = (message: string): Effect.Effect<never> =>
  Console.error(formatErrorNotice(message)).pipe(
    Effect.andThen(Effect.sync(() => process.exit(1) as never)),
  );
