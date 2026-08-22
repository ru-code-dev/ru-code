// ru-code: coverage for the QwenProvider snapshot builders beyond the pure
// `parseQwenVersionOutput` classifier (covered in QwenProvider.test.ts):
//   - buildInitialQwenProviderSnapshot: disabled vs enabled placeholder draft
//   - checkQwenProviderStatus: disabled early-return (no spawn), version-probe
//     success, command-missing, and non-missing spawn failure branches.
import { beforeEach, describe, expect, it } from "@effect/vitest";
import { APP_NAME, resolveCliProfile } from "@ru-code/branding";
import { QwenSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildInitialQwenProviderSnapshot,
  checkQwenProviderStatus,
} from "../../qwen/QwenProvider.ts";
import { clearVersionProbeCacheForTests } from "../../qwen/versionProbeCache.ts";

// ru-code: the version probe is cached per CLI path for the process lifetime;
// reset it so each case gets a fresh probe.
beforeEach(() => {
  clearVersionProbeCacheForTests();
});

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const ENABLED = decodeQwenSettings({});
const DISABLED = decodeQwenSettings({ enabled: false });
// ru-code: the per-instance profile label the driver threads in.
const LABEL = "Qwen Code";

/** A spawner whose stdout/stderr/exit are canned. */
const cannedSpawner = (out: { stdout?: string; stderr?: string; code?: number }) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
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
    ),
  );

/** A spawner whose spawn fails with the supplied PlatformError. */
const failingSpawner = (error: PlatformError.PlatformError) =>
  ChildProcessSpawner.make(() => Effect.fail(error));

/** A spawner that dies if spawn is ever invoked — proves the no-spawn path. */
const forbiddenSpawner = ChildProcessSpawner.make(() =>
  Effect.die("spawn must not be called on the disabled path"),
);

const provideSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

describe("buildInitialQwenProviderSnapshot", () => {
  it.effect("disabled settings → disabled placeholder, no models", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(DISABLED, LABEL);
      expect(draft.enabled).toBe(false);
      expect(draft.status).toBe("disabled");
      expect(draft.installed).toBe(false);
      expect(draft.version).toBeNull();
      expect(draft.models).toEqual([]);
      expect(draft.message).toContain(LABEL);
      expect(draft.message).toContain(APP_NAME);
    }),
  );

  it.effect("enabled settings → ready placeholder advertises the profile's built-ins", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(ENABLED, LABEL);
      expect(draft.enabled).toBe(true);
      // ru-code: `ready`, not a "checking…" warning — the model picker only enables an
      // instance while status is "ready", so a placeholder warning disables the provider
      // for the whole probe.
      expect(draft.status).toBe("ready");
      expect(draft.installed).toBe(true);
      expect(draft.version).toBeNull();
      expect(draft.message).toBeUndefined();
      // Model-agnostic: the snapshot advertises exactly the instance profile's built-in
      // models — whatever they are — not a hardcoded slug list.
      const profileModels = resolveCliProfile(ENABLED.profile).models;
      expect(draft.models.map((m) => m.slug)).toEqual(profileModels.map((m) => m.slug));
    }),
  );
});

// ru-code: per-profile models + custom-model append (fixes the chat-picker gap) +
// per-model auth. Built-ins come from the profile; customs are appended with the
// auth method that setModel dispatches with (own or the instance default).
describe("qwenModelsForSettings — via buildInitialQwenProviderSnapshot", () => {
  const enabled = (extra: Record<string, unknown>) =>
    decodeQwenSettings({ enabled: true, ...extra });

  it.effect("custom profile built-ins mirror the registry (slug + auth), none custom", () =>
    Effect.gen(function* () {
      const settings = enabled({ profile: "custom" });
      const draft = yield* buildInitialQwenProviderSnapshot(settings, LABEL);
      const profileModels = resolveCliProfile(settings.profile).models;
      // Model-agnostic: the derivation carries EACH profile model's slug + its authMethod
      // (as authType), marks them non-custom — regardless of which models the profile ships.
      expect(draft.models.map((m) => m.slug)).toEqual(profileModels.map((m) => m.slug));
      expect(draft.models.every((m) => m.isCustom === false)).toBe(true);
      for (const model of draft.models) {
        const profileModel = profileModels.find((p) => p.slug === model.slug);
        expect(model.authType).toBe(profileModel?.authMethod);
      }
    }),
  );

  it.effect("stock qwen ships zero built-ins; custom models are appended with their auth", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(
        enabled({
          profile: "qwen",
          customModels: [{ slug: "my-model", authMethod: "anthropic" }],
        }),
        LABEL,
      );
      expect(draft.models.length).toBe(1);
      expect(draft.models[0]).toMatchObject({
        slug: "my-model",
        isCustom: true,
        authType: "anthropic",
      });
    }),
  );

  it.effect("a custom model with no auth inherits the resolved instance default", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialQwenProviderSnapshot(
        enabled({ profile: "qwen", customModels: [{ slug: "m1", authMethod: "" }] }),
        LABEL,
      );
      // stock qwen's default auth is qwen-oauth.
      expect(draft.models[0]?.authType).toBe("qwen-oauth");
    }),
  );
});

describe("checkQwenProviderStatus", () => {
  it.effect("disabled settings return the disabled draft WITHOUT spawning", () =>
    Effect.gen(function* () {
      const draft = yield* checkQwenProviderStatus("/fake/cli.js", DISABLED, LABEL, {}).pipe(
        Effect.provide(provideSpawner(forbiddenSpawner)),
      );
      expect(draft.enabled).toBe(false);
      expect(draft.status).toBe("disabled");
      expect(draft.installed).toBe(false);
      expect(draft.models).toEqual([]);
      expect(draft.message).toContain("disabled");
    }),
  );

  it.effect("enabled + version probe exit 0 → ready with parsed version and models", () =>
    Effect.gen(function* () {
      const draft = yield* checkQwenProviderStatus("/fake/cli.js", ENABLED, LABEL, {}).pipe(
        Effect.provide(provideSpawner(cannedSpawner({ stdout: "qwen 1.2.3\n", code: 0 }))),
      );
      expect(draft.enabled).toBe(true);
      expect(draft.status).toBe("ready");
      expect(draft.installed).toBe(true);
      expect(draft.version).toBe("1.2.3");
      expect(draft.models.length).toBe(2);
    }),
  );

  // ru-code: the version came through, so the exit code is unrelated noise — the provider stays
  // `ready` (a warning would disable it in the model picker). See QwenProvider.test.ts.
  it.effect("enabled + non-zero exit with version → ready, version reported", () =>
    Effect.gen(function* () {
      const draft = yield* checkQwenProviderStatus("/fake/cli.js", ENABLED, LABEL, {}).pipe(
        Effect.provide(
          provideSpawner(cannedSpawner({ stdout: "qwen 4.5.6\n", stderr: "boom", code: 3 })),
        ),
      );
      expect(draft.installed).toBe(true);
      expect(draft.status).toBe("ready");
      expect(draft.version).toBe("4.5.6");
      expect(draft.message).toBeUndefined();
    }),
  );

  it.effect("enabled + command-missing spawn failure → not installed, error", () =>
    Effect.gen(function* () {
      const notFound = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "qwen missing",
      });
      const draft = yield* checkQwenProviderStatus("/fake/cli.js", ENABLED, LABEL, {}).pipe(
        Effect.provide(provideSpawner(failingSpawner(notFound))),
      );
      expect(draft.installed).toBe(false);
      expect(draft.status).toBe("error");
      expect(draft.message).toContain("not installed");
    }),
  );

  it.effect("enabled + non-missing spawn failure → installed true, generic error", () =>
    Effect.gen(function* () {
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "spawn",
        description: "permission denied",
      });
      const draft = yield* checkQwenProviderStatus("/fake/cli.js", ENABLED, LABEL, {}).pipe(
        Effect.provide(provideSpawner(failingSpawner(denied))),
      );
      expect(draft.installed).toBe(true);
      expect(draft.status).toBe("error");
      expect(draft.message).toContain("Could not run");
    }),
  );
});
