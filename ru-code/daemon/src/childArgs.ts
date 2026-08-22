// ru-code: build the argv for the detached child. The child runs the ordinary
// `start` path (so the daemon reuses the app's whole server/browser stack
// unchanged). We force loopback + web mode + the resolved base dir, forward the
// handful of user flags that make sense, and deliberately DON'T pass --no-browser
// (the child opens the tokenized pairing URL itself) or --foreground (the child is
// told it's the server via DAEMON_CHILD_ENV, not a flag).

import * as Option from "effect/Option";

import { DEFAULT_DAEMON_HOST } from "./constants.ts";

/** Structural subset of the CLI's server flags we forward to the child. */
export interface ForwardableServerFlags {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly language: Option.Option<"en" | "ru">;
  readonly logWebSocketEvents: Option.Option<boolean>;
  /**
   * Forwarded ONLY when explicitly true (the auto-update relaunch: the SW
   * updating page owns the browser, a new tab would fight it). Normal daemon
   * starts keep today's behavior — the child opens the pairing URL itself.
   */
  readonly noBrowser?: Option.Option<boolean>;
}

export const resolveDaemonPort = (flags: ForwardableServerFlags, defaultPort: number): number =>
  Option.getOrElse(flags.port, () => defaultPort);

export const resolveDaemonHost = (flags: ForwardableServerFlags): string =>
  Option.getOrElse(flags.host, () => DEFAULT_DAEMON_HOST);

/**
 * Compose the child argv: `start --mode web --host <loopback> --port <n>
 * --base-dir <resolved> [--language x] [--log-websocket-events] [<cwd>]`.
 */
export const buildChildArgs = (params: {
  readonly flags: ForwardableServerFlags;
  readonly port: number;
  readonly host: string;
  readonly baseDir: string;
}): Array<string> => {
  const args: Array<string> = [
    "start",
    "--mode",
    "web",
    "--host",
    params.host,
    "--port",
    String(params.port),
    "--base-dir",
    params.baseDir,
  ];
  if (Option.isSome(params.flags.language)) {
    args.push("--language", params.flags.language.value);
  }
  if (Option.isSome(params.flags.devUrl)) {
    args.push("--dev-url", params.flags.devUrl.value.toString());
  }
  if (Option.getOrElse(params.flags.logWebSocketEvents, () => false)) {
    args.push("--log-websocket-events");
  }
  // ru-code: auto-update relaunch only — see ForwardableServerFlags.noBrowser.
  if (Option.getOrElse(params.flags.noBrowser ?? Option.none(), () => false)) {
    args.push("--no-browser");
  }
  // Positional working directory goes last.
  if (Option.isSome(params.flags.cwd)) {
    args.push(params.flags.cwd.value);
  }
  return args;
};
