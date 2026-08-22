// ru-code: the download half of the install run against a REAL local http server + real `tar`
// archives built per test. Covers: the happy path (download → sha256 → extract → per-file
// checksums → versions/<v> landed + tmp wiped + basic-auth header sent), archive sha mismatch,
// a tampered extracted file (checksums catch it), a payload missing cli.js, a 404, and that every
// failure leaves versions/ without the incoming dir and the workspace clean.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { UPDATE_DOWNLOAD_TIMEOUT_MS } from "@ru-code/branding";

import { CHECKSUMS_FILENAME } from "../../auto-update/apply/checksums.ts";
import { deferredSignal } from "./deferredSignal.ts";
import {
  fetchVersionToDisk,
  VERSION_ENTRY_FILENAME,
} from "../../auto-update/apply/fetchVersion.ts";
import { UPDATES_TMP_RELATIVE, VERSIONS_DIRNAME } from "../../auto-update/apply/gc.ts";

const sha256Hex = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Build a SHIPPING-SHAPED release bundle (+ optional tamper), tar it, return the bytes.
 * The archive root carries the wrapper decoy `cli.js` + `current.json`, exactly like a real
 * bundle — so these tests prove the fetcher takes `versions/<v>/` and never the root.
 */
const buildTarball = (params: {
  readonly includeEntry: boolean;
  readonly tamperAfterChecksums: boolean;
  readonly version?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const version = params.version ?? "1.4.2";
    const workDir = yield* fs.makeTempDirectory({ prefix: "fetch-fixture-" });
    const bundle = path.join(workDir, "bundle");
    const payload = path.join(bundle, "versions", version);
    yield* fs.makeDirectory(payload, { recursive: true });
    yield* fs.writeFileString(
      path.join(bundle, VERSION_ENTRY_FILENAME),
      "// FROZEN launcher decoy — must never be landed as a version\n",
    );
    yield* fs.writeFileString(
      path.join(bundle, "current.json"),
      JSON.stringify({ schema: 1, version, entry: `versions/${version}/cli.js` }),
    );
    if (params.includeEntry) {
      yield* fs.writeFileString(path.join(payload, VERSION_ENTRY_FILENAME), "console.log('app')\n");
    }
    yield* fs.writeFileString(path.join(payload, "lib.js"), "export const x = 1\n");
    // Per-file checksums manifest, exactly like prepare-release writes it.
    const files: Record<string, string> = {};
    for (const name of params.includeEntry ? [VERSION_ENTRY_FILENAME, "lib.js"] : ["lib.js"]) {
      const bytes = yield* fs.readFile(path.join(payload, name));
      files[name] = sha256Hex(bytes);
    }
    yield* fs.writeFileString(
      path.join(payload, CHECKSUMS_FILENAME),
      JSON.stringify({ algo: "sha256", files }),
    );
    if (params.tamperAfterChecksums) {
      yield* fs.writeFileString(path.join(payload, "lib.js"), "export const x = 2\n");
    }
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

/** One-shot local http server for the tarball; records the Authorization header it saw. */
const withServer = <A, E, R>(
  body: Uint8Array | null,
  run: (url: string, seenAuth: { value: string | null }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const seenAuth: { value: string | null } = { value: null };
    const server = NodeHttp.createServer((request, response) => {
      seenAuth.value = request.headers.authorization ?? null;
      if (body === null) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.setHeader("content-length", body.byteLength);
      response.end(Buffer.from(body));
    });
    yield* Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const result = yield* run(`http://127.0.0.1:${String(port)}/release.tgz`, seenAuth).pipe(
      Effect.onExit(() => Effect.sync(() => server.close())),
    );
    return result;
  });

const workspaceClean = (appRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return !(yield* fs
      .exists(path.join(appRoot, UPDATES_TMP_RELATIVE))
      .pipe(Effect.orElseSucceed(() => true)));
  });

it.layer(NodeServices.layer)("fetchVersionToDisk", (it) => {
  it.effect("happy path: verified tree lands at versions/<v>, basic auth sent, tmp wiped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-app-" });
      const tarball = yield* buildTarball({ includeEntry: true, tamperAfterChecksums: false });
      const progress: Array<number> = [];
      const fetched = yield* withServer(tarball, (url, seenAuth) =>
        fetchVersionToDisk({
          appRoot,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: { username: "u", password: "p" } },
          expectedSha256: sha256Hex(tarball),
          onProgress: (pct) => progress.push(pct),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              assert.strictEqual(seenAuth.value, `Basic ${Buffer.from("u:p").toString("base64")}`);
            }),
          ),
        ),
      );
      assert.strictEqual(fetched.entryRelative, `versions/1.4.2/${VERSION_ENTRY_FILENAME}`);
      const entryText = yield* fs.readFileString(
        path.join(appRoot, VERSIONS_DIRNAME, "1.4.2", VERSION_ENTRY_FILENAME),
      );
      assert.include(entryText, "app");
      // The landed tree is the VERSION payload, not the bundle root: the root's decoy wrapper and
      // its pointer must not have come along.
      assert.notInclude(entryText, "FROZEN launcher decoy");
      assert.isFalse(
        yield* fs
          .exists(path.join(appRoot, VERSIONS_DIRNAME, "1.4.2", "current.json"))
          .pipe(Effect.orElseSucceed(() => true)),
      );
      assert.isTrue(progress.length > 0 && progress[progress.length - 1] === 100);
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  // The pointer names a directory; if the archive does not carry exactly that version the update
  // must refuse rather than land something under the wrong name.
  it.effect("archive carrying a different version → FetchStructureError", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-wrongver-" });
      const tarball = yield* buildTarball({
        includeEntry: true,
        tamperAfterChecksums: false,
        version: "1.4.2",
      });
      const result = yield* withServer(tarball, (url) =>
        fetchVersionToDisk({
          appRoot,
          version: "9.9.9",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: sha256Hex(tarball),
        }).pipe(Effect.flip),
      );
      assert.strictEqual(result._tag, "FetchStructureError");
      assert.include(String(result.detail), "versions/9.9.9");
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  it.effect("archive sha mismatch → FetchArchiveIntegrityError, nothing landed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-sha-" });
      const tarball = yield* buildTarball({ includeEntry: true, tamperAfterChecksums: false });
      const result = yield* withServer(tarball, (url) =>
        fetchVersionToDisk({
          appRoot,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: "0".repeat(64),
        }).pipe(Effect.flip),
      );
      assert.strictEqual(result._tag, "FetchArchiveIntegrityError");
      const versionExists = yield* fs
        .exists(path.join(appRoot, VERSIONS_DIRNAME, "1.4.2"))
        .pipe(Effect.orElseSucceed(() => true));
      assert.isFalse(versionExists);
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  it.effect("tampered extracted file → FetchFileIntegrityError naming the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-tamper-" });
      const tarball = yield* buildTarball({ includeEntry: true, tamperAfterChecksums: true });
      const result = yield* withServer(tarball, (url) =>
        fetchVersionToDisk({
          appRoot,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: sha256Hex(tarball),
        }).pipe(Effect.flip),
      );
      assert.strictEqual(result._tag, "FetchFileIntegrityError");
      assert.include(String(result.detail), "lib.js");
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  it.effect("payload without cli.js → FetchStructureError", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-struct-" });
      const tarball = yield* buildTarball({ includeEntry: false, tamperAfterChecksums: false });
      const result = yield* withServer(tarball, (url) =>
        fetchVersionToDisk({
          appRoot,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: sha256Hex(tarball),
        }).pipe(Effect.flip),
      );
      assert.strictEqual(result._tag, "FetchStructureError");
    }),
  );

  // The extract step is in-process (node-tar) — a corrupt stream must fail as STRUCTURE with the
  // extractor's real message as evidence. The spawn it replaced discarded stderr, so this exact
  // case reached users as a generic sentence with nothing to act on.
  it.effect("bytes that are not a tar stream → FetchStructureError with real evidence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-corrupt-" });
      const garbage = new TextEncoder().encode("this is not a tarball at all — just bytes");
      const result = yield* withServer(garbage, (url) =>
        fetchVersionToDisk({
          appRoot,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: sha256Hex(garbage),
        }).pipe(Effect.flip),
      );
      assert.strictEqual(result._tag, "FetchStructureError");
      if (result._tag === "FetchStructureError") {
        assert.include(String(result.detail), "could not extract");
        // Evidence is the extractor's own message — non-null, unlike the spawn it replaced.
        assert.isNotNull(result.evidence);
      }
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  it.effect("404 → FetchNetworkError with the status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-404-" });
      const result = yield* withServer(null, (url) =>
        fetchVersionToDisk({
          appRoot,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: "0".repeat(64),
        }).pipe(Effect.flip),
      );
      assert.strictEqual(result._tag, "FetchNetworkError");
      if (result._tag === "FetchNetworkError") {
        assert.strictEqual(result.status, 404);
      }
    }),
  );

  // ── the download's time budget ────────────────────────────────────────────────
  //
  // The failure mode this covers emits NOTHING on its own: a peer that completes the handshake,
  // answers with headers, and then stops sending body bytes produces no `error`, no `close` and no
  // `aborted`, and node's http.get has no default timeout. Before UPDATE_DOWNLOAD_TIMEOUT_MS the
  // run sat in `download` forever holding the only apply permit, and a server restart was the only
  // way out. The clock here is the TestClock, so the 3-minute budget costs nothing to assert.

  it.effect("a peer that sends headers and then stalls → FetchTimeoutError, workspace clean", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-stall-" });

      const requestSeen = deferredSignal();
      const socketClosed = deferredSignal();
      const server = NodeHttp.createServer((_request, response) => {
        // Headers + a promised length, then silence — a "healthy" connection with no progress.
        response.setHeader("content-length", 4096);
        response.flushHeaders();
        response.on("close", socketClosed.fire);
        requestSeen.fire();
      });
      yield* Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      const result = yield* Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          fetchVersionToDisk({
            appRoot,
            version: "1.4.2",
            source: {
              kind: "http",
              url: `http://127.0.0.1:${String(port)}/release.tgz`,
              basicAuth: null,
            },
            expectedSha256: "0".repeat(64),
          }).pipe(Effect.flip),
        );
        // Wait on the SERVER's own event, not on a duration: under the TestClock a sleep would not
        // advance, and adjusting before the request is in flight would test nothing.
        yield* Effect.promise(() => requestSeen.promise);
        yield* TestClock.adjust(Duration.millis(UPDATE_DOWNLOAD_TIMEOUT_MS));
        return yield* Fiber.join(running);
      }).pipe(Effect.onExit(() => Effect.sync(() => server.close())));

      assert.strictEqual(result._tag, "FetchTimeoutError");
      // Interrupted, not merely reported: the socket really went away, so nothing keeps streaming
      // into a buffer no one will read.
      yield* Effect.promise(() => socketClosed.promise);
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  // ── G29: the acquisition split ────────────────────────────────────────────────
  //
  // The git channel hands the pipeline a file it already pulled out of the repository. That file
  // must go through EXACTLY the same verification and landing as a download — same sha256 gate,
  // same per-file checksums, same atomic move — or git would be the weaker of the two channels.

  it.effect("file source: lands the identical tree an http download produces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tarball = yield* buildTarball({ includeEntry: true, tamperAfterChecksums: false });

      // Same bytes, two acquisitions.
      const overHttp = yield* fs.makeTempDirectory({ prefix: "fetch-http-" });
      yield* withServer(tarball, (url) =>
        fetchVersionToDisk({
          appRoot: overHttp,
          version: "1.4.2",
          source: { kind: "http", url, basicAuth: null },
          expectedSha256: sha256Hex(tarball),
        }),
      );

      const overFile = yield* fs.makeTempDirectory({ prefix: "fetch-file-" });
      const staged = path.join(
        yield* fs.makeTempDirectory({ prefix: "fetch-stage-" }),
        "release.tgz",
      );
      yield* fs.writeFile(staged, tarball);
      const progress: Array<number> = [];
      const fetched = yield* fetchVersionToDisk({
        appRoot: overFile,
        version: "1.4.2",
        source: { kind: "file", path: staged },
        expectedSha256: sha256Hex(tarball),
        onProgress: (pct) => progress.push(pct),
      });

      assert.strictEqual(fetched.entryRelative, `versions/1.4.2/${VERSION_ENTRY_FILENAME}`);
      const fromHttp = yield* fs.readFile(
        path.join(overHttp, VERSIONS_DIRNAME, "1.4.2", VERSION_ENTRY_FILENAME),
      );
      const fromFile = yield* fs.readFile(
        path.join(overFile, VERSIONS_DIRNAME, "1.4.2", VERSION_ENTRY_FILENAME),
      );
      assert.isTrue(Buffer.from(fromHttp).equals(Buffer.from(fromFile)));
      // Bytes already local ⇒ the ACQUIRE step is done the moment they are readable — but the
      // pipeline is not: sha256, extract and per-file verification are still ahead, and a bar
      // sitting at 100 % through all of them says the opposite of what is happening.
      assert.deepStrictEqual(progress, [99]);
      assert.isTrue(yield* workspaceClean(overFile));
      // The staged archive is the CALLER's to clean up — this module never moves or deletes it.
      assert.isTrue(yield* fs.exists(staged));
    }),
  );

  it.effect("file source: the sha256 gate applies exactly as it does to a download", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-file-sha-" });
      const tarball = yield* buildTarball({ includeEntry: true, tamperAfterChecksums: false });
      const staged = path.join(
        yield* fs.makeTempDirectory({ prefix: "fetch-stage-" }),
        "release.tgz",
      );
      yield* fs.writeFile(staged, tarball);

      const result = yield* fetchVersionToDisk({
        appRoot,
        version: "1.4.2",
        source: { kind: "file", path: staged },
        expectedSha256: "0".repeat(64),
      }).pipe(Effect.flip);
      assert.strictEqual(result._tag, "FetchArchiveIntegrityError");
      assert.isTrue(yield* workspaceClean(appRoot));
    }),
  );

  it.effect("file source: an unreadable archive is a network-class failure naming the path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectory({ prefix: "fetch-file-missing-" });
      const missing = path.join(appRoot, "not-here.tgz");

      const result = yield* fetchVersionToDisk({
        appRoot,
        version: "1.4.2",
        source: { kind: "file", path: missing },
        expectedSha256: "0".repeat(64),
      }).pipe(Effect.flip);
      assert.strictEqual(result._tag, "FetchNetworkError");
      if (result._tag === "FetchNetworkError") {
        assert.strictEqual(result.evidence, missing);
        assert.isNull(result.status);
      }
    }),
  );
});
