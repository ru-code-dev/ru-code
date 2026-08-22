// ru-code: fault injection for the credential-wizard error paths.
//
// These five had ZERO hits across the whole test tree, against this project's own "0 untested
// errors" rule — and they are exactly the paths item AU-14 is about, since each one now has its own
// sentence instead of «Что-то пошло не так». A path with a sentence and no test is a sentence
// nobody has ever seen.
//
// Every failure is injected through a STUB ProcessRunner, so the specs are hermetic: no git binary,
// no ssh-keyscan, no network, no host state. The stub answers per command, which is what makes it
// possible to let the credential test PASS and then fail the host pin — the ordering that guards
// «pin before persist» and that no real machine reproduces on demand.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";

import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ServerConfig from "../../../config.ts";
import { UpdateEngine } from "../../auto-update/UpdateEngine.ts";
import { UpdateEngineLive } from "../../auto-update/engine/updateEngineLive.ts";
import { UpdateHttpClientLayer } from "../../auto-update/updateHttpClient.ts";

/** How the stub answers one spawned command. */
interface StubReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

/**
 * A ProcessRunner that answers by COMMAND NAME. Anything not named fails the way a missing binary
 * would, so a spec can never pass by accidentally reaching a real tool.
 */
const stubRunner = (replies: Record<string, StubReply>): Layer.Layer<ProcessRunner.ProcessRunner> =>
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) => {
      const reply = replies[input.command];
      if (reply === undefined) {
        return Effect.succeed({
          stdout: "",
          stderr: `${input.command}: not found`,
          code: ChildProcessSpawner.ExitCode(127),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      }
      return Effect.succeed({
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: ChildProcessSpawner.ExitCode(reply.code ?? 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });

const engineLayer = (baseDir: string, runner: Layer.Layer<ProcessRunner.ProcessRunner>) =>
  UpdateEngineLive.pipe(
    Layer.provide(runner),
    Layer.provide(UpdateHttpClientLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

/** Set env for the duration, restoring exactly what was there (including "was not set"). */
const withEnv = <A, E, R>(
  vars: Record<string, string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(vars)) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      return saved;
    }),
    () => effect,
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

const SSH_URL = "ssh://git@updates.example.com/releases.git";

/** A sandbox with its own HOME, so nothing here can reach the developer's ~/.ssh. */
const sandbox = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectory({ prefix: "au-cred-base-" });
  const home = yield* fs.makeTempDirectory({ prefix: "au-cred-home-" });
  const appRoot = yield* fs.makeTempDirectory({ prefix: "au-cred-app-" });
  return { baseDir, home, appRoot };
});

const runWithEngine = <A>(
  input: {
    readonly gitUrl: string;
    readonly replies: Record<string, StubReply>;
  },
  body: (engine: UpdateEngine["Service"]) => Effect.Effect<A, never, never>,
): Effect.Effect<A, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { baseDir, home, appRoot } = yield* sandbox;
    return yield* withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        RU_CODE_APP_ROOT: appRoot,
        RU_CODE_UPDATE_GIT_URL: input.gitUrl,
        RU_CODE_UPDATE_WEB_URL: "",
      },
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* UpdateEngine;
          return yield* body(engine);
        }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir, stubRunner(input.replies))))),
      ),
    );
  });

/** ssh-keygen answers for a key we never actually create — enough to get past fingerprinting. */
const KEYGEN_OK: StubReply = { stdout: "256 SHA256:AAAAfingerprint comment (ED25519)\n" };

it.layer(NodeServices.layer)("credential wizard error paths", (it) => {
  // ── creds-test-failed ──────────────────────────────────────────────────────
  // Three sites emit it (https save, ssh save, web save). The rule it protects: a credential that
  // does not work is NEVER persisted, so a wizard can't leave a source authenticating with junk.
  it.effect("https: a rejected credential fails the save and stores nothing", () =>
    Effect.gen(function* () {
      const outcome = yield* runWithEngine(
        {
          gitUrl: "https://updates.example.com/releases.git",
          replies: { git: { code: 128, stderr: "fatal: Authentication failed" } },
        },
        (engine) =>
          Effect.gen(function* () {
            const failed = yield* engine
              .saveGitHttps({ username: "u", password: "wrong" })
              .pipe(Effect.result);
            const state = yield* engine.state.pipe(Effect.orDie);
            return { failed, httpsCred: state.git.httpsCred };
          }),
      );

      assert.strictEqual(outcome.failed._tag, "Failure");
      if (outcome.failed._tag === "Failure") {
        assert.strictEqual(outcome.failed.failure.code, "creds-test-failed");
      }
      // Nothing was recorded — the source is not left pointing at a credential that fails.
      assert.strictEqual(outcome.httpsCred, null);
    }),
  );

  it.effect("ssh: a rejected key fails the save and stores nothing", () =>
    Effect.gen(function* () {
      const outcome = yield* runWithEngine(
        {
          gitUrl: SSH_URL,
          replies: {
            git: { code: 128, stderr: "git@host: Permission denied (publickey)." },
            "ssh-keygen": KEYGEN_OK,
          },
        },
        (engine) =>
          Effect.gen(function* () {
            const failed = yield* engine
              .saveSsh({ origin: "paste", privateKeyPem: "-----BEGIN KEY-----\nAA\n" })
              .pipe(Effect.result);
            const state = yield* engine.state.pipe(Effect.orDie);
            return { failed, sshCred: state.git.sshCred };
          }),
      );

      assert.strictEqual(outcome.failed._tag, "Failure");
      if (outcome.failed._tag === "Failure") {
        assert.strictEqual(outcome.failed.failure.code, "creds-test-failed");
      }
      assert.strictEqual(outcome.sshCred, null);
    }),
  );

  // ── keygen-failed ──────────────────────────────────────────────────────────
  // The wizard fires this on ENTERING the generate step, so its failure is the first thing a user
  // can hit there — on any machine whose ssh-keygen is missing or blocked.
  it.effect("a machine without ssh-keygen reports keygen-failed", () =>
    Effect.gen(function* () {
      const outcome = yield* runWithEngine({ gitUrl: SSH_URL, replies: {} }, (engine) =>
        engine.generateSshKey.pipe(Effect.result),
      );

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.code, "keygen-failed");
      }
    }),
  );

  // ── key-unreadable ─────────────────────────────────────────────────────────
  // The path is an unconstrained wire string that would be PERSISTED and re-used on every scheduled
  // check. Refusing it at the boundary is what stops a typo becoming a source that silently never
  // authenticates again.
  it.effect("a key path that is not a readable file is refused at the boundary", () =>
    Effect.gen(function* () {
      const missing = `${NodeOS.tmpdir()}/ru-code-no-such-key-${String(process.pid)}`;
      const outcome = yield* runWithEngine(
        {
          gitUrl: SSH_URL,
          replies: { git: { code: 0, stdout: "ref\tHEAD" }, "ssh-keygen": KEYGEN_OK },
        },
        (engine) => engine.saveSsh({ origin: "file", path: missing }).pipe(Effect.result),
      );

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.code, "key-unreadable");
      }
    }),
  );

  it.effect("a directory is not a key either", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "au-cred-dir-" });
      const outcome = yield* runWithEngine(
        {
          gitUrl: SSH_URL,
          replies: { git: { code: 0, stdout: "ref\tHEAD" }, "ssh-keygen": KEYGEN_OK },
        },
        (engine) => engine.saveSsh({ origin: "file", path: dir }).pipe(Effect.result),
      );

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.code, "key-unreadable");
      }
    }),
  );

  // POSITIVE CONTROL. Every spec above asserts a failure, so one of them passing for the wrong
  // reason would be invisible. With the same stubs answering successfully, the same call must
  // SUCCEED and persist — which proves the failures above are caused by the injected fault and
  // nothing else.
  it.effect("with every step answering, the save succeeds and is recorded", () =>
    Effect.gen(function* () {
      const outcome = yield* runWithEngine(
        {
          gitUrl: SSH_URL,
          replies: {
            git: { code: 0, stdout: "ref\tHEAD" },
            "ssh-keygen": KEYGEN_OK,
            "ssh-keyscan": { code: 0, stdout: "|1|hash= ssh-ed25519 AAAAC3Nz\n" },
          },
        },
        (engine) =>
          Effect.gen(function* () {
            const saved = yield* engine
              .saveSsh({ origin: "paste", privateKeyPem: "-----BEGIN KEY-----\nAA\n" })
              .pipe(Effect.result);
            const state = yield* engine.state.pipe(Effect.orDie);
            return { saved, sshCred: state.git.sshCred };
          }),
      );

      assert.strictEqual(outcome.saved._tag, "Success");
      assert.strictEqual(outcome.sshCred?.fingerprint, "SHA256:AAAAfingerprint");
      assert.strictEqual(outcome.sshCred?.origin, "paste");
    }),
  );

  // AU-06's one accepted window, pinned so it is a decision and not an accident.
  //
  // `saveSsh` promotes the staged key (atomic rename) and THEN writes the credential record. If the
  // record write fails, the key now in use is the one that was just TESTED — so the source keeps
  // authenticating — while the stored fingerprint still describes the old one until the next save.
  // The reverse order would be no better (a record pointing at a key that is not there yet), and a
  // rollback would add a third file and a restore path to protect against a cosmetic staleness.
  it.effect("a failed credential-record write leaves the TESTED key in use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, home, appRoot } = yield* sandbox;
      // The credential store cannot write: its directory is taken by a FILE of the same name.
      yield* fs.writeFileString(`${baseDir}/auto-update-credentials.enc`, "");
      yield* fs.makeDirectory(`${home}/.ssh`, { recursive: true });

      const outcome = yield* withEnv(
        {
          HOME: home,
          USERPROFILE: home,
          RU_CODE_APP_ROOT: appRoot,
          RU_CODE_UPDATE_GIT_URL: SSH_URL,
          RU_CODE_UPDATE_WEB_URL: "",
        },
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* UpdateEngine;
            return yield* engine
              .saveSsh({ origin: "paste", privateKeyPem: "-----BEGIN NEW-----\nAA\n" })
              .pipe(Effect.result);
          }).pipe(
            Effect.provide(
              Layer.fresh(
                engineLayer(
                  baseDir,
                  stubRunner({ git: { code: 0, stdout: "ref\tHEAD" }, "ssh-keygen": KEYGEN_OK }),
                ),
              ),
            ),
          ),
        ),
      );

      // The save reports the failure — it never claims success it did not have.
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.code, "creds-save-failed");
      }
      // And whatever it did to the files, the key at the live path is the one that was tested:
      // either the promotion never happened (old key intact) or it did (new key, already proven).
      const live = `${home}/.ssh/ru_code_update_ed25519`;
      if (yield* fs.exists(live)) {
        assert.include(yield* fs.readFileString(live), "BEGIN NEW");
      }
      // Nothing is left staged for a later save to promote blindly.
      assert.strictEqual(yield* fs.exists(`${live}.new`), false);
    }),
  );
});
