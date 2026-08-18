// ru-code: proves the fork's telemetry defaults keep PostHog silent. No project
// key is baked in and telemetry is off by default (AnalyticsService.ts), so
// nothing should ever POST unless an operator sets BOTH a key and the opt-in
// flag. Runs the real service against a capturing HTTP server and asserts zero
// batch requests. (Kept out of the upstream AnalyticsService.test.ts per R3.)
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerConfig from "../../../config.ts";
import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import { getTelemetryIdentifier } from "../../../telemetry/Identify.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
    }>;
  } | null;
}

// Run the analytics service against a capturing HTTP server with the given
// telemetry config and return every batch POST it attempted (plus the resolved
// identity, to prove silence is the config gate, not a missing id).
const collectTelemetryRequests = (configValues: Record<string, unknown>) =>
  Effect.gen(function* () {
    const capturedRequests: Array<RecordedBatchRequest> = [];
    const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-telemetry-gate-",
    });
    const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
    const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown(configValues));
    const batchServerLayer = HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method !== "POST") {
          return HttpServerResponse.empty({ status: 404 });
        }
        const payload = yield* request.json.pipe(
          Effect.map((body) => body as RecordedBatchRequest["body"]),
          Effect.orElseSucceed(() => null),
        );
        capturedRequests.push({ path: request.url, body: payload });
        return HttpServerResponse.jsonUnsafe({});
      }),
    );
    const runtimeLayer = telemetryLayer.pipe(
      Layer.provide(configLayer),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );

    const identifier = yield* Effect.gen(function* () {
      yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
      const resolvedIdentifier = yield* getTelemetryIdentifier;
      const analytics = yield* AnalyticsService.AnalyticsService;
      for (let index = 0; index < 5; index += 1) {
        yield* analytics.record("test.telemetry.gate", { index });
      }
      yield* analytics.flush;
      return resolvedIdentifier;
    }).pipe(Effect.provide(runtimeLayer));

    const batches = capturedRequests.filter((request) => Array.isArray(request.body?.batch));
    return { batches, identifier } as const;
  });

it.layer(NodeServices.layer)("AnalyticsService telemetry defaults", (it) => {
  // With the fork defaults (disabled, no baked-in project key) nothing leaves
  // the machine even though an identity resolves — proving the default is off,
  // not merely un-identified.
  it.effect("sends nothing with the fork defaults (telemetry disabled)", () =>
    Effect.gen(function* () {
      const { batches, identifier } = yield* collectTelemetryRequests({});
      assert.equal(identifier !== null, true);
      assert.equal(batches.length, 0);
    }),
  );

  // Opting in without a project key must stay silent — no POST to the default
  // PostHog host with an empty api_key.
  it.effect("sends nothing when enabled but no project key is set", () =>
    Effect.gen(function* () {
      const { batches } = yield* collectTelemetryRequests({
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_KEY: "",
        T3CODE_POSTHOG_HOST: "",
      });
      assert.equal(batches.length, 0);
    }),
  );
});
