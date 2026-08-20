// ru-code: the CLI-surface bits the app seams import — the `--foreground` /
// `--force` flags, and the single predicate that decides "background or attach".

import * as Option from "effect/Option";
import { Flag } from "effect/unstable/cli";

import { DAEMON_CHILD_ENV } from "./constants.ts";

/** `--foreground` (alias `--fg`): run attached in this terminal instead of daemonizing. */
export const foregroundFlag = Flag.boolean("foreground").pipe(
  Flag.withDescription("Run attached in this terminal instead of in the background."),
  Flag.withAlias("fg"),
  Flag.optional,
);

/** `--force`: on `stop`, SIGKILL immediately instead of a graceful SIGTERM drain. */
export const forceFlag = Flag.boolean("force").pipe(
  Flag.withDescription("Force an immediate stop (SIGKILL) instead of a graceful shutdown."),
  Flag.optional,
);

export interface DaemonRoutingFlags {
  readonly foreground?: Option.Option<boolean>;
}

/**
 * Should this `runServerCommand` invocation background itself? No when it's the
 * headless `serve` path, no when this process IS the spawned child (env marker),
 * no under `--foreground`. Otherwise yes — bare `ru-code` and `start` daemonize.
 */
export const shouldDaemonize = (
  flags: DaemonRoutingFlags,
  options?: { readonly startupPresentation?: string },
): boolean => {
  if (options?.startupPresentation === "headless") {
    return false;
  }
  if (process.env[DAEMON_CHILD_ENV] === "1") {
    return false;
  }
  return !Option.getOrElse(flags.foreground ?? Option.none(), () => false);
};
