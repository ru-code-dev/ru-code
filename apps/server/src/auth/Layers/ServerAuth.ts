import {
  type AuthBearerBootstrapResult,
  type AuthClientSession,
  type AuthBootstrapResult,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type SessionStateResolution,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
  type IssuedSession,
} from "../Services/SessionCredentialService.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane.ts";
import { isLoopbackHostname } from "../../http.ts";
import { ServerConfig } from "../../config.ts";
import { deriveAuthClientMetadata, readRemoteAddressFromSource } from "../utils.ts";

type BootstrapExchangeResult = {
  readonly response: AuthBootstrapResult;
  readonly sessionToken: string;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TOKEN_QUERY_PARAM = "wsToken";

export function toBootstrapExchangeAuthError(cause: BootstrapCredentialError): AuthError {
  if (cause.status === 500) {
    return new AuthError({
      message: "Failed to validate bootstrap credential.",
      status: 500,
      cause,
    });
  }

  return new AuthError({
    message: "Invalid bootstrap credential.",
    status: 401,
    cause,
  });
}

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

// ru-fork: pure mapper for the loopback-bypass path (added in 752a7104).
// Hoisted to module scope because it captures no parent closures, matching
// the `parseBearerToken` idiom above.
const issuedToAuthenticatedSession = (issued: IssuedSession): AuthenticatedSession => ({
  sessionId: issued.sessionId,
  subject: "loopback-trusted",
  method: issued.method,
  role: issued.role,
  expiresAt: issued.expiresAt,
});

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const authControlPlane = yield* AuthControlPlane;
  const sessions = yield* SessionCredentialService;
  const config = yield* ServerConfig;
  const descriptor = yield* policy.getDescriptor();

  // Loopback bypass: in desktop mode the OS user is the trust boundary, so
  // any request whose kernel-reported source IP is loopback is by definition
  // trusted. We auto-issue a session for those requests — the user never
  // sees the pair screen (and the app survives cookie-wipe-on-close). The decision depends only on `mode` (deployment
  // intent) and the request's source IP — NOT on the bind address. The bind
  // address is a separate listener-layer concern; coupling them produces
  // platform-dependent edge cases (e.g. macOS forbids non-root binds to
  // 127.0.0.1:80 but permits the equivalent wildcard bind).
  const loopbackBypassEnabled = config.mode === "desktop";

  const isLoopbackRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
    const remoteAddress = readRemoteAddressFromSource(request.source);
    return Boolean(remoteAddress && isLoopbackHostname(remoteAddress));
  };

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.tapError((cause: SessionCredentialError) =>
        // ru-fork: demoted from warn — credential rejection on every unauthed request is normal pairing-flow noise.
        Effect.logDebug("Rejected authenticated session credential.").pipe(
          Effect.annotateLogs({
            reason: cause.message,
          }),
        ),
      ),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        role: session.role,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Unauthorized request.",
            status: 401,
            cause,
          }),
      ),
    );

  const issueLoopbackSession = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<IssuedSession, AuthError> =>
    sessions
      .issue({
        method: "browser-session-cookie",
        subject: "loopback-trusted",
        role: "owner",
        client: deriveAuthClientMetadata({ request, label: "loopback-trusted" }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue loopback session.",
              cause,
            }),
        ),
      );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    const bearerToken = parseBearerToken(request);
    const credential = cookieToken ?? bearerToken;
    const tryBypass = (): Effect.Effect<AuthenticatedSession, AuthError> =>
      loopbackBypassEnabled && isLoopbackRequest(request)
        ? issueLoopbackSession(request).pipe(Effect.map(issuedToAuthenticatedSession))
        : Effect.fail(
            new AuthError({
              message: "Authentication required.",
              status: 401,
            }),
          );
    if (!credential) {
      return tryBypass();
    }
    return authenticateToken(credential).pipe(
      Effect.catchTag("AuthError", (error) =>
        loopbackBypassEnabled && isLoopbackRequest(request)
          ? issueLoopbackSession(request).pipe(Effect.map(issuedToAuthenticatedSession))
          : Effect.fail(error),
      ),
    );
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    Effect.gen(function* () {
      // Fast path: existing valid cookie/bearer.
      const cookieToken = request.cookies[sessions.cookieName];
      const bearerToken = parseBearerToken(request);
      const credential = cookieToken ?? bearerToken;
      if (credential) {
        const verified = yield* authenticateToken(credential).pipe(
          Effect.map((session): Option.Option<AuthenticatedSession> => Option.some(session)),
          Effect.orElseSucceed(() => Option.none<AuthenticatedSession>()),
        );
        if (Option.isSome(verified)) {
          const session = verified.value;
          return {
            state: {
              authenticated: true,
              auth: descriptor,
              role: session.role,
              sessionMethod: session.method,
              ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
            } satisfies AuthSessionState,
          } satisfies SessionStateResolution;
        }
      }
      // Loopback bypass: mint a fresh session and return its token so the
      // route can attach it as a Set-Cookie header.
      if (loopbackBypassEnabled && isLoopbackRequest(request)) {
        const issued = yield* issueLoopbackSession(request).pipe(
          Effect.map((session): Option.Option<IssuedSession> => Option.some(session)),
          Effect.orElseSucceed(() => Option.none<IssuedSession>()),
        );
        if (Option.isSome(issued)) {
          const session = issued.value;
          return {
            state: {
              authenticated: true,
              auth: descriptor,
              role: session.role,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthSessionState,
            mintedSession: {
              token: session.token,
              expiresAt: session.expiresAt,
            },
          } satisfies SessionStateResolution;
        }
      }
      return {
        state: {
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState,
      } satisfies SessionStateResolution;
    });

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) =>
        sessions
          .issue({
            method: "browser-session-cookie",
            subject: grant.subject,
            role: grant.role,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          ),
      ),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              role: session.role,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBootstrapResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
    );

  const exchangeBootstrapCredentialForBearerSession: ServerAuthShape["exchangeBootstrapCredentialForBearerSession"] =
    (credential, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeAuthError),
        Effect.flatMap((grant) =>
          sessions
            .issue({
              method: "bearer-session-token",
              subject: grant.subject,
              role: grant.role,
              client: {
                ...requestMetadata,
                ...(grant.label ? { label: grant.label } : {}),
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: "Failed to issue authenticated session.",
                    cause,
                  }),
              ),
            ),
        ),
        Effect.map(
          (session) =>
            ({
              authenticated: true,
              role: session.role,
              sessionMethod: "bearer-session-token",
              expiresAt: DateTime.toUtc(session.expiresAt),
              sessionToken: session.token,
            }) satisfies AuthBearerBootstrapResult,
        ),
      );

  const issuePairingCredential: ServerAuthShape["issuePairingCredential"] = (input) =>
    authControlPlane
      .createPairingLink({
        role: input?.role ?? "client",
        subject: input?.role === "owner" ? "owner-bootstrap" : "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue pairing credential.",
              cause,
            }),
        ),
        Effect.map(
          (issued) =>
            ({
              id: issued.id,
              credential: issued.credential,
              ...(issued.label ? { label: issued.label } : {}),
              expiresAt: issued.expiresAt,
            }) satisfies AuthPairingCredentialResult,
        ),
      );

  const listPairingLinks: ServerAuthShape["listPairingLinks"] = () =>
    authControlPlane
      .listPairingLinks({
        role: "client",
        excludeSubjects: ["owner-bootstrap"],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load pairing links.",
              cause,
            }),
        ),
      );

  const revokePairingLink: ServerAuthShape["revokePairingLink"] = (id) =>
    authControlPlane.revokePairingLink(id).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke pairing link.",
            cause,
          }),
      ),
    );

  const listClientSessions: ServerAuthShape["listClientSessions"] = (currentSessionId) =>
    authControlPlane.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load paired clients.",
            cause,
          }),
      ),
      Effect.map((clientSessions) =>
        clientSessions.map(
          (clientSession): AuthClientSession => ({
            ...clientSession,
            current: clientSession.sessionId === currentSessionId,
          }),
        ),
      ),
    );

  const revokeClientSession: ServerAuthShape["revokeClientSession"] = (
    currentSessionId,
    targetSessionId,
  ) =>
    Effect.gen(function* () {
      if (currentSessionId === targetSessionId) {
        return yield* new AuthError({
          message: "Use revoke other clients to keep the current owner session active.",
          status: 403,
        });
      }
      return yield* authControlPlane.revokeSession(targetSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to revoke client session.",
              cause,
            }),
        ),
      );
    });

  const revokeOtherClientSessions: ServerAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    authControlPlane.revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke other client sessions.",
            cause,
          }),
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issuePairingCredential({ role: "owner" }).pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        // ru-fork: preserve any --base-url prefix already in
        // baseUrl.pathname (the caller passes `${bindUrl}${basePath}`).
        const existing = url.pathname.replace(/\/+$/, "");
        url.pathname = existing.length > 0 ? `${existing}/pair` : "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
    );

  const issueWebSocketToken: ServerAuthShape["issueWebSocketToken"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to issue websocket token.",
            cause,
          }),
      ),
      Effect.map(
        (issued) =>
          ({
            token: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTokenResult,
      ),
    );

  const authenticateWebSocketUpgrade: ServerAuthShape["authenticateWebSocketUpgrade"] = (request) =>
    Effect.gen(function* () {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketToken = requestUrl.value.searchParams.get(WEBSOCKET_TOKEN_QUERY_PARAM);
        if (websocketToken && websocketToken.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketToken).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Unauthorized request.",
                  status: 401,
                  cause,
                }),
            ),
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState,
    exchangeBootstrapCredential,
    exchangeBootstrapCredentialForBearerSession,
    issuePairingCredential,
    listPairingLinks,
    revokePairingLink,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketToken,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(AuthControlPlaneLive),
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(ServerAuthPolicyLive),
);
