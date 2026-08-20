// ru-code: the whole daemon-vs-foreground routing decision, in one place. This is
// the composite that both `ru-code` and `start` funnel through (via
// runServerCommand) — guaranteeing it here pins the contract from the constants
// map: bare/ start → daemon, --foreground / the child env marker / headless serve
// → run in-process.

import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DAEMON_CHILD_ENV, shouldDaemonize } from "@ru-code/daemon";

const clearChildMarker = () => {
  delete process.env[DAEMON_CHILD_ENV];
};

describe("daemon routing (shouldDaemonize)", () => {
  afterEach(clearChildMarker);

  it("bare `ru-code` / `start` daemonizes", () => {
    clearChildMarker();
    expect(shouldDaemonize({ foreground: Option.none() })).toBe(true);
  });

  it("--foreground opts out", () => {
    clearChildMarker();
    expect(shouldDaemonize({ foreground: Option.some(true) })).toBe(false);
  });

  it("the spawned child (env marker) never re-daemonizes", () => {
    process.env[DAEMON_CHILD_ENV] = "1";
    expect(shouldDaemonize({ foreground: Option.none() })).toBe(false);
  });

  it("headless `serve` never daemonizes", () => {
    clearChildMarker();
    expect(
      shouldDaemonize({ foreground: Option.none() }, { startupPresentation: "headless" }),
    ).toBe(false);
  });

  it("an omitted foreground field still daemonizes (existing flag literals)", () => {
    clearChildMarker();
    expect(shouldDaemonize({})).toBe(true);
  });
});
