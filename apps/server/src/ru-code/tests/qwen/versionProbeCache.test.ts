// ru-code: the version probe runs at most once per CLI path per process, and no probe outcome
// may cost the user their provider.
//
// Covered here:
//   • the probe is cached per path — a second check spawns nothing, a different path probes;
//   • a timed-out probe is cached too (the slow machines are exactly the ones that time out,
//     and re-probing them forever is the failure this replaces) and stays `ready`;
//   • a failed spawn is NOT cached — installing/fixing the CLI is picked up next refresh;
//   • the pre-probe placeholder is seeded from the cache when the path is known;
//   • output parsing: stdout wins over stderr, a version-only line wins over loose text, and a
//     non-zero exit alongside a parsed version does not degrade the provider.

import { describe, expect, it, beforeEach } from "@effect/vitest";
import { CLI_VERSION_PROBE_TIMEOUT_MS } from "@ru-code/qwen/constants";
import { QwenSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildInitialQwenProviderSnapshot,
  checkQwenProviderStatus,
  parseQwenVersionOutput,
} from "../../qwen/QwenProvider.ts";
import { clearVersionProbeCacheForTests } from "../../qwen/versionProbeCache.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const ENABLED = decodeQwenSettings({});
const LABEL = "Qwen Code";
const CLI_PATH = "/opt/app/qwen/bin/cli.js";
const OTHER_CLI_PATH = "/home/user/other/cli.js";

/** A spawner with canned output that counts how many times it was asked to spawn. */
function countingSpawner(out: { stdout?: string; stderr?: string; code?: number }) {
  const calls = { count: 0 };
  const spawner = ChildProcessSpawner.make(() => {
    calls.count += 1;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(out.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(out.stdout ?? "")),
        stderr: Stream.encodeText(Stream.make(out.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, calls };
}

/** A spawner that never returns, so the probe hits its timeout. */
function hangingSpawner() {
  const calls = { count: 0 };
  const spawner = ChildProcessSpawner.make(() => {
    calls.count += 1;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.never,
        stderr: Stream.never,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, calls };
}

/** A spawner whose spawn fails, counting attempts. */
function failingSpawner(error: PlatformError.PlatformError) {
  const calls = { count: 0 };
  const spawner = ChildProcessSpawner.make(() => {
    calls.count += 1;
    return Effect.fail(error);
  });
  return { spawner, calls };
}

const missingBinaryError = PlatformError.systemError({
  _tag: "NotFound",
  module: "Command",
  method: "spawn",
  pathOrDescriptor: CLI_PATH,
  description: "spawn ENOENT",
});

const provideSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

beforeEach(() => {
  clearVersionProbeCacheForTests();
});

describe("version probe cache", () => {
  it.effect("probes once per path and serves every later check from memory", () =>
    Effect.gen(function* () {
      const { spawner, calls } = countingSpawner({ stdout: "0.13.1\n" });

      const first = yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );
      const second = yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );
      const third = yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );

      expect(calls.count).toBe(1);
      expect(first.version).toBe("0.13.1");
      expect(second.version).toBe("0.13.1");
      expect(third.version).toBe("0.13.1");
      expect(second.status).toBe("ready");
    }),
  );

  it.effect("a different CLI path is probed on its own", () =>
    Effect.gen(function* () {
      const { spawner, calls } = countingSpawner({ stdout: "0.13.1\n" });

      yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );
      yield* checkQwenProviderStatus(OTHER_CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );
      // …and each of them stays cached afterwards.
      yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );
      yield* checkQwenProviderStatus(OTHER_CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );

      expect(calls.count).toBe(2);
    }),
  );

  it.effect("a timed-out probe is remembered, stays usable, and explains itself", () =>
    Effect.gen(function* () {
      const { spawner, calls } = hangingSpawner();

      // Virtual time: the probe waits out its real budget without the test doing so.
      const probe = yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(CLI_VERSION_PROBE_TIMEOUT_MS));
      const first = yield* Fiber.join(probe);

      const second = yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );

      // The slow machine pays the wait once, not on every refresh.
      expect(calls.count).toBe(1);
      // Usable: `ready` keeps the instance selectable in the model picker.
      expect(first.status).toBe("ready");
      expect(first.installed).toBe(true);
      expect(first.version).toBeNull();
      expect(first.message).toContain(LABEL);
      expect(second).toMatchObject({
        status: "ready",
        version: null,
        message: first.message,
      });
    }),
  );

  it.effect("a failed spawn is not remembered, so a later install is picked up", () =>
    Effect.gen(function* () {
      const failing = failingSpawner(missingBinaryError);

      const missing = yield* checkQwenProviderStatus(
        CLI_PATH,
        "/home/u/.qwen",
        ENABLED,
        LABEL,
      ).pipe(Effect.provide(provideSpawner(failing.spawner)));
      expect(missing.status).toBe("error");
      expect(missing.installed).toBe(false);

      // The user installs the CLI; the next refresh must see it.
      const installed = countingSpawner({ stdout: "0.13.1\n" });
      const recovered = yield* checkQwenProviderStatus(
        CLI_PATH,
        "/home/u/.qwen",
        ENABLED,
        LABEL,
      ).pipe(Effect.provide(provideSpawner(installed.spawner)));

      expect(failing.calls.count).toBe(1);
      expect(installed.calls.count).toBe(1);
      expect(recovered.status).toBe("ready");
      expect(recovered.version).toBe("0.13.1");
    }),
  );

  it.effect("the disabled path never probes and never caches", () =>
    Effect.gen(function* () {
      const { spawner, calls } = countingSpawner({ stdout: "0.13.1\n" });
      const disabled = decodeQwenSettings({ enabled: false });

      const draft = yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", disabled, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );
      expect(calls.count).toBe(0);
      expect(draft.enabled).toBe(false);

      // Re-enabling must still probe.
      const enabledDraft = yield* checkQwenProviderStatus(
        CLI_PATH,
        "/home/u/.qwen",
        ENABLED,
        LABEL,
      ).pipe(Effect.provide(provideSpawner(spawner)));
      expect(calls.count).toBe(1);
      expect(enabledDraft.version).toBe("0.13.1");
    }),
  );

  it.effect("the pre-probe placeholder reuses a verdict already known for that path", () =>
    Effect.gen(function* () {
      const { spawner } = countingSpawner({ stdout: "0.13.1\n" });
      yield* checkQwenProviderStatus(CLI_PATH, "/home/u/.qwen", ENABLED, LABEL).pipe(
        Effect.provide(provideSpawner(spawner)),
      );

      const seeded = yield* buildInitialQwenProviderSnapshot(
        ENABLED,
        LABEL,
        Effect.succeed([]),
        CLI_PATH,
      );
      expect(seeded.version).toBe("0.13.1");
      expect(seeded.status).toBe("ready");

      // An unknown path still starts blank — and still usable.
      const blank = yield* buildInitialQwenProviderSnapshot(
        ENABLED,
        LABEL,
        Effect.succeed([]),
        OTHER_CLI_PATH,
      );
      expect(blank.version).toBeNull();
      expect(blank.status).toBe("ready");
    }),
  );
});

describe("parseQwenVersionOutput", () => {
  const parse = (result: { stdout?: string; stderr?: string; code?: number }) =>
    parseQwenVersionOutput(
      { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 },
      LABEL,
    );

  it("reads the version yargs prints on stdout", () => {
    expect(parse({ stdout: "0.13.1\n" })).toMatchObject({ version: "0.13.1", status: "ready" });
    expect(parse({ stdout: "v0.13.1\n" })).toMatchObject({ version: "0.13.1" });
  });

  it("prefers stdout over noise on stderr", () => {
    const parsed = parse({
      stdout: "0.13.1\n",
      stderr: "warning: MCP server foo@1.2.3 failed to start\n",
    });
    expect(parsed.version).toBe("0.13.1");
  });

  it("prefers a version-only line over a number quoted inside a message", () => {
    const parsed = parse({
      stdout: "This tool requires Node 20.11.1 or newer\n0.13.1\n",
    });
    expect(parsed.version).toBe("0.13.1");
  });

  it("keeps the provider ready when a version came through despite a non-zero exit", () => {
    // Shutdown noise (a credential check, an MCP server, a node-pty race) exits non-zero on
    // stderr; the CLI still identified itself, so the provider must not be degraded.
    const parsed = parse({
      stdout: "0.13.1\n",
      stderr: "Error: credential store unavailable\n    at Object.<anonymous>\n",
      code: 1,
    });
    expect(parsed).toMatchObject({ version: "0.13.1", status: "ready" });
    expect(parsed.message).toBeUndefined();
  });

  it("reports a warning only when the command failed AND said nothing usable", () => {
    const parsed = parse({ stderr: "Error: something went wrong\n", code: 1 });
    expect(parsed.version).toBeNull();
    expect(parsed.status).toBe("warning");
    expect(parsed.message).toContain(LABEL);
  });

  it("falls back to a loose scan when no line is a bare version", () => {
    expect(parse({ stdout: "qwen-code version 0.13.1 (build 42)\n" }).version).toBe("0.13.1");
  });

  it("reports no version when the output has none", () => {
    expect(parse({ stdout: "hello\n" })).toMatchObject({ version: null, status: "ready" });
  });
});
