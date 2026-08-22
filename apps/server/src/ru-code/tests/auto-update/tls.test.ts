// ru-code: certificate verification for the update path — proved against a REAL https server
// holding a REAL self-signed certificate, not against a mock.
//
// The claim under test is narrow and load-bearing: with DISABLE_SSL the update engine reaches a host
// whose certificate no client can verify, and with verification ON the very same code refuses it.
// Both directions matter — a permissive client that "works" proves nothing unless the strict client
// demonstrably fails on the same server.
//
// The other half of the claim is SCOPE: the permissive setting lives on this layer's agent and on
// the download's own request options, never on `NODE_TLS_REJECT_UNAUTHORIZED`, so nothing else in
// the process is affected. That is asserted here too.
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { DISABLE_SSL } from "@ru-code/branding";

import { fetchVersionToDisk } from "../../auto-update/apply/fetchVersion.ts";
import { fetchWebRelease, probeWeb } from "../../auto-update/channels/webChannel.ts";
import { buildGitEnv } from "../../auto-update/gitAuth/gitEnv.ts";
import { credentialedGitUrl } from "../../auto-update/gitAuth/httpsAuth.ts";
import {
  buildUpdateHttpClientLayer,
  updateHttpAgentOptions,
} from "../../auto-update/updateHttpClient.ts";

const MANIFEST =
  '{"version":"9.9.9","sha256":"deadbeef","minNode":">=20","sizeBytes":10,"releasedAt":null}';

// ── a real self-signed https server ──────────────────────────────────────────────

const opensslAvailable = (): boolean => {
  try {
    NodeChildProcess.execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const createdRoots: Array<string> = [];

/** Generate a throwaway self-signed cert for `localhost`. No CA on this machine can vouch for it. */
const makeSelfSignedCert = (): { readonly key: string; readonly cert: string } => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-au-tls-"));
  createdRoots.push(dir);
  const keyPath = NodePath.join(dir, "key.pem");
  const certPath = NodePath.join(dir, "cert.pem");
  NodeChildProcess.execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return { key: NodeFS.readFileSync(keyPath, "utf8"), cert: NodeFS.readFileSync(certPath, "utf8") };
};

/** Serve `manifest.json` (+ a tiny tarball) over https with the untrusted certificate. */
const withHttpsServer = <A, E, R>(
  body: (baseUrl: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.callback<{ readonly server: NodeHttps.Server; readonly base: string }>((resume) => {
      const { key, cert } = makeSelfSignedCert();
      const server = NodeHttps.createServer({ key, cert }, (req, res) => {
        if ((req.url ?? "").includes("manifest.json")) {
          res.setHeader("content-type", "application/json");
          res.end(MANIFEST);
          return;
        }
        res.statusCode = 404;
        res.end("no");
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(Effect.succeed({ server, base: `https://127.0.0.1:${String(port)}` }));
      });
    }),
    ({ base }) => body(base),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

afterAll(() => {
  for (const dir of createdRoots) NodeFS.rmSync(dir, { recursive: true, force: true });
});

// ── the pure halves (no server needed) ───────────────────────────────────────────

describe("update transport — the TLS switch", () => {
  it("the permissive agent turns off exactly ONE option, and only when asked", () => {
    expect(updateHttpAgentOptions(true)).toEqual({ rejectUnauthorized: false });
    expect(updateHttpAgentOptions(false)).toEqual({});
  });

  it("never reaches for the process-wide escape hatch", () => {
    // The whole point of the scoped agent: other outbound traffic (providers, auth) keeps verifying.
    expect(process.env["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined();
  });

  it("git gets GIT_SSL_NO_VERIFY only with the flag on", () => {
    const on = buildGitEnv({
      repoUrl: "https://git.example.com/rel.git",
      authEnv: {},
      baseEnv: {},
      disableSsl: true,
    });
    const off = buildGitEnv({
      repoUrl: "https://git.example.com/rel.git",
      authEnv: {},
      baseEnv: {},
      disableSsl: false,
    });
    expect(on["GIT_SSL_NO_VERIFY"]).toBe("1");
    expect(off["GIT_SSL_NO_VERIFY"]).toBeUndefined();
  });

  it("the git env floor still guarantees non-interactivity with the flag on", () => {
    const env = buildGitEnv({
      repoUrl: "git@host:team/rel.git",
      authEnv: { GIT_SSH_COMMAND: "ssh -i /tmp/key" },
      baseEnv: { PATH: "/usr/bin" },
      disableSsl: true,
    });
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GCM_INTERACTIVE"]).toBe("never");
    // The caller's own credentials still win over the floor — the flag changed nothing about that.
    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -i /tmp/key");
    expect(env["GIT_SSL_NO_VERIFY"]).toBe("1");
  });

  it("D18: a CREDENTIALED https call inherits the switch — it is a floor, not an override", () => {
    // Every credentialed git call (probe, test-before-save, fetch) goes through buildGitEnv with
    // the credential riding the URL (credentialedGitUrl), so there is no second code path that
    // could miss the switch.
    const withHttpsCreds = buildGitEnv({
      repoUrl: credentialedGitUrl({
        repoUrl: "https://git.example.com/rel.git",
        credentials: { username: "u", password: "p" },
      }),
      authEnv: {},
      baseEnv: {},
      disableSsl: true,
    });
    // The switch reaches the credentialed call…
    expect(withHttpsCreds["GIT_SSL_NO_VERIFY"]).toBe("1");
    // …and the env itself never carries the secret (it is in the URL, which every log redacts).
    expect(Object.values(withHttpsCreds).some((value) => value.includes("u:p"))).toBe(false);
  });

  it("the shipped build has verification off for the update path (baked decision)", () => {
    expect(DISABLE_SSL).toBe(true);
  });
});

// ── the real thing ───────────────────────────────────────────────────────────────

if (!opensslAvailable()) {
  describe.skip("update transport over a self-signed https host (openssl unavailable)", () => {
    it.skip("TLS specs require openssl", () => undefined);
  });
} else {
  it.layer(NodeServices.layer)("update transport over a self-signed https host", (it) => {
    const runWith = <A, E>(
      disableSsl: boolean,
      effect: Effect.Effect<A, E, HttpClient.HttpClient>,
    ): Effect.Effect<A, E> => effect.pipe(Effect.provide(buildUpdateHttpClientLayer(disableSsl)));

    it.effect("web manifest: permissive client SUCCEEDS where the strict client FAILS", () =>
      withHttpsServer((base) =>
        Effect.gen(function* () {
          const permissive = yield* runWith(
            true,
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              return yield* fetchWebRelease(base, null, client);
            }),
          ).pipe(Effect.result);
          expect(permissive._tag).toBe("Success");
          if (permissive._tag === "Success") {
            expect(permissive.success.manifest.version).toBe("9.9.9");
          }

          const strict = yield* runWith(
            false,
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              return yield* fetchWebRelease(base, null, client);
            }),
          ).pipe(Effect.result);
          expect(strict._tag).toBe("Failure");
          if (strict._tag === "Failure") {
            // It must fail as a TRANSPORT problem — the server never got to answer.
            expect(strict.failure.failure.class).toBe("transport");
          }
        }),
      ),
    );

    it.effect("web probe: the same split, so a source card cannot lie about reachability", () =>
      withHttpsServer((base) =>
        Effect.gen(function* () {
          const permissive = yield* runWith(
            true,
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              return yield* probeWeb(base, null, client);
            }),
          );
          expect(permissive.ok).toBe(true);

          const strict = yield* runWith(
            false,
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              return yield* probeWeb(base, null, client);
            }),
          );
          expect(strict.ok).toBe(false);
        }),
      ),
    );

    it.effect("tarball download: the per-request flag decides, both ways", () =>
      withHttpsServer((base) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const appRoot = yield* fs.makeTempDirectory({ prefix: "ru-au-tls-app-" });

          const download = (insecureTls: boolean) =>
            fetchVersionToDisk({
              appRoot,
              version: "9.9.9",
              source: {
                kind: "http",
                url: `${base}/ru-code-9.9.9.tgz`,
                basicAuth: null,
                insecureTls,
              },
              expectedSha256: "deadbeef",
            }).pipe(Effect.flip);

          // The server 404s this path, so a permissive download gets as far as an HTTP answer…
          const permissive = yield* download(true);
          expect(permissive._tag).toBe("FetchNetworkError");
          if (permissive._tag === "FetchNetworkError") {
            expect(permissive.status).toBe(404);
          }

          // …while the strict one never completes a handshake, so there is no status at all.
          const strict = yield* download(false);
          expect(strict._tag).toBe("FetchNetworkError");
          if (strict._tag === "FetchNetworkError") {
            expect(strict.status).toBeNull();
            expect(strict.evidence).not.toBeNull();
          }
        }),
      ),
    );

    it.effect("the permissive agent does NOT leak into a client built elsewhere", () =>
      withHttpsServer((base) =>
        Effect.gen(function* () {
          // A plain node request with default settings must still refuse the certificate — proof
          // that nothing global was flipped while the engine's own client was permissive.
          yield* runWith(
            true,
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              return yield* probeWeb(base, null, client);
            }),
          );
          const defaultClientRejects = yield* Effect.callback<boolean>((resume) => {
            const request = NodeHttps.get(`${base}/manifest.json`, () =>
              resume(Effect.succeed(false)),
            );
            request.on("error", () => resume(Effect.succeed(true)));
          });
          expect(defaultClientRejects).toBe(true);
        }),
      ),
    );
  });
}

// Layer is referenced so the import is meaningful in both branches of the openssl guard.
void Layer;
