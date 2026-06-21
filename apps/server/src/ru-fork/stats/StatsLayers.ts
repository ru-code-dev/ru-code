// ru-fork: Stats layer composition. The scanner + its file-cache repo. The repo's
// SqlClient and the scanner's FileSystem/Path/ServerConfig come from the shared
// server runtime graph (where this layer is provideMerged, next to MCP) — Stats is
// DB-backed, so it registers like McpRuntimeServicesLive, not like the pure-fs
// QwenTranscriptLive.
import * as Layer from "effect/Layer";

import { StatsFileCacheRepositoryLive } from "../../persistence/Layers/ProjectionStatsFileCache.ts";
import { StatsScannerLive } from "./StatsScanner.ts";

export const StatsLive = StatsScannerLive.pipe(
  Layer.provide(StatsFileCacheRepositoryLive),
);
