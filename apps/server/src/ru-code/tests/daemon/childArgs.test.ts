// ru-code: the argv the launcher hands the detached child — the spawn contract.
// Pins the forced loopback + web mode + resolved base dir, the forwarded user
// flags, and the two flags we must NEVER forward (--no-browser would stop the
// child opening the pairing URL; --foreground would stop it being the server).

import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChildArgs,
  type ForwardableServerFlags,
  resolveDaemonHost,
  resolveDaemonPort,
} from "@ru-code/daemon/childArgs";

const noFlags: ForwardableServerFlags = {
  port: Option.none(),
  host: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  language: Option.none(),
  logWebSocketEvents: Option.none(),
};

const argsFor = (flags: ForwardableServerFlags): Array<string> =>
  buildChildArgs({
    flags,
    port: resolveDaemonPort(flags, 7777),
    host: resolveDaemonHost(flags),
    baseDir: "/base",
  });

describe("daemon childArgs", () => {
  it("defaults to loopback + 7777 in web mode with the base dir", () => {
    expect(argsFor(noFlags)).toEqual([
      "start",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      "7777",
      "--base-dir",
      "/base",
    ]);
  });

  it("honors --port and --host and forwards --language, with the positional cwd last", () => {
    expect(
      argsFor({
        ...noFlags,
        port: Option.some(8888),
        host: Option.some("127.0.0.2"),
        language: Option.some("ru"),
        cwd: Option.some("/work"),
      }),
    ).toEqual([
      "start",
      "--mode",
      "web",
      "--host",
      "127.0.0.2",
      "--port",
      "8888",
      "--base-dir",
      "/base",
      "--language",
      "ru",
      "/work",
    ]);
  });

  it("never forwards --no-browser or --foreground", () => {
    const args = argsFor({ ...noFlags, cwd: Option.some("/work"), language: Option.some("en") });
    expect(args).not.toContain("--no-browser");
    expect(args).not.toContain("--foreground");
  });

  it("forwards --log-websocket-events only when enabled", () => {
    expect(argsFor({ ...noFlags, logWebSocketEvents: Option.some(true) })).toContain(
      "--log-websocket-events",
    );
    expect(argsFor({ ...noFlags, logWebSocketEvents: Option.some(false) })).not.toContain(
      "--log-websocket-events",
    );
  });
});
