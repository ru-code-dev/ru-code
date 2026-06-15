import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { ServerConfig } from "./config.ts";

// pixso-move: ported from apps/server/src/serverLogger.ts. Pretty console logger
// with the configured minimum level. Convention: logError / logDebug only.
export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer([Logger.consolePretty()], { mergeWithExisting: false });
  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
