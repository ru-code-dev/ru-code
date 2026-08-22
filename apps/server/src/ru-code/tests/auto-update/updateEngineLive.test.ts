// ru-code: the auto-update engine orchestrator (updateEngineLive.ts) against a REAL local http
// update server + a REAL installed layout under a temp RU_CODE_APP_ROOT. Deterministic: no sleeps
// inside assertions — the SubscriptionRef state is polled with a bounded retry until a predicate
// holds. Covers: boot fires NO check (zero requests until the schedule says so) · checkNow finds a
// newer release (available + history + persisted across a reboot) · 404 answered fail (no pause) ·
// 401 ×2 pauses + zero further traffic · install happy path (download → pointer flip → journal
// started → restart phase; relaunch stubbed by RU_CODE_UPDATE_TEST_NO_RELAUNCH) · sha mismatch →
// run failed archive-integrity + pointer untouched · double-press no-op · retryRun after a failure.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import type { AutoUpdateError, AutoUpdateWireState } from "@t3tools/contracts";

import {
  releaseTarballName,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  UPDATE_GIT_BRANCH,
  UPDATE_GIT_RELEASE_DIR,
} from "@ru-code/branding";

import * as ProcessRunner from "../../../processRunner.ts";
import * as ServerConfig from "../../../config.ts";
import { UpdateEngine } from "../../auto-update/UpdateEngine.ts";
import { UpdateEngineLive } from "../../auto-update/engine/updateEngineLive.ts";
import { UpdateHttpClientLayer } from "../../auto-update/updateHttpClient.ts";
import { CHECKSUMS_FILENAME } from "../../auto-update/apply/checksums.ts";
import { VERSION_ENTRY_FILENAME } from "../../auto-update/apply/fetchVersion.ts";
import { readPointer } from "../../auto-update/apply/pointer.ts";
import { readJournal } from "../../auto-update/apply/journal.ts";
import { deferredSignal } from "./deferredSignal.ts";

const NEWER_VERSION = "999.0.0";

const sha256Hex = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Build a real, SHIPPING-SHAPED release bundle and tar it: the archive root holds the wrapper +
 * pointer (which an update must ignore) and the payload lives at `versions/<NEWER_VERSION>/`.
 */
const buildTarball = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workDir = yield* fs.makeTempDirectory({ prefix: "au-engine-fixture-" });
  const bundle = path.join(workDir, "bundle");
  const payload = path.join(bundle, "versions", NEWER_VERSION);
  yield* fs.makeDirectory(payload, { recursive: true });
  yield* fs.writeFileString(
    path.join(bundle, VERSION_ENTRY_FILENAME),
    "// FROZEN launcher decoy\n",
  );
  yield* fs.writeFileString(
    path.join(bundle, "current.json"),
    JSON.stringify({
      schema: 1,
      version: NEWER_VERSION,
      entry: `versions/${NEWER_VERSION}/cli.js`,
    }),
  );
  yield* fs.writeFileString(
    path.join(payload, VERSION_ENTRY_FILENAME),
    "console.log('app v999')\n",
  );
  yield* fs.writeFileString(path.join(payload, "lib.js"), "export const x = 1\n");
  const files: Record<string, string> = {};
  for (const name of [VERSION_ENTRY_FILENAME, "lib.js"]) {
    files[name] = sha256Hex(yield* fs.readFile(path.join(payload, name)));
  }
  yield* fs.writeFileString(
    path.join(payload, CHECKSUMS_FILENAME),
    JSON.stringify({ algo: "sha256", files }),
  );
  const tarballPath = path.join(workDir, "release.tgz");
  yield* Effect.callback<void>((resume) => {
    const child = NodeChildProcess.spawn("tar", ["-czf", tarballPath, "-C", bundle, "."], {
      stdio: "ignore",
    });
    child.on("close", () => resume(Effect.void));
    child.on("error", () => resume(Effect.void));
  });
  return yield* fs.readFile(tarballPath);
});

/** Mutable fixture-server config the tests drive (sha/status/delay flip between phases). */
interface FixtureState {
  base: string;
  version: string;
  sha: string;
  tarball: Uint8Array;
  manifestStatus: number;
  /** Hold the manifest response open, so a spec can observe the round mid-flight. */
  manifestDelayMs: number;
  tarballDelayMs: number;
  /** Answer the tarball request with headers only and never a body (see the timeout spec). */
  tarballStall: boolean;
  /** Fired the moment a tarball request lands — lets a spec order itself without a sleep. */
  onTarballRequest?: () => void;
  readonly requests: Array<string>;
}

const handleRequest = (
  state: FixtureState,
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
): void => {
  const url = req.url ?? "";
  state.requests.push(url);
  if (url.startsWith("/manifest.json")) {
    if (state.manifestStatus !== 200) {
      res.statusCode = state.manifestStatus;
      res.end(`status ${String(state.manifestStatus)}`);
      return;
    }
    res.setHeader("content-type", "application/json");
    const sendManifest = (): void => {
      res.end(
        JSON.stringify({
          version: state.version,
          sha256: state.sha,
          minNode: ">=18",
          sizeBytes: state.tarball.byteLength,
          releasedAt: null,
        }),
      );
    };
    if (state.manifestDelayMs > 0) setTimeout(sendManifest, state.manifestDelayMs);
    else sendManifest();
    return;
  }
  if (url.startsWith("/changelog.json")) {
    res.statusCode = 404;
    res.end("no changelog");
    return;
  }
  // G25: the manifest carries no address — the engine asks for the sibling named by the shared
  // `releaseTarballName` convention. Serving anything else would mean the derivation is untested.
  if (url.startsWith(`/${releaseTarballName(state.version)}`)) {
    const send = (): void => {
      res.setHeader("content-length", state.tarball.byteLength);
      res.end(Buffer.from(state.tarball));
    };
    // A peer that answers, promises a length, and then goes quiet — the shape that emits no
    // transport event at all and so is invisible without a time budget.
    if (state.tarballStall) {
      res.setHeader("content-length", state.tarball.byteLength);
      res.flushHeaders();
      state.onTarballRequest?.();
      return;
    }
    state.onTarballRequest?.();
    if (state.tarballDelayMs > 0) setTimeout(send, state.tarballDelayMs);
    else send();
    return;
  }
  res.statusCode = 404;
  res.end("not found");
};

/** Run `body` against a live fixture server; `state.base` is filled with the server URL. */
const withServer = <A, E>(
  state: FixtureState,
  body: (url: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const server = NodeHttp.createServer((req, res) => handleRequest(state, req, res));
    yield* Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const url = `http://127.0.0.1:${String(port)}`;
    state.base = url;
    return yield* body(url).pipe(Effect.onExit(() => Effect.sync(() => server.close())));
  });

/** Set env vars for the duration of `effect`, restoring the prior values afterwards. */
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

const engineLayer = (baseDir: string) =>
  UpdateEngineLive.pipe(
    Layer.provide(ProcessRunner.layer),
    // ru-code: the SHIPPED transport, not a stand-in — the engine's own permissive-TLS node client
    // (updateHttpClient.ts). Testing on a different client would leave production's transport, and
    // the error text its failures produce, unexercised.
    Layer.provide(UpdateHttpClientLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

/** Real-timer sleep (bypasses the TestClock; E = never — poll helper for the detach law test). */
const realSleep = (ms: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), ms);
    return Effect.sync(() => clearTimeout(timer));
  });

/**
 * The git source is BAKED to a REAL repository (branding), so an engine test that leaves it alone
 * reaches the network on every check — and its verdict then depends on what that repo happens to
 * carry today. Every test here pins git to a path that cannot exist, so the git leg of the round
 * fails instantly and offline, and the assertions are about the WEB fixture, which is what they were
 * always testing.
 */
const OFFLINE_GIT_URL = `file:///nonexistent-${String(process.pid)}/ru-code-tests.git`;

/** ssh-keygen is a host tool; the one spec that needs it skips cleanly where it is absent. */
const sshKeygenAvailable =
  NodeChildProcess.spawnSync("ssh-keygen", ["-l", "-f", "/nonexistent-ru-code-probe"]).error ===
  undefined;

/**
 * `checkNow` and `install` REPLY as soon as their work is visibly under way — the outcome then
 * arrives through the state stream, which is where the client reads it from too (holding the request
 * open for a whole round is what put an orange «выполняются медленно» banner over every check and
 * every install). So a spec that used to assert on the reply now waits for the same state here.
 *
 * Bounded and on the REAL timer: these specs run under the TestClock, where an Effect sleep would
 * either not advance or would move the very clock the spec is controlling.
 */
interface StateReader {
  readonly state: Effect.Effect<AutoUpdateWireState, AutoUpdateError>;
}

const awaitState = (
  engine: StateReader,
  what: string,
  holds: (state: AutoUpdateWireState) => boolean,
): Effect.Effect<AutoUpdateWireState> =>
  Effect.gen(function* () {
    let latest = yield* engine.state.pipe(Effect.orDie);
    for (let attempt = 0; attempt < 800; attempt += 1) {
      if (holds(latest)) return latest;
      yield* realSleep(25);
      latest = yield* engine.state.pipe(Effect.orDie);
    }
    return assert.fail(`state never reached: ${what}`);
  });

/**
 * The state a settled check used to return. Keyed on the `checking` FLAG, not on the hero: a check
 * no longer replaces the hero status at all (it used to, which is how a background tick blanked an
 * advertised release for the whole round), so "the hero is not checking" is now true even while a
 * round is running.
 */
const settledCheck = (engine: StateReader): Effect.Effect<AutoUpdateWireState> =>
  awaitState(engine, "a settled check", (state) => state.checking !== true);

/** The state a finished install used to return: the run reached a terminal phase. */
const finishedRun = (engine: StateReader): Effect.Effect<AutoUpdateWireState> =>
  awaitState(
    engine,
    "a finished run",
    (state) =>
      state.run !== null && (state.run.phase === "restart" || state.run.phase === "failed"),
  );

/**
 * A REAL bare release repo on the branded release branch, so the engine can take its git leg for
 * real. Every other spec here pins git to a dead URL — which means the whole git chain (auth env →
 * clone → release verdict) has never actually run inside the engine, only one layer down.
 */
const gitAvailable = ((): boolean => {
  try {
    NodeChildProcess.execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const runGit = (args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync("git", args, {
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
};

const makeGitReleaseRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "au-engine-git-" });
  const bare = path.join(root, "release.git");
  const work = path.join(root, "work");
  runGit(["init", "--bare", "-b", UPDATE_GIT_BRANCH, bare]);
  runGit(["init", "-b", UPDATE_GIT_BRANCH, work]);
  runGit(["-C", work, "config", "user.email", "ci@example.com"]);
  runGit(["-C", work, "config", "user.name", "CI"]);
  runGit(["-C", work, "config", "commit.gpgsign", "false"]);
  const releaseDir = path.join(work, UPDATE_GIT_RELEASE_DIR);
  yield* fs.makeDirectory(releaseDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(releaseDir, "manifest.json"),
    JSON.stringify({
      version: NEWER_VERSION,
      sha256: "deadbeef",
      minNode: ">=18",
      sizeBytes: 4,
      releasedAt: null,
    }),
  );
  yield* fs.writeFileString(path.join(releaseDir, releaseTarballName(NEWER_VERSION)), "tgz\n");
  runGit(["-C", work, "add", "."]);
  runGit(["-C", work, "commit", "-m", "release"]);
  runGit(["-C", work, "remote", "add", "origin", bare]);
  runGit(["-C", work, "push", "-u", "origin", UPDATE_GIT_BRANCH]);
  return `file://${bare}`;
});

/** A fresh temp appRoot + baseDir pair. */
const makeSandbox = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const appRoot = yield* fs.makeTempDirectory({ prefix: "au-engine-app-" });
  const baseDir = yield* fs.makeTempDirectory({ prefix: "au-engine-base-" });
  return { appRoot, baseDir };
});

const freshFixture = (tarball: Uint8Array): FixtureState => ({
  base: "",
  version: NEWER_VERSION,
  sha: sha256Hex(tarball),
  tarball,
  manifestStatus: 200,
  manifestDelayMs: 0,
  tarballDelayMs: 0,
  tarballStall: false,
  requests: [],
});

it.layer(NodeServices.layer)("updateEngineLive", (it) => {
  it.effect("boot fires NO check — zero requests until the schedule is due", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              // Building the engine runs the whole boot path (journal reconcile, facts, scheduler
              // fork). NO boot check exists — the scheduler only ticks when the schedule is due
              // (a future working-hour), so the fixture server sees zero requests at boot.
              const boot = yield* engine.state.pipe(Effect.orDie);
              assert.strictEqual(boot.status.phase, "never-checked");
              assert.strictEqual(state.requests.length, 0);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect(
    "checkNow finds a newer release — available + history + persisted across a reboot",
    () =>
      Effect.gen(function* () {
        const { appRoot, baseDir } = yield* makeSandbox;
        const tarball = yield* buildTarball;
        const state = freshFixture(tarball);
        yield* withServer(state, (url) =>
          withEnv(
            {
              RU_CODE_APP_ROOT: appRoot,
              RU_CODE_UPDATE_WEB_URL: url,
              RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            },
            Effect.gen(function* () {
              const found = yield* Effect.scoped(
                Effect.gen(function* () {
                  const engine = yield* UpdateEngine;
                  yield* engine.checkNow.pipe(Effect.orDie);
                  return yield* settledCheck(engine);
                }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
              );
              assert.strictEqual(found.status.phase, "available");
              if (found.status.phase === "available") {
                assert.strictEqual(found.status.release.version, NEWER_VERSION);
              }
              // A round records EVERY source it reached, in [git, web] order, so the web entry's
              // POSITION depends on whether a git link is baked into this build. Assert on the entry
              // itself: what matters is that the successful web check is journalled as an update.
              assert.isTrue(found.history.length >= 1);
              const webEntry = found.history.find((entry) => entry.source === "web");
              assert.strictEqual(webEntry?.result, "update");
              assert.isTrue(state.requests.some((r) => r.startsWith("/manifest.json")));

              // Reboot a FRESH engine over the SAME baseDir — persistence drives the hero with no network.
              const requestsBefore = state.requests.length;
              const rebooted = yield* Effect.scoped(
                Effect.gen(function* () {
                  const engine = yield* UpdateEngine;
                  return yield* engine.state.pipe(Effect.orDie);
                }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
              );
              assert.strictEqual(rebooted.status.phase, "available");
              if (rebooted.status.phase === "available") {
                assert.strictEqual(rebooted.status.release.version, NEWER_VERSION);
              }
              // The reboot performed NO network check (persisted-only hero).
              assert.strictEqual(state.requests.length, requestsBefore);
            }),
          ),
        );
      }),
  );

  it.effect("checkNow with 404 — answered fail recorded, source NOT paused", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.manifestStatus = 404;
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              const settled = yield* settledCheck(engine);
              assert.strictEqual(settled.web.lastResult?.outcome, "fail");
              if (settled.web.lastResult?.outcome === "fail") {
                assert.strictEqual(settled.web.lastResult.code, "http-404");
                assert.strictEqual(settled.web.lastResult.class, "answered");
              }
              assert.strictEqual(settled.web.paused, false);
              assert.strictEqual(settled.web.authFails, 0);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect("401 twice pauses the source; the next checkNow makes zero traffic", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.manifestStatus = 401;
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              const first = yield* settledCheck(engine);
              assert.strictEqual(first.web.authFails, 1);
              assert.strictEqual(first.web.paused, false);
              yield* engine.checkNow.pipe(Effect.orDie);
              const second = yield* settledCheck(engine);
              assert.strictEqual(second.web.authFails, 2);
              assert.strictEqual(second.web.paused, true);
              const requestsAfterPause = state.requests.length;
              yield* engine.checkNow.pipe(Effect.orDie);
              const third = yield* settledCheck(engine);
              assert.strictEqual(third.web.paused, true);
              // A paused source is probed ZERO times by the scheduled/manual tick.
              assert.strictEqual(state.requests.length, requestsAfterPause);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect(
    "install happy path — download, pointer flip, journal started, run reaches restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { appRoot, baseDir } = yield* makeSandbox;
        const tarball = yield* buildTarball;
        const state = freshFixture(tarball);
        yield* withServer(state, (url) =>
          withEnv(
            {
              RU_CODE_APP_ROOT: appRoot,
              RU_CODE_UPDATE_WEB_URL: url,
              RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
              RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
            },
            Effect.scoped(
              Effect.gen(function* () {
                const engine = yield* UpdateEngine;
                yield* engine.checkNow.pipe(Effect.orDie);
                yield* settledCheck(engine);
                yield* engine.install.pipe(Effect.orDie);
                const installed = yield* finishedRun(engine);
                assert.isNotNull(installed.run);
                assert.strictEqual(installed.run?.phase, "restart");
                assert.strictEqual(installed.run?.targetVersion, NEWER_VERSION);
              }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
            ),
          ),
        );
        // The pointer was flipped and the journal recorded a `started` transition.
        const pointer = yield* readPointer(appRoot);
        assert.strictEqual(pointer?.version, NEWER_VERSION);
        assert.strictEqual(pointer?.entry, `versions/${NEWER_VERSION}/${VERSION_ENTRY_FILENAME}`);
        const journal = yield* readJournal(appRoot);
        assert.strictEqual(journal?.outcome, "started");
        assert.strictEqual(journal?.targetVersion, NEWER_VERSION);
        // The verified version tree landed.
        assert.isTrue(
          yield* fs
            .exists(`${appRoot}/versions/${NEWER_VERSION}/${VERSION_ENTRY_FILENAME}`)
            .pipe(Effect.orElseSucceed(() => false)),
        );
      }),
  );

  it.effect(
    "install survives the pressing client vanishing (interrupted caller, run finishes)",
    () =>
      Effect.gen(function* () {
        const { appRoot, baseDir } = yield* makeSandbox;
        const tarball = yield* buildTarball;
        const state = freshFixture(tarball);
        yield* withServer(state, (url) =>
          withEnv(
            {
              RU_CODE_APP_ROOT: appRoot,
              RU_CODE_UPDATE_WEB_URL: url,
              RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
              RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
            },
            Effect.scoped(
              Effect.gen(function* () {
                const engine = yield* UpdateEngine;
                yield* engine.checkNow.pipe(Effect.orDie);
                yield* settledCheck(engine);
                // The "client": presses install, then its fiber dies (WS gone).
                const presser = yield* Effect.forkScoped(engine.install.pipe(Effect.orDie));
                // Wait until the run actually started, then kill the presser.
                let runStarted = false;
                for (let i = 0; i < 200 && !runStarted; i += 1) {
                  const current = yield* engine.state.pipe(Effect.orDie);
                  runStarted = current.run !== null;
                  if (!runStarted) yield* realSleep(25);
                }
                assert.isTrue(runStarted);
                yield* Fiber.interrupt(presser);
                // The SERVER-OWNED run must still finish: pointer flips regardless.
                let flipped = false;
                for (let i = 0; i < 400 && !flipped; i += 1) {
                  const pointer = yield* readPointer(appRoot).pipe(
                    Effect.provide(NodeServices.layer),
                  );
                  flipped = pointer?.version === NEWER_VERSION;
                  if (!flipped) yield* realSleep(25);
                }
                assert.isTrue(flipped);
              }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
            ),
          ),
        );
        const journal = yield* readJournal(appRoot);
        assert.strictEqual(journal?.outcome, "started");
        assert.strictEqual(journal?.targetVersion, NEWER_VERSION);
      }),
  );

  it.effect("install with a sha mismatch — run failed archive-integrity, pointer untouched", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.sha = "0".repeat(64); // advertise a wrong archive hash
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);
              yield* engine.install.pipe(Effect.orDie);
              const failed = yield* finishedRun(engine);
              assert.strictEqual(failed.run?.phase, "failed");
              assert.strictEqual(failed.run?.error?.code, "archive-integrity");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
      // Nothing flipped: no pointer exists.
      const pointer = yield* readPointer(appRoot);
      assert.isNull(pointer);
    }),
  );

  // Two claims in one spec, because separating them would let the first pass while the feature is
  // still unusable: a stalled download must FAIL (visibly, with its own code) and it must give the
  // single apply permit back. Before the budget existed the run sat in `download` forever holding
  // that permit, so every later press silently no-opped on `withPermitsIfAvailable` and the only
  // recovery was restarting the server.
  it.effect("a stalled download fails as download-timeout and frees the apply permit", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.tarballStall = true;
      const tarballRequested = deferredSignal();
      state.onTarballRequest = tarballRequested.fire;

      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);

              const running = yield* Effect.forkChild(engine.install.pipe(Effect.orDie));
              // Order on the server's own event: the budget must be spent on a download that is
              // genuinely in flight, not on one that has not started.
              yield* Effect.promise(() => tarballRequested.promise);
              yield* TestClock.adjust(Duration.millis(UPDATE_DOWNLOAD_TIMEOUT_MS));
              // The press itself answered as soon as the run existed; the verdict lands in state.
              yield* Fiber.join(running);
              const failed = yield* finishedRun(engine);

              assert.strictEqual(failed.run?.phase, "failed");
              assert.strictEqual(failed.run?.error?.code, "download-timeout");

              // The permit came back: with the host healthy again the retry runs to completion.
              // A held permit would make this press a silent no-op instead.
              state.tarballStall = false;
              yield* engine.retryRun.pipe(Effect.orDie);
              const retried = yield* finishedRun(engine);
              assert.strictEqual(retried.run?.phase, "restart");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
      // The timed-out attempt left nothing behind; the successful retry is what wrote the pointer.
      const pointer = yield* readPointer(appRoot);
      assert.strictEqual(pointer?.version, NEWER_VERSION);
    }),
  );

  // A download owns minutes, and the scheduler is blocked for all of them, so the version resolved
  // at press time can be stale by the time the bytes land. The run must NOT flip onto a version the
  // release host has already moved past; it must stop while stopping is still free and re-offer the
  // new one — with the NEW changelog, which is why the round is recorded rather than discarded.
  it.effect(
    "a newer release published mid-download aborts the flip and re-offers the new one",
    () =>
      Effect.gen(function* () {
        const { appRoot, baseDir } = yield* makeSandbox;
        const tarball = yield* buildTarball;
        const state = freshFixture(tarball);
        // The manifest flips to an even newer version at the moment the tarball is handed over — i.e.
        // exactly the race: resolved 999.0.0, downloaded 999.0.0, and 999.1.0 exists by the time it
        // is on disk.
        const SUPERSEDING_VERSION = "999.1.0";
        state.onTarballRequest = () => {
          state.version = SUPERSEDING_VERSION;
        };

        yield* withServer(state, (url) =>
          withEnv(
            {
              RU_CODE_APP_ROOT: appRoot,
              RU_CODE_UPDATE_WEB_URL: url,
              RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
              RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
            },
            Effect.scoped(
              Effect.gen(function* () {
                const engine = yield* UpdateEngine;
                yield* engine.checkNow.pipe(Effect.orDie);
                yield* settledCheck(engine);
                yield* engine.install.pipe(Effect.orDie);
                const aborted = yield* finishedRun(engine);

                assert.strictEqual(aborted.run?.phase, "failed");
                assert.strictEqual(aborted.run?.error?.code, "superseded");
                // The re-offer: the hero now points at the version that appeared, so «Повторить»
                // installs THAT one and «Что нового» shows its notes.
                assert.strictEqual(aborted.status.phase, "available");
                assert.strictEqual(
                  aborted.status.phase === "available" ? aborted.status.release.version : null,
                  SUPERSEDING_VERSION,
                );
                // …and it is announced rather than inheriting the old release's quiet stamp.
                assert.strictEqual(aborted.notified.release, null);
              }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
            ),
          ),
        );

        // Nothing was applied, and the payload that will never boot did not stay behind.
        assert.isNull(yield* readPointer(appRoot));
        assert.isNull(yield* readJournal(appRoot));
      }),
  );

  // The other half of the rule: the check is ADVISORY. A release host that disappears mid-download
  // must not cost the user an install whose bytes already passed every integrity gate.
  it.effect("a source that stops answering mid-download does NOT abort the flip", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.onTarballRequest = () => {
        state.manifestStatus = 503; // the host goes down the instant the tarball is served
      };

      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);
              yield* engine.install.pipe(Effect.orDie);
              const done = yield* finishedRun(engine);
              assert.strictEqual(done.run?.phase, "restart");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
      assert.strictEqual((yield* readPointer(appRoot))?.version, NEWER_VERSION);
    }),
  );

  it.effect(
    "double-press — two concurrent installs download the archive exactly once (applyLock)",
    () =>
      Effect.gen(function* () {
        const { appRoot, baseDir } = yield* makeSandbox;
        const tarball = yield* buildTarball;
        const state = freshFixture(tarball);
        state.tarballDelayMs = 200; // hold the first run's download open so the second press overlaps it
        yield* withServer(state, (url) =>
          withEnv(
            {
              RU_CODE_APP_ROOT: appRoot,
              RU_CODE_UPDATE_WEB_URL: url,
              RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
              RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
            },
            Effect.scoped(
              Effect.gen(function* () {
                const engine = yield* UpdateEngine;
                yield* engine.checkNow.pipe(Effect.orDie);
                yield* settledCheck(engine);
                // Both presses race for the applyLock; the loser try-acquires None and no-ops.
                // Neither may error.
                yield* Effect.all([engine.install, engine.install], {
                  concurrency: "unbounded",
                }).pipe(Effect.orDie);
                // Exactly ONE run happened, and it ran to completion.
                const settled = yield* finishedRun(engine);
                assert.strictEqual(settled.run?.phase, "restart");
                // The lock let exactly ONE run download the tarball — the other never touched the
                // network. With both presses answering as soon as their run exists, this download
                // count IS the observation of the lock: a second run would have fetched again.
                const downloads = state.requests.filter((r) =>
                  r.startsWith(`/${releaseTarballName(NEWER_VERSION)}`),
                ).length;
                assert.strictEqual(downloads, 1);
              }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
            ),
          ),
        );
      }),
  );

  // The lie the live repro caught: with a known release in state and the host since gone, the
  // press re-resolved, found NOBODY answering, and reported «нечего устанавливать — новее версии
  // нет». Two different truths need two different codes, and only one of them is actionable by
  // re-checking. `raw` stays null throughout: a refusal carries evidence or nothing, never prose.
  it.effect(
    "a press with NO source answering refuses with sources-unreachable, not no-update",
    () =>
      Effect.gen(function* () {
        const { appRoot, baseDir } = yield* makeSandbox;
        const tarball = yield* buildTarball;
        const state = freshFixture(tarball);
        yield* withServer(state, (url) =>
          withEnv(
            {
              RU_CODE_APP_ROOT: appRoot,
              RU_CODE_UPDATE_WEB_URL: url,
              RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
              RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
            },
            Effect.scoped(
              Effect.gen(function* () {
                const engine = yield* UpdateEngine;
                // A release IS known…
                yield* engine.checkNow.pipe(Effect.orDie);
                const checked = yield* settledCheck(engine);
                assert.strictEqual(checked.status.phase, "available");
                // …and then the source stops answering (500 on the manifest = an answered failure
                // that yields no manifest, so the round produces no OK source at all).
                state.manifestStatus = 500;
                const pressed = yield* engine.install.pipe(Effect.result);
                assert.isTrue(pressed._tag === "Failure");
                const after = yield* engine.state;
                assert.strictEqual(after.pressRefusal?.code, "sources-unreachable");
                assert.isNull(after.pressRefusal?.raw);
                // The known release is KEPT — a dead host must not erase a real release.
                assert.strictEqual(after.status.phase, "available");
              }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
            ),
          ),
        );
      }),
  );

  // A failed run is terminal, not "in flight": it must not lock the user out of the one action
  // that can move a stale hero on. The settled check also retires the dead run.
  // The two RPCs answer as soon as their work is UNDER WAY. This is the whole point of the change:
  // holding the request open for a full round tripped the app's generic slow-request monitor and put
  // an orange «Некоторые запросы выполняются медленно» banner over a check (and over every install)
  // that was working exactly as designed. What the reply must still carry is proof that the work
  // started — otherwise the client cannot tell a press from a no-op.
  it.effect("checkNow replies while the round is still running", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              const replied = yield* engine.checkNow.pipe(Effect.orDie);
              // The reply says "started", not "finished" — carried by the `checking` flag, which
              // is what the hero-status phase used to be abused for.
              assert.strictEqual(replied.checking, true);
              // …and the round it started still settles on its own, through the stream.
              const settled = yield* settledCheck(engine);
              assert.strictEqual(settled.status.phase, "available");
              assert.strictEqual(settled.web.probing, false);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect("install replies as soon as the run exists, not when it finishes", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.tarballDelayMs = 400; // hold the download open across the reply
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);

              const replied = yield* engine.install.pipe(Effect.orDie);
              // The run EXISTS and is still downloading — the press is answered, the work is not.
              assert.isNotNull(replied.run);
              assert.strictEqual(replied.run?.phase, "download");
              assert.strictEqual(replied.run?.targetVersion, NEWER_VERSION);
              // The server-owned run finishes on its own afterwards.
              const finished = yield* finishedRun(engine);
              assert.strictEqual(finished.run?.phase, "restart");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
      assert.strictEqual((yield* readPointer(appRoot))?.version, NEWER_VERSION);
    }),
  );

  // A card that says «проверяю…» must mean a request to THAT source is in flight. The round is
  // sequential and stops at the first OK, so marking every source it might reach made the card
  // describe the round's intent instead of its work: git finishes, git keeps spinning, and a web
  // card spins for a source the round may never reach at all.
  it.effect("only the source the round has actually reached says «проверяю…»", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.manifestDelayMs = 400; // hold the web leg open long enough to look at it
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              // git is offline and fails first, so this window belongs to the WEB request only.
              const inFlight = yield* awaitState(
                engine,
                "the web leg in flight",
                (current) => current.web.probing,
              );
              // The finished git leg is no longer claiming to work.
              assert.strictEqual(inFlight.git.probing, false);

              const settled = yield* settledCheck(engine);
              assert.strictEqual(settled.web.probing, false);
              assert.strictEqual(settled.git.probing, false);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  // AU-06 at the wiring level: the wizard fires `generateSshKey` on ENTERING the generate step,
  // before any test and before any save. Aimed at the live path it destroyed a working key on the
  // way in — and `credStore` still held the old fingerprint, so every scheduled check afterwards
  // authenticated with a key the host had never seen. HOME is redirected so this can only ever
  // touch a temp dir, never the developer's own ~/.ssh.
  it.effect("generating a key leaves the key in use untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (!sshKeygenAvailable) return;
      const { appRoot, baseDir } = yield* makeSandbox;
      const home = yield* fs.makeTempDirectory({ prefix: "au-engine-home-" });
      const liveKey = path.join(home, ".ssh", "ru_code_update_ed25519");
      yield* fs.makeDirectory(path.join(home, ".ssh"), { recursive: true });
      yield* fs.writeFileString(liveKey, "THE KEY IN USE\n");

      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            HOME: home,
            USERPROFILE: home,
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              const generated = yield* engine.generateSshKey.pipe(Effect.orDie);

              // The new key exists, and it is NOT the one being used.
              assert.strictEqual(generated.fingerprint.startsWith("SHA256:"), true);
              assert.notStrictEqual(generated.path, liveKey);
              assert.strictEqual(generated.path, `${liveKey}.new`);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );

      // The key that was in use is byte-identical. Abandoning the wizard here costs nothing.
      assert.strictEqual(yield* fs.readFileString(liveKey), "THE KEY IN USE\n");
    }),
  );

  // ── who may run next to whom ────────────────────────────────────────────────
  // Every one of these is a SERVER rule. Two of them already were; the third (probe during a run)
  // was enforced only by disabling the button, so a second tab holding older state could reach the
  // RPC and start a probe next to a running install.
  it.effect("a probe is refused while a run is in flight, not merely hidden", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.tarballDelayMs = 600; // hold the run open so the probe lands inside it
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);
              yield* engine.install.pipe(Effect.orDie);

              const during = yield* engine.probeSource("web").pipe(Effect.orDie);
              // Refused: the card is not put into «проверяю…» and no request was made for it.
              assert.strictEqual(during.web.probing, false);
              assert.isNotNull(during.run);

              yield* finishedRun(engine);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect("two checks at once run ONE round; the second is not a silent no-op", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.manifestDelayMs = 300;
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              const before = state.requests.length;

              yield* Effect.all([engine.checkNow, engine.checkNow], {
                concurrency: "unbounded",
              }).pipe(Effect.orDie);
              const settled = yield* settledCheck(engine);

              // One round: exactly one manifest request, and the round still settles cleanly.
              const manifests = state.requests
                .slice(before)
                .filter((r) => r.startsWith("/manifest.json")).length;
              assert.strictEqual(manifests, 1);
              assert.strictEqual(settled.status.phase, "available");
              assert.strictEqual(settled.web.probing, false);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  // A probe pressed during a check waits for the round instead of racing it — two writers for one
  // card meant the loser's result vanished. It must still ACTUALLY probe afterwards, and must not
  // be left spinning by the round's own force-clear.
  it.effect("a probe during a check is serialized, then really runs", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.manifestDelayMs = 300;
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              const before = state.requests.length;

              const after = yield* engine.probeSource("web").pipe(Effect.orDie);

              // The probe made its own request…
              const manifests = state.requests
                .slice(before)
                .filter((r) => r.startsWith("/manifest.json")).length;
              assert.isAtLeast(manifests, 1);
              // …and nothing is left spinning.
              assert.strictEqual(after.web.probing, false);
              assert.strictEqual(after.git.probing, false);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  // ── the press fact ──────────────────────────────────────────────────────────
  // The client used to disable the button on the CLICK and needed a 30 s watchdog in case the
  // release never came. The server now publishes the press before it starts resolving and clears it
  // with a finalizer, so the button follows a fact — and these are the exits that fact must survive.
  it.effect("a REFUSED press clears pressInFlight", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              // Nothing has been checked, so the press is refused with `no-update`.
              const pressed = yield* engine.install.pipe(Effect.result);
              assert.strictEqual(pressed._tag, "Failure");

              const after = yield* awaitState(
                engine,
                "the press to settle",
                (current) => current.pressInFlight !== true,
              );
              assert.notStrictEqual(after.pressInFlight, true);
              assert.strictEqual(after.pressRefusal?.code, "no-update");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect("a press that starts a run clears pressInFlight when the run finishes", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);
              yield* engine.install.pipe(Effect.orDie);
              yield* finishedRun(engine);

              const after = yield* awaitState(
                engine,
                "the press to settle",
                (current) => current.pressInFlight !== true,
              );
              assert.notStrictEqual(after.pressInFlight, true);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  // git is FIRST in the round and owns the verdict when it answers (INV-5). With a real repo the
  // engine takes that branch for real — and the other half of the per-source spinner rule becomes
  // observable: the round stops at the first OK, so the web source is never reached at all.
  it.effect("resolves a release from a REAL git repo, and never reaches web", () =>
    Effect.gen(function* () {
      if (!gitAvailable) return;
      const { appRoot, baseDir } = yield* makeSandbox;
      const gitUrl = yield* makeGitReleaseRepo;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: gitUrl,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              const settled = yield* settledCheck(engine);

              // The release came from GIT.
              assert.strictEqual(settled.status.phase, "available");
              assert.strictEqual(
                settled.status.phase === "available" ? settled.status.release.version : null,
                NEWER_VERSION,
              );
              assert.strictEqual(settled.git.lastResult?.outcome, "ok");
              // The round stopped at the first OK: web was never asked, so it has no result…
              assert.strictEqual(settled.web.lastResult, null);
              // …and never claimed to be checking.
              assert.strictEqual(settled.web.probing, false);
              assert.strictEqual(state.requests.length, 0);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect("checkNow works after a failed run and clears it", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      const goodSha = state.sha;
      state.sha = "0".repeat(64);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);
              yield* engine.install.pipe(Effect.orDie);
              const failed = yield* finishedRun(engine);
              assert.strictEqual(failed.run?.phase, "failed");
              state.sha = goodSha;
              yield* engine.checkNow.pipe(Effect.orDie);
              const rechecked = yield* settledCheck(engine);
              assert.isNull(rechecked.run);
              assert.strictEqual(rechecked.status.phase, "available");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  it.effect("retryRun after a failed run re-resolves and completes", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      const goodSha = state.sha;
      state.sha = "0".repeat(64); // first attempt fails on the archive hash
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);
              yield* engine.install.pipe(Effect.orDie);
              const failed = yield* finishedRun(engine);
              assert.strictEqual(failed.run?.phase, "failed");
              // Fix the manifest so the fresh re-resolve inside retryRun downloads a matching archive.
              state.sha = goodSha;
              yield* engine.retryRun.pipe(Effect.orDie);
              const retried = yield* finishedRun(engine);
              assert.strictEqual(retried.run?.phase, "restart");
              assert.strictEqual(retried.run?.targetVersion, NEWER_VERSION);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
      const pointer = yield* readPointer(appRoot);
      assert.strictEqual(pointer?.version, NEWER_VERSION);
    }),
  );

  // ── round 4 ────────────────────────────────────────────────────────────────
  // The press-in-flight fact has exactly ONE writer: the fiber holding the apply permit. A second
  // press that finds the permit busy must not touch it — it used to run the clearing finalizer
  // without ever running the work, so it announced "the press is over" while the FIRST press was
  // still resolving its sources, re-opening the exact window the flag exists to cover (and a
  // second press is reachable: the release toast calls install() with no busy gate).
  it.effect("a second press cannot clear the first press's in-flight fact", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      state.tarballDelayMs = 600; // hold press A open across press B
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
            RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              yield* settledCheck(engine);

              yield* engine.install.pipe(Effect.orDie);
              const during = yield* engine.state.pipe(Effect.orDie);
              assert.strictEqual(during.pressInFlight, true);

              // Press B: the apply permit is taken, so nothing runs — and nothing is announced.
              yield* engine.install.pipe(Effect.orDie);
              const after = yield* engine.state.pipe(Effect.orDie);
              assert.strictEqual(after.pressInFlight, true, "press B cleared press A's fact");
              assert.isNotNull(after.run);

              // …and the fact still clears itself when the real press settles.
              yield* finishedRun(engine);
              const settled = yield* awaitState(
                engine,
                "the press fact cleared",
                (s) => s.pressInFlight !== true,
              );
              assert.strictEqual(settled.pressInFlight, false);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  // A press runs a REAL source round, and its outcomes used to be thrown away: a source that
  // answered 401 to ten presses stayed at authFails 0, no history row was written, and the user
  // waited through a full budget for a refusal that left no trace anywhere. One state machine —
  // a press's round counts exactly like a scheduled one.
  it.effect("a refused press records its round: history + the auth counter", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              const offered = yield* settledCheck(engine);
              assert.strictEqual(offered.status.phase, "available");
              const historyBefore = offered.history.length;

              // The release host starts rejecting the credential between the check and the press.
              state.manifestStatus = 401;
              const first = yield* engine.install.pipe(Effect.flip);
              assert.strictEqual(first.code, "sources-unreachable");

              const afterFirst = yield* engine.state.pipe(Effect.orDie);
              assert.strictEqual(afterFirst.web.authFails, 1);
              assert.isAbove(afterFirst.history.length, historyBefore);
              assert.strictEqual(afterFirst.web.paused, false);

              // The SECOND answered rejection pauses the source — the same rule a scheduled round
              // applies, now reachable from the button the user is actually pressing.
              yield* engine.install.pipe(Effect.flip);
              const afterSecond = yield* engine.state.pipe(Effect.orDie);
              assert.strictEqual(afterSecond.web.authFails, 2);
              assert.strictEqual(afterSecond.web.paused, true);
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );

  // A background round must not blank what the hero already knows — through the ENGINE, not just
  // the transition: the release, its «Позже» stamp and the release notes all live in the hero
  // status, and a check used to replace it wholesale for the duration of the round.
  it.effect("a check in flight leaves the advertised release on the hero", () =>
    Effect.gen(function* () {
      const { appRoot, baseDir } = yield* makeSandbox;
      const tarball = yield* buildTarball;
      const state = freshFixture(tarball);
      yield* withServer(state, (url) =>
        withEnv(
          {
            RU_CODE_APP_ROOT: appRoot,
            RU_CODE_UPDATE_WEB_URL: url,
            RU_CODE_UPDATE_GIT_URL: OFFLINE_GIT_URL,
          },
          Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* UpdateEngine;
              yield* engine.checkNow.pipe(Effect.orDie);
              const offered = yield* settledCheck(engine);
              assert.strictEqual(offered.status.phase, "available");

              // A second round, held open at the manifest so the mid-flight state is observable.
              state.manifestDelayMs = 400;
              const midFlight = yield* engine.checkNow.pipe(Effect.orDie);
              assert.strictEqual(midFlight.checking, true);
              assert.strictEqual(midFlight.status.phase, "available");

              const settled = yield* settledCheck(engine);
              assert.strictEqual(settled.status.phase, "available");
            }).pipe(Effect.provide(Layer.fresh(engineLayer(baseDir)))),
          ),
        ),
      );
    }),
  );
});
