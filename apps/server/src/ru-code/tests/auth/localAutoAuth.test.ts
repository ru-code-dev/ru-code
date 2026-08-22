// ru-code: LOOPBACK AUTO-AUTH — the local-bootstrap endpoint's whole contract.
//
// Three layers of proof:
//  1. the pure request gate (peer / Host / Origin matrix — including the cases a
//     real loopback test socket cannot produce, like a remote peer);
//  2. the route served over a REAL loopback HTTP server (NodeHttpServer.layerTest):
//     grant + refusal statuses, credential stability across requests, no-store;
//  3. the seam through the REAL PairingGrantStore: a route-minted credential is
//     consumable (repeatedly — unbounded), carries the startup-token scopes, and
//     an ineligible (desktop / wildcard / remote / flag-off) config leaves the
//     endpoint dark.
//
// node:http is used deliberately: the refusal cases forge the Host header,
// which fetch/HttpClient refuse to send.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as ServerConfig from "../../../config.ts";
import * as PairingGrantStore from "../../../auth/PairingGrantStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  __resetLocalAutoAuthForTests,
  evaluateLocalBootstrapGate,
  installLocalBootstrapMinting,
  isLocalAutoAuthEligible,
  isLocalAutoAuthEnabled,
  LOCAL_BOOTSTRAP_ROUTE_PATH,
  LOCAL_LOOPBACK_BOOTSTRAP_SUBJECT,
  localBootstrapRouteLayer,
  shouldRotateLocalBootstrapCredential,
} from "../../auth/localAutoAuth.ts";

// ── 1. the pure request gate ─────────────────────────────────────────────────

describe("evaluateLocalBootstrapGate", () => {
  const grantInput = {
    installed: true,
    peerAddress: "127.0.0.1",
    hostHeader: "127.0.0.1:3773",
    originHeader: undefined,
  };

  it("grants a loopback peer + loopback Host + absent Origin", () => {
    expect(evaluateLocalBootstrapGate(grantInput)).toBe("grant");
  });

  it("grants every loopback peer shape (IPv6, IPv4-mapped, 127/8)", () => {
    for (const peerAddress of ["::1", "::ffff:127.0.0.1", "127.5.5.5"]) {
      expect(evaluateLocalBootstrapGate({ ...grantInput, peerAddress })).toBe("grant");
    }
  });

  it("grants loopback Host header shapes (localhost, bracketed IPv6, portless)", () => {
    for (const hostHeader of ["localhost:5173", "[::1]:3773", "127.0.0.1", "LOCALHOST:80"]) {
      expect(evaluateLocalBootstrapGate({ ...grantInput, hostHeader })).toBe("grant");
    }
  });

  it("grants a present LOOPBACK Origin (dev vite / same-origin POST-style)", () => {
    for (const originHeader of [
      "http://localhost:5173",
      "http://127.0.0.1:3773",
      "http://[::1]:3773",
    ]) {
      expect(evaluateLocalBootstrapGate({ ...grantInput, originHeader })).toBe("grant");
    }
  });

  it("rejects when not installed", () => {
    expect(evaluateLocalBootstrapGate({ ...grantInput, installed: false })).toBe("not-installed");
  });

  it("rejects a remote or unknown peer", () => {
    for (const peerAddress of ["10.0.0.5", "192.168.1.20", "::ffff:10.0.0.5", undefined]) {
      expect(evaluateLocalBootstrapGate({ ...grantInput, peerAddress })).toBe("peer-not-loopback");
    }
  });

  it("rejects a non-loopback, missing, or malformed Host (DNS rebinding)", () => {
    for (const hostHeader of ["evil.example", "evil.example:3773", undefined, ""]) {
      expect(evaluateLocalBootstrapGate({ ...grantInput, hostHeader })).toBe("host-not-loopback");
    }
  });

  it("rejects a cross-site, opaque, or malformed Origin", () => {
    for (const originHeader of ["https://evil.example", "null", "not a url"]) {
      expect(evaluateLocalBootstrapGate({ ...grantInput, originHeader })).toBe(
        "origin-not-loopback",
      );
    }
  });
});

// ── eligibility + flag + rotation predicates ─────────────────────────────────

describe("isLocalAutoAuthEligible", () => {
  it("web mode on a loopback (or unset) bind is eligible", () => {
    for (const host of [undefined, "", "localhost", "127.0.0.1", "127.9.9.9", "::1"]) {
      expect(isLocalAutoAuthEligible({ mode: "web", host })).toBe(true);
    }
  });

  it("desktop mode, wildcard binds, and remote binds are not", () => {
    expect(isLocalAutoAuthEligible({ mode: "desktop", host: undefined })).toBe(false);
    for (const host of ["0.0.0.0", "::", "[::]", "192.168.1.10", "example.com"]) {
      expect(isLocalAutoAuthEligible({ mode: "web", host })).toBe(false);
    }
  });
});

describe("isLocalAutoAuthEnabled", () => {
  it("default ON; only an explicit 0/false turns it off", () => {
    expect(isLocalAutoAuthEnabled(undefined)).toBe(true);
    expect(isLocalAutoAuthEnabled("1")).toBe(true);
    expect(isLocalAutoAuthEnabled("true")).toBe(true);
    expect(isLocalAutoAuthEnabled("0")).toBe(false);
    expect(isLocalAutoAuthEnabled("false")).toBe(false);
    expect(isLocalAutoAuthEnabled(" FALSE ")).toBe(false);
  });
});

describe("shouldRotateLocalBootstrapCredential", () => {
  const HOUR = 60 * 60 * 1000;
  it("rotates only when the remaining TTL is inside the 1h margin", () => {
    expect(shouldRotateLocalBootstrapCredential(0, 2 * HOUR)).toBe(false);
    expect(shouldRotateLocalBootstrapCredential(0, HOUR)).toBe(true);
    expect(shouldRotateLocalBootstrapCredential(0, HOUR - 1)).toBe(true);
    expect(shouldRotateLocalBootstrapCredential(HOUR, 0)).toBe(true);
  });
});

// ── 2 + 3. the route over a real loopback server ─────────────────────────────

interface EndpointResponse {
  readonly status: number;
  readonly body: string;
}

/** Raw node:http so the Host header can be forged (fetch forbids that). */
const requestEndpoint = (input: {
  readonly port: number;
  readonly hostHeader?: string;
  readonly originHeader?: string;
}): Effect.Effect<EndpointResponse, Error> =>
  Effect.callback<EndpointResponse, Error>((resume) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: LOCAL_BOOTSTRAP_ROUTE_PATH,
        method: "GET",
        headers: {
          ...(input.hostHeader !== undefined ? { host: input.hostHeader } : {}),
          ...(input.originHeader !== undefined ? { origin: input.originHeader } : {}),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => {
          resume(Effect.succeed({ status: response.statusCode ?? 0, body }));
        });
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
    request.end();
  });

const readCredential = (response: EndpointResponse): string => {
  const payload = JSON.parse(response.body) as { credential?: unknown };
  expect(typeof payload.credential).toBe("string");
  return payload.credential as string;
};

/** Serve the route over layerTest and hand the test the bound port. */
const withRouteServer = <A, E>(run: (port: number) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* Layer.launch(HttpRouter.serve(localBootstrapRouteLayer)).pipe(Effect.forkScoped);
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      throw new Error("test http server has no port");
    }
    return yield* run(address.port);
  });

/** Fake store internals: deterministic credentials + a seed-call recorder. */
const makeFakeCapabilities = () => {
  const seeded: Array<{ credential: string; subject: string; scopes: ReadonlyArray<string> }> = [];
  let counter = 0;
  return {
    seeded,
    install: installLocalBootstrapMinting({
      config: { mode: "web", host: undefined },
      generateCredential: Effect.sync(() => {
        counter += 1;
        return `TESTCRED${counter}`;
      }),
      seedGrant: (credential, grant) =>
        Effect.sync(() => {
          seeded.push({ credential, subject: grant.subject, scopes: grant.scopes });
        }),
    }),
  };
};

it.layer(NodeServices.layer)("localBootstrapRouteLayer", (it) => {
  it.effect("grants a plain loopback GET and keeps the credential stable", () =>
    Effect.gen(function* () {
      __resetLocalAutoAuthForTests();
      const fake = makeFakeCapabilities();
      yield* fake.install;
      const { first, second } = yield* withRouteServer((port) =>
        Effect.gen(function* () {
          const first = yield* requestEndpoint({ port });
          const second = yield* requestEndpoint({ port });
          return { first, second };
        }),
      );
      expect(first.status).toBe(200);
      expect(readCredential(first)).toBe("TESTCRED1");
      // A second request inside the TTL returns the SAME credential — no reseed.
      expect(second.status).toBe(200);
      expect(readCredential(second)).toBe("TESTCRED1");
      expect(fake.seeded).toHaveLength(1);
      expect(fake.seeded[0]).toMatchObject({
        credential: "TESTCRED1",
        subject: LOCAL_LOOPBACK_BOOTSTRAP_SUBJECT,
        scopes: AuthAdministrativeScopes,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses cross-site Origin, forged Host, and stays dark when not installed", () =>
    Effect.gen(function* () {
      __resetLocalAutoAuthForTests();
      const fake = makeFakeCapabilities();
      yield* fake.install;
      yield* withRouteServer((port) =>
        Effect.gen(function* () {
          const evilOrigin = yield* requestEndpoint({
            port,
            originHeader: "https://evil.example",
          });
          expect(evilOrigin.status).toBe(404);
          expect(evilOrigin.body).not.toContain("TESTCRED");

          const opaqueOrigin = yield* requestEndpoint({ port, originHeader: "null" });
          expect(opaqueOrigin.status).toBe(404);

          const forgedHost = yield* requestEndpoint({ port, hostHeader: "evil.example:80" });
          expect(forgedHost.status).toBe(404);
          expect(forgedHost.body).not.toContain("TESTCRED");

          const loopbackOrigin = yield* requestEndpoint({
            port,
            originHeader: "http://localhost:5173",
          });
          expect(loopbackOrigin.status).toBe(200);

          __resetLocalAutoAuthForTests();
          const dark = yield* requestEndpoint({ port });
          expect(dark.status).toBe(404);
          return undefined;
        }),
      );
      // Refusals never minted anything beyond the one granted request.
      expect(fake.seeded).toHaveLength(1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("RU_CODE_LOCAL_AUTO_AUTH=0 keeps the endpoint dark", () =>
    Effect.gen(function* () {
      __resetLocalAutoAuthForTests();
      const previous = process.env["RU_CODE_LOCAL_AUTO_AUTH"];
      process.env["RU_CODE_LOCAL_AUTO_AUTH"] = "0";
      try {
        const fake = makeFakeCapabilities();
        yield* fake.install;
        const response = yield* withRouteServer((port) => requestEndpoint({ port }));
        expect(response.status).toBe(404);
        expect(fake.seeded).toHaveLength(0);
      } finally {
        if (previous === undefined) {
          delete process.env["RU_CODE_LOCAL_AUTO_AUTH"];
        } else {
          process.env["RU_CODE_LOCAL_AUTO_AUTH"] = previous;
        }
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

// ── 3. through the REAL PairingGrantStore (the seam end-to-end) ──────────────

const makeConfigLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "mode" | "host">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ru-local-auto-auth-" })));

const makeStoreLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "mode" | "host">>,
) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(makeConfigLayer(overrides)),
  );

it.layer(NodeServices.layer)("loopback auto-auth through PairingGrantStore", (it) => {
  it.effect("a route-minted credential exchanges repeatedly with the startup-token scopes", () =>
    Effect.gen(function* () {
      // NO reset here: building the store layer (Effect.provide below) is what
      // installed the real capabilities — the seam under test.
      const store = yield* PairingGrantStore.PairingGrantStore;
      const response = yield* withRouteServer((port) => requestEndpoint({ port }));
      expect(response.status).toBe(200);
      const credential = readCredential(response);
      // The store's own pairing-token format — proves the real generator ran.
      expect(credential).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);

      const first = yield* store.consume(credential);
      // Unbounded uses: a page reload (or second browser) re-exchanges fine.
      const second = yield* store.consume(credential);
      for (const grant of [first, second]) {
        expect(grant.subject).toBe(LOCAL_LOOPBACK_BOOTSTRAP_SUBJECT);
        expect(grant.method).toBe("desktop-bootstrap");
        expect(grant.scopes).toEqual(AuthAdministrativeScopes);
      }
      // The seeded grant is in-memory only: it must never surface in the
      // pairing-links management list.
      const listed = yield* store.listActive();
      expect(listed).toHaveLength(0);
    }).pipe(Effect.provide(makeStoreLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)))),
  );

  it.effect("a desktop-mode store leaves the endpoint dark", () =>
    Effect.gen(function* () {
      // install() overwrites the box on every store build — an ineligible
      // config clears whatever a previous test left there.
      yield* PairingGrantStore.PairingGrantStore;
      const response = yield* withRouteServer((port) => requestEndpoint({ port }));
      expect(response.status).toBe(404);
    }).pipe(
      Effect.provide(
        makeStoreLayer({ mode: "desktop" }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    ),
  );

  it.effect("a wildcard bind leaves the endpoint dark", () =>
    Effect.gen(function* () {
      yield* PairingGrantStore.PairingGrantStore;
      const response = yield* withRouteServer((port) => requestEndpoint({ port }));
      expect(response.status).toBe(404);
    }).pipe(
      Effect.provide(
        makeStoreLayer({ host: "0.0.0.0" }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    ),
  );
});
