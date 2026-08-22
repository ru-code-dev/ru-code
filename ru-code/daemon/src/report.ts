// ru-code: user-facing hard-stop for the launcher — print a clean message and exit
// non-zero (no stack trace). The launcher owns no resources, so a direct exit is
// fine here. `failWithJson` is the same stop under `--json`: the SAME message, but
// as the one-line failure record on stdout (the installer reads only `ok`), and
// nothing on stderr.

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { formatErrorNotice } from "./banner.ts";
import { formatLaunchFailureJson } from "./launchReport.ts";

const exitNonZero = Effect.sync(() => process.exit(1) as never);

export const failWith = (message: string): Effect.Effect<never> =>
  Console.error(formatErrorNotice(message)).pipe(Effect.andThen(exitNonZero));

export const failWithJson = (message: string, logPath: string): Effect.Effect<never> =>
  Console.log(formatLaunchFailureJson({ error: message, log: logPath })).pipe(
    Effect.andThen(exitNonZero),
  );
