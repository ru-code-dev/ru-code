// ru-code: host wiring for the Pixso MCP assistant (@smart-tools/t3-code-pixso-mcp-assistant).
//
// The package ships the assistant service and declares ONE port — where its
// content-addressed store lives. This module implements it from the ambient host
// graph (ServerConfig.stateDir) and exposes the composed host layer ws.ts provides.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { getLocale } from "@ru-code/localization";

import {
  configurePixsoAssistantLocale,
  PixsoAssistantConfig,
  PixsoAssistantLive,
  PixsoMcpLive,
} from "@smart-tools/t3-code-pixso-mcp-assistant/server";

import { ServerConfig } from "../../config.ts";

// ru-code: point the package's bilingual resolver at the server-global language
// (ServerSettings.locale, kept in sync by serverSettings.ts setLocale) — mirrors the web
// host seam in host.tsx. Server-emitted errors and reports then follow the UI language.
configurePixsoAssistantLocale(getLocale);

/** The feature-owned store lives under `<stateDir>/pixso-assistant` (created here; the
 *  app DB is never on the assistant's write path — spec §8).
 *
 *  Decisions 435/436: there is no env-override seam for the remote endpoint anymore —
 *  the package's `PIXSO_REMOTE_MCP_ENDPOINT` constant IS the address every host dials,
 *  in-git a placeholder pointing at the local fake-remote listener
 *  (`e2e/harness/fakeRemotePixsoMcp.ts`, port 3668), release-only edited outside git to
 *  the real company URL. This layer therefore has nothing to inject. */
export const pixsoAssistantConfigLayer = Layer.effect(
  PixsoAssistantConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const rootDir = path.join(config.stateDir, "pixso-assistant");
    yield* Effect.orDie(fileSystem.makeDirectory(rootDir, { recursive: true }));
    return PixsoAssistantConfig.of({ rootDir });
  }),
);

/** The assistant service with its host port + the real MCP transport provided.
 *  FileSystem + Path + ServerConfig are ambient where ws.ts composes the rpc layer
 *  graph. MODULE-LEVEL on purpose (the auto-update discipline): server.ts and ws.ts
 *  provide the same reference, so layer memoization gives ONE job/store instance. */
export const PixsoAssistantHostLayer = PixsoAssistantLive.pipe(
  Layer.provide(PixsoMcpLive),
  Layer.provide(pixsoAssistantConfigLayer),
);
