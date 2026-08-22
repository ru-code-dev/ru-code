// ru-code: the daemon-boot environment report. The point of the line is that a
// support log can answer "what did the daemon actually get?", so the tests pin the
// three things that would silently destroy that answer: a missing variable being
// indistinguishable from an empty one, a value being truncated or reordered, and
// the report firing outside the daemon child (where it is noise).

import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import {
  BOOT_ENV_PREFIX,
  formatBootEnvironment,
  reportBootEnvironment,
} from "@ru-code/daemon/bootEnv";
import { DAEMON_CHILD_ENV } from "@ru-code/daemon/constants";

const facts = (env: NodeJS.ProcessEnv) => ({
  env,
  platform: "win32",
  arch: "x64",
  nodeVersion: "v22.11.0",
  cwd: String.raw`C:\Users\u\project`,
});

const lines = (env: NodeJS.ProcessEnv): Array<string> =>
  formatBootEnvironment(facts(env)).split("\n");

describe("daemon bootEnv", () => {
  it("reports platform, cwd and every diagnostic variable, each on its own prefixed line", () => {
    const reported = lines({ PATH: "C:\\git\\cmd", HOME: "C:\\Users\\u", SHELL: "/bin/bash" });

    expect(reported.every((line) => line.startsWith(BOOT_ENV_PREFIX))).toBe(true);
    expect(reported[0]).toBe(`${BOOT_ENV_PREFIX} platform=win32 arch=x64 node=v22.11.0`);
    expect(reported[1]).toBe(`${BOOT_ENV_PREFIX} cwd=C:\\Users\\u\\project`);
    expect(reported).toContain(`${BOOT_ENV_PREFIX} PATH=C:\\git\\cmd`);
    expect(reported).toContain(`${BOOT_ENV_PREFIX} HOME=C:\\Users\\u`);
    expect(reported).toContain(`${BOOT_ENV_PREFIX} SHELL=/bin/bash`);
  });

  // An empty PATH and an absent PATH are different failures — one means "the
  // launcher passed nothing", the other "something cleared it". A report that
  // rendered both as blank would send the reader down the wrong path.
  it("distinguishes unset from empty", () => {
    const reported = lines({ PATH: "" });

    expect(reported).toContain(`${BOOT_ENV_PREFIX} PATH=(empty)`);
    expect(reported).toContain(`${BOOT_ENV_PREFIX} HOME=(unset)`);
  });

  // The Windows pair matters: HOME unset with USERPROFILE set is normal, both
  // unset is why git cannot find its config.
  it("keeps the windows-specific variables even when the posix ones are set", () => {
    const reported = lines({ HOME: "/home/u", USERPROFILE: "C:\\Users\\u", TEMP: "C:\\Temp" });

    expect(reported).toContain(`${BOOT_ENV_PREFIX} USERPROFILE=C:\\Users\\u`);
    expect(reported).toContain(`${BOOT_ENV_PREFIX} TEMP=C:\\Temp`);
    expect(reported).toContain(`${BOOT_ENV_PREFIX} TMP=(unset)`);
  });

  effectIt.effect("prints nothing unless this process is the spawned daemon child", () =>
    Effect.gen(function* () {
      const printed: Array<unknown> = [];
      // Captured through the Console SERVICE, which is what `Console.log` writes to — stubbing the
      // global `console` would silently record nothing and the spec would pass either way.
      const recording = {
        ...(yield* Console.Console),
        log: (...args: ReadonlyArray<unknown>) => {
          printed.push(...args);
        },
      };
      const previous = process.env[DAEMON_CHILD_ENV];
      try {
        delete process.env[DAEMON_CHILD_ENV];
        yield* reportBootEnvironment().pipe(Effect.provideService(Console.Console, recording));
        assert.lengthOf(printed, 0);

        process.env[DAEMON_CHILD_ENV] = "1";
        yield* reportBootEnvironment().pipe(Effect.provideService(Console.Console, recording));
        assert.lengthOf(printed, 1);
        assert.include(String(printed[0]), `${BOOT_ENV_PREFIX} PATH=`);
      } finally {
        if (previous === undefined) delete process.env[DAEMON_CHILD_ENV];
        else process.env[DAEMON_CHILD_ENV] = previous;
      }
    }),
  );
});
