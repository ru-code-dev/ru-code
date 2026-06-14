// ru-fork #4: graceful-shutdown sweep of the MCP overlay dir. runFastShutdownCleanup
// runs inside the synchronous SIGINT/SIGTERM handler, so it must drop every per-project
// overlay (plaintext secrets) via a SYNC delete. (RED until fastShutdown.ts adds the
// nodeFs.rmSync(config.mcpOverlayDir, …) step.)
// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../src/config.ts";
import { runFastShutdownCleanup } from "../src/fastShutdown.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { TerminalManager } from "../src/terminal/Services/Manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runFastShutdownCleanup — MCP overlay sweep (ru-fork #4)", () => {
  it("G11 — deletes every per-project overlay under mcpOverlayDir on shutdown", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-fork-shutdown-"));
    tempDirs.push(baseDir);

    const layer = Layer.mergeAll(
      Layer.mock(ProviderService, { stopAll: () => Effect.void }),
      Layer.mock(TerminalManager, { killAll: Effect.void }),
      // NodeServices must be PROVIDED to ServerConfig.layerTest (it derives paths via
      // FileSystem/Path), not merged as a sibling.
      ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
    );
    const runtime = ManagedRuntime.make(layer);
    try {
      const config = await runtime.runPromise(Effect.service(ServerConfig));

      // Two projects' overlay files sitting on disk at shutdown time.
      const a = path.join(config.mcpOverlayDir, "project-a", "system.json");
      const b = path.join(config.mcpOverlayDir, "project-b", "system.json");
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.writeFileSync(a, "{}");
      fs.writeFileSync(b, "{}");
      expect(fs.existsSync(a)).toBe(true);
      expect(fs.existsSync(b)).toBe(true);

      await runtime.runPromise(runFastShutdownCleanup);

      expect(fs.existsSync(config.mcpOverlayDir)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
