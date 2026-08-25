// ru-code: host wiring for the analytics engine (@smart-tools/qwen-cli-analytics).
//
// The package ships the scanner + SQL cache repo and declares ONE port — the only host
// coupling: AnalyticsManagerConfig, the CLI config dir (qwen's runtime base; the
// transcript tree lives at `<cliConfigDir>/projects`, resolved inside the package via
// @smart-tools/qwen-cli-transcript-core) plus the bucketing timezone (undefined ⇒ the
// machine-local zone; tests inject "UTC"). SqlClient / FileSystem / Path come from the
// ambient host graph where the layer is provided.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AnalyticsManagerConfig,
  AnalyticsRuntimeLive,
} from "@smart-tools/qwen-cli-analytics/server";

import { ServerConfig } from "../../config.ts";

export const analyticsConfigLayer = Layer.effect(
  AnalyticsManagerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return AnalyticsManagerConfig.of({
      cliConfigDir: config.cliConfigDir,
      timeZone: undefined,
    });
  }),
);

/** Module-level const: Layer memoization gives every provide site the same scanner. */
export const AnalyticsHostLayer = AnalyticsRuntimeLive.pipe(Layer.provide(analyticsConfigLayer));
