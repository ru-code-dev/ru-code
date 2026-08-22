// ru-code: HTTPS git auth against a REAL authenticating git server.
//
// `httpsAuth.ts` embeds the credential in the URL (`credentialedGitUrl`) — the transport every git
// version supports, replacing the GIT_CONFIG_* env config that git < 2.31 silently ignored. Every
// other test of it pins the URL's SHAPE — which proves nothing about whether git accepts it. A
// wrong encoding, a mangled userinfo, or a server that rejects the Basic header git derives would
// pass every gate and fail on a user's machine with exactly the symptom the change set out to
// remove.
//
// So this drives the real thing: `git http-backend` behind Basic auth, over plain HTTP on loopback.
// Three cases, because they are three different answers the user gets:
//   · the right credential (with `:` and shell punctuation in the password — the percent-encoding
//     proof) → the release resolves;
//   · the wrong credential → an ANSWERED failure, actionable ("check the sign-in");
//   · no credential at all → git asks for a username and the prompt ceiling refuses, which the
//     classifier must also read as answered — before this round it was silent, filed under
//     "indistinguishable from no internet".
// Plus the redaction guarantee: the password never appears in any failure the channel reports.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, describe } from "vite-plus/test";

import { UPDATE_GIT_RELEASE_DIR, releaseTarballName } from "@ru-code/branding";

import * as ProcessRunner from "../../../processRunner.ts";
import {
  fetchGitRelease,
  makeGitStrategyCache,
  probeGit,
} from "../../auto-update/channels/gitChannel.ts";
import { releaseRepoPath } from "../../auto-update/channels/gitStrategy.ts";
import { buildGitEnv } from "../../auto-update/gitAuth/gitEnv.ts";
import { credentialedGitUrl } from "../../auto-update/gitAuth/httpsAuth.ts";

const VERSION = "1.2.3";
const BRANCH = "release-line";
const USER = "release-bot";
const PASSWORD = 's3cret:with-punctuation$`"';
const MANIFEST =
  '{"version":"1.2.3","sha256":"deadbeef","minNode":">=20","sizeBytes":9,"releasedAt":null}';

const runGit = (args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync("git", args, {
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
};

const available = ((): boolean => {
  try {
    runGit(["--version"]);
    // http-backend ships with git but lives outside PATH; git names its own exec path.
    const execPath = NodeChildProcess.execFileSync("git", ["--exec-path"], {
      encoding: "utf8",
    }).trim();
    return NodeFS.existsSync(NodePath.join(execPath, "git-http-backend"));
  } catch {
    return false;
  }
})();

const roots: Array<string> = [];

/** A caller-owned workspace, registered for teardown — `fetchGitRelease` no longer removes it. */
const ownedTmp = (prefix: string): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** A bare repo carrying a release, served later over http. */
function makeRepo(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-au-httpauth-"));
  roots.push(root);
  const bare = NodePath.join(root, "release.git");
  const work = NodePath.join(root, "work");
  runGit(["init", "--bare", "-b", BRANCH, bare]);
  runGit(["init", "-b", BRANCH, work]);
  runGit(["-C", work, "config", "user.email", "ci@example.com"]);
  runGit(["-C", work, "config", "user.name", "CI"]);
  runGit(["-C", work, "config", "commit.gpgsign", "false"]);
  runGit(["-C", bare, "config", "http.receivepack", "true"]);
  for (const [name, body] of [
    [releaseRepoPath(UPDATE_GIT_RELEASE_DIR, "manifest.json"), MANIFEST],
    [releaseRepoPath(UPDATE_GIT_RELEASE_DIR, releaseTarballName(VERSION)), "tarball!\n"],
  ] as const) {
    const target = NodePath.join(work, name);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, body);
  }
  runGit(["-C", work, "add", "."]);
  runGit(["-C", work, "commit", "-m", "release"]);
  runGit(["-C", work, "remote", "add", "origin", bare]);
  runGit(["-C", work, "push", "-u", "origin", BRANCH]);
  return bare;
}

/**
 * `git http-backend` behind Basic auth. Any request without a correct `Authorization` gets a 401
 * with a `WWW-Authenticate` challenge — which is precisely what makes git go looking for a
 * credential, and therefore what the whole mechanism has to satisfy.
 */
function serveRepo(bare: string): Promise<{ url: string; close: () => Promise<void> }> {
  const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64")}`;
  const execPath = NodeChildProcess.execFileSync("git", ["--exec-path"], {
    encoding: "utf8",
  }).trim();

  const server = NodeHttp.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="release"');
      res.end("unauthorized");
      return;
    }
    const child = NodeChildProcess.spawn(NodePath.join(execPath, "git-http-backend"), [], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GIT_PROJECT_ROOT: NodePath.dirname(bare),
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: (req.url ?? "/").split("?")[0] ?? "/",
        QUERY_STRING: (req.url ?? "").split("?")[1] ?? "",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: USER,
      },
    });
    req.pipe(child.stdin);
    // http-backend writes CGI headers first, then the body — parse the split and replay it.
    const chunks: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdout.on("end", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
      const head = split === -1 ? "" : out.subarray(0, split).toString("utf8");
      const body = split === -1 ? out : out.subarray(split + 4);
      for (const line of head.split("\r\n")) {
        const at = line.indexOf(":");
        if (at === -1) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status") res.statusCode = Number.parseInt(value, 10) || 200;
        else res.setHeader(name, value);
      }
      res.end(body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${String(port)}/${NodePath.basename(bare)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const layer = Layer.provideMerge(ProcessRunner.layer, NodeServices.layer);

if (!available) {
  describe.skip("git https auth (git http-backend unavailable)", () => {
    it.skip("git https auth specs require git-http-backend", () => undefined);
  });
} else {
  it.layer(layer)("git https auth against a real authenticating server", (it) => {
    // The credential rides the URL; the env carries only the floor (buildGitEnv adds it inside the
    // channel — this bare env mirrors what withGitAuth hands over in production: nothing).
    const urlFor = (credentials: { username: string; password: string } | null, repoUrl: string) =>
      credentials === null ? repoUrl : credentialedGitUrl({ repoUrl, credentials });
    const bareEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

    it.effect("the right credential authenticates — the release resolves", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.ProcessRunner;
        const served = yield* Effect.promise(() => serveRepo(makeRepo()));
        try {
          // PASSWORD carries `:` `$` backtick and a quote — the percent-encoding is what a REAL
          // server accepting this proves.
          const repoUrl = urlFor({ username: USER, password: PASSWORD }, served.url);
          const probe = yield* probeGit({
            repoUrl,
            env: bareEnv,
            spawner,
            branch: BRANCH,
          });
          assert.strictEqual(probe.ok, true, `probe failed: ${probe.ok ? "" : probe.failure.raw}`);

          const release = yield* fetchGitRelease({
            repoUrl,
            env: bareEnv,
            spawner,
            tmpDir: ownedTmp("ru-au-httpauth-fetch-"),
            strategyCache: makeGitStrategyCache(),
            branch: BRANCH,
          });
          assert.strictEqual(release.manifest.version, VERSION);
        } finally {
          yield* Effect.promise(() => served.close());
        }
      }),
    );

    it.effect("the WRONG credential is an answered failure, not a silent one", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.ProcessRunner;
        const served = yield* Effect.promise(() => serveRepo(makeRepo()));
        try {
          const probe = yield* probeGit({
            repoUrl: urlFor({ username: USER, password: "wrong" }, served.url),
            env: bareEnv,
            spawner,
            branch: BRANCH,
          });

          assert.strictEqual(probe.ok, false);
          if (!probe.ok) {
            // Actionable — the user can fix a password. A transport class here would be silent.
            assert.strictEqual(probe.failure.class, "answered");
            assert.strictEqual(probe.failure.code, "git-access-denied");
            // …and it really is the 401 talking, not a missing branch or a broken fixture.
            assert.match(
              String(probe.failure.raw),
              /askpass|authentication|401|could not read/i,
              String(probe.failure.raw),
            );
          }
        } finally {
          yield* Effect.promise(() => served.close());
        }
      }),
    );

    it.effect("NO credential is answered too — the case that used to be silent", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.ProcessRunner;
        const served = yield* Effect.promise(() => serveRepo(makeRepo()));
        try {
          const probe = yield* probeGit({
            repoUrl: urlFor(null, served.url),
            env: bareEnv,
            spawner,
            branch: BRANCH,
          });

          assert.strictEqual(probe.ok, false);
          if (!probe.ok) {
            assert.strictEqual(probe.failure.class, "answered");
            assert.strictEqual(probe.failure.code, "git-access-denied");
            assert.match(
              String(probe.failure.raw),
              /askpass|authentication|401|could not read/i,
              String(probe.failure.raw),
            );
          }
        } finally {
          yield* Effect.promise(() => served.close());
        }
      }),
    );

    // The secret's ONE exposure is the URL handed to git; every failure the channel reports must
    // come back with it masked. This is the property that lets the credentialed URL exist at all.
    it.effect("a failure never echoes the credential — the URL comes back redacted", () =>
      Effect.gen(function* () {
        const spawner = yield* ProcessRunner.ProcessRunner;
        const served = yield* Effect.promise(() => serveRepo(makeRepo()));
        try {
          const probe = yield* probeGit({
            repoUrl: urlFor({ username: USER, password: "wrong-password-7" }, served.url),
            env: bareEnv,
            spawner,
            branch: BRANCH,
          });

          assert.strictEqual(probe.ok, false);
          if (!probe.ok) {
            const raw = String(probe.failure.raw);
            assert.notInclude(raw, "wrong-password-7");
            assert.notInclude(raw, USER);
            assert.include(raw, "***");
          }
        } finally {
          yield* Effect.promise(() => served.close());
        }
      }),
    );

    // The floor survives composition: buildGitEnv over a credentialed https URL still pins every
    // prompt shut, so the one attempt the URL carries is the only attempt there is.
    it.effect("the composed env keeps git non-interactive for a credentialed URL", () =>
      Effect.sync(() => {
        const env = buildGitEnv({
          repoUrl: urlFor({ username: USER, password: PASSWORD }, "https://host/x.git"),
          authEnv: {},
          baseEnv: {},
          disableSsl: false,
        });
        assert.strictEqual(env["GIT_TERMINAL_PROMPT"], "0");
        assert.strictEqual(env["GIT_ASKPASS"], "false");
      }),
    );
  });
}
