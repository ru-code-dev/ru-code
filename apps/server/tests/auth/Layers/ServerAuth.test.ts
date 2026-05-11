import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerConfigShape } from "../../../src/config.ts";
import { ServerConfig } from "../../../src/config.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { BootstrapCredentialError } from "../../../src/auth/Services/BootstrapCredentialService.ts";
import { ServerAuth, type ServerAuthShape } from "../../../src/auth/Services/ServerAuth.ts";
import {
  ServerAuthLive,
  toBootstrapExchangeAuthError,
} from "../../../src/auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../../../src/auth/Layers/ServerSecretStore.ts";

const makeServerConfigLayer = (overrides?: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const makeServerAuthLayer = (overrides?: Partial<ServerConfigShape>) =>
  ServerAuthLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  sessionToken: string,
  cookieName = "t3_session",
): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

const makeBareRequest = (options: {
  readonly remoteAddress?: string;
}): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {},
    source: options.remoteAddress
      ? { socket: { remoteAddress: options.remoteAddress } }
      : undefined,
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("ServerAuthLive", (it) => {
  it.effect("maps invalid bootstrap credential failures to 401", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Unknown bootstrap credential.",
          status: 401,
        }),
      );

      expect(error.status).toBe(401);
      expect(error.message).toBe("Invalid bootstrap credential.");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Failed to consume bootstrap credential.",
          status: 500,
          cause: new Error("sqlite is unavailable"),
        }),
      );

      expect(error.status).toBe(500);
      expect(error.message).toBe("Failed to validate bootstrap credential.");
    }),
  );

  it.effect("issues client pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.role).toBe("client");
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap owner sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some((pairingLink) => pairingLink.subject === "owner-bootstrap"),
      ).toBe(false);

      const exchanged = yield* serverAuth.exchangeBootstrapCredential(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.role).toBe("owner");
      expect(verified.subject).toBe("owner-bootstrap");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("authenticates loopback requests in desktop mode with default (wildcard) bind", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBareRequest({ remoteAddress: "127.0.0.1" }),
      );

      expect(session.role).toBe("owner");
      expect(session.subject).toBe("loopback-trusted");
    }).pipe(
      // No `host` override: confirms bypass is gated on mode + request IP,
      // not on the bind address being explicitly loopback.
      Effect.provide(makeServerAuthLayer({ mode: "desktop" })),
    ),
  );

  it.effect("authenticates loopback requests with no cookie under desktop-managed-local", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBareRequest({ remoteAddress: "127.0.0.1" }),
      );

      expect(session.role).toBe("owner");
      expect(session.subject).toBe("loopback-trusted");
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          mode: "desktop",
          host: "127.0.0.1",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("rejects non-loopback requests even under desktop-managed-local", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const result = yield* serverAuth
        .authenticateHttpRequest(makeBareRequest({ remoteAddress: "192.168.1.50" }))
        .pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          mode: "desktop",
          host: "127.0.0.1",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("does not bypass auth in remote-reachable policy even on loopback", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const result = yield* serverAuth
        .authenticateHttpRequest(makeBareRequest({ remoteAddress: "127.0.0.1" }))
        .pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          mode: "web",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect(
    "getSessionState mints a session and exposes the cookie token on first loopback hit",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const first = yield* serverAuth.getSessionState(
          makeBareRequest({ remoteAddress: "127.0.0.1" }),
        );

        expect(first.state.authenticated).toBe(true);
        expect(first.mintedSession).toBeDefined();
        expect(first.mintedSession?.token.length ?? 0).toBeGreaterThan(0);

        // Second request carrying the minted cookie should NOT trigger another mint.
        const second = yield* serverAuth.getSessionState(
          makeCookieRequest(first.mintedSession!.token, "t3_session_3773"),
        );
        expect(second.state.authenticated).toBe(true);
        expect(second.mintedSession).toBeUndefined();
      }).pipe(
        Effect.provide(
          makeServerAuthLayer({
            mode: "desktop",
            host: "127.0.0.1",
            port: 3773,
          }),
        ),
      ),
  );

  it.effect("lists pairing links and revokes other client sessions while keeping the owner", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const ownerExchange = yield* serverAuth.exchangeBootstrapCredential(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const ownerSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(ownerExchange.sessionToken),
      );
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Julius iPhone",
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      const clientExchange = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        {
          ...requestMetadata,
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      );
      const clientSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(clientExchange.sessionToken),
      );
      const clientsBeforeRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);
      const revokedCount = yield* serverAuth.revokeOtherClientSessions(ownerSession.sessionId);
      const clientsAfterRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);

      expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
      expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
        "Julius iPhone",
      );
      expect(clientsBeforeRevoke).toHaveLength(2);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === ownerSession.sessionId)?.current,
      ).toBe(true);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
      ).toBe(false);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .label,
      ).toBe("Julius iPhone");
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .deviceType,
      ).toBe("mobile");
      expect(revokedCount).toBe(1);
      expect(clientsAfterRevoke).toHaveLength(1);
      expect(clientsAfterRevoke[0]?.sessionId).toBe(ownerSession.sessionId);
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );
});
