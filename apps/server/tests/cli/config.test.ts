import NodeOS from "node:os";

import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { deriveServerPaths } from "../../src/config.ts";
import { resolveServerConfig } from "../../src/cli/config.ts";

// ru-fork: these unit tests exercise resolveServerConfig in isolation (no real
// preflight). resolveServerConfig now takes a required `cli` resolution; inject
// a stub. Every test sets a baseDir override (flag / RU_FORK_HOME / bootstrap),
// so the stub's ourRoot is never the chosen baseDir — only cliJs/cliConfigDir
// surface on the resolved config.
const TEST_CLI = {
  cliJs: "/tmp/test-cli/.qwen/bin/cli.js",
  configDir: "/tmp/test-cli/.qwen",
  ourRoot: "/tmp/test-cli/.ru-fork",
  source: "standard",
} as const;

const resolveServerConfigT = (
  flags: Parameters<typeof resolveServerConfig>[0],
  cliLogLevel: Parameters<typeof resolveServerConfig>[1],
  options?: Parameters<typeof resolveServerConfig>[3],
) => resolveServerConfig(flags, cliLogLevel, TEST_CLI, options);

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const makeDesktopBootstrap = (
  overrides: Partial<DesktopBackendBootstrapValue> = {},
): DesktopBackendBootstrapValue => ({
  mode: "desktop",
  noBrowser: true,
  port: 4888,
  t3Home: "/tmp/t3-bootstrap-home",
  host: "127.0.0.1",
  desktopBootstrapToken: "desktop-bootstrap-token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
  ...overrides,
});

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  // ru-fork: observability config fields removed from ServerConfig — spread is now empty
  const defaultObservabilityConfig = {} as const;

  const openBootstrapFd = Effect.fn(function* (payload: DesktopBackendBootstrapValue) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
    const encoded = yield* encodeDesktopBootstrap(payload);
    yield* fs.writeFileString(filePath, `${encoded}\n`);
    const { fd } = yield* fs.open(filePath, { flag: "r" });
    return fd;
  });

  it.effect("falls back to effect/config values when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-env-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));
      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          baseUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RU_FORK_LOG_LEVEL: "Warn",
                  RU_FORK_MODE: "desktop",
                  RU_FORK_PORT: "4001",
                  RU_FORK_HOST: "0.0.0.0",
                  RU_FORK_HOME: baseDir,
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  RU_FORK_NO_BROWSER: "true",
                  RU_FORK_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  RU_FORK_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Warn",
        ...defaultObservabilityConfig,
        mode: "desktop",
        port: 4001,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: "0.0.0.0",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        basePath: "",
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-flags-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));
      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          baseUrl: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(true),
          logWebSocketEvents: Option.some(true),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RU_FORK_LOG_LEVEL: "Warn",
                  RU_FORK_MODE: "desktop",
                  RU_FORK_PORT: "4001",
                  RU_FORK_HOST: "0.0.0.0",
                  RU_FORK_HOME: join(NodeOS.tmpdir(), "ignored-base"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  RU_FORK_NO_BROWSER: "false",
                  RU_FORK_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  RU_FORK_LOG_WS_EVENTS: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        basePath: "",
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("preserves explicit false CLI boolean flags over env and bootstrap values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-false-flags");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          noBrowser: true,
        }),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          baseUrl: Option.none(),
          noBrowser: Option.some(false),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RU_FORK_BOOTSTRAP_FD: String(fd),
                  RU_FORK_NO_BROWSER: "true",
                  RU_FORK_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  RU_FORK_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        basePath: "",
        noBrowser: false,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });
    }),
  );

  it.effect("uses bootstrap envelope values as fallbacks when flags and env are absent", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/t3-bootstrap-home";
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          port: 4888,
          host: "127.0.0.2",
          t3Home: baseDir,
          noBrowser: true,
          desktopBootstrapToken: "desktop-token",
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        }),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          baseUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RU_FORK_BOOTSTRAP_FD: String(fd),
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: "127.0.0.2",
        staticDir: resolved.staticDir,
        devUrl: undefined,
        basePath: "",
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });
      assert.equal(join(baseDir, "userdata"), resolved.stateDir);
    }),
  );

  it.effect("creates derived runtime directories during config resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-dirs-" });
      const customCwd = path.join(baseDir, "nested", "project");

      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.some(customCwd),
          devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          baseUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      for (const directory of [
        customCwd,
        resolved.stateDir,
        resolved.logsDir,
        resolved.providerLogsDir,
        resolved.terminalLogsDir,
        resolved.attachmentsDir,
        resolved.worktreesDir,
        path.dirname(resolved.serverLogPath),
      ]) {
        expect(yield* fs.exists(directory)).toBe(true);
      }
      expect(resolved.cwd).toBe(path.resolve(customCwd));
    }),
  );

  it.effect("applies flag then env precedence over bootstrap envelope values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-env-wins");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          port: 4888,
          host: "127.0.0.2",
          t3Home: "/tmp/t3-bootstrap-home",
          noBrowser: false,
          desktopBootstrapToken: "desktop-token",
        }),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          baseUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RU_FORK_MODE: "web",
                  RU_FORK_BOOTSTRAP_FD: String(fd),
                  RU_FORK_HOME: baseDir,
                  RU_FORK_NO_BROWSER: "true",
                  RU_FORK_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  RU_FORK_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        basePath: "",
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect.skip("falls back to persisted observability settings when env vars are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-settings-" });
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          baseUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
      expect(resolved.otlpMetricsUrl).toBe("http://localhost:4318/v1/metrics");
      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: resolved.staticDir,
        devUrl: undefined,
        basePath: "",
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });
    }),
  );

  it.effect("forces noBrowser and disables auto-bootstrap for headless startup presentation", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-headless-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfigT(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          baseUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
        {
          startupPresentation: "headless",
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RU_FORK_NO_BROWSER: "false",
                  RU_FORK_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 3773,
        cwd: process.cwd(),
        baseDir,
        cliJs: TEST_CLI.cliJs,
        cliConfigDir: TEST_CLI.configDir,
        ...derivedPaths,
        host: undefined,
        staticDir: resolved.staticDir,
        devUrl: undefined,
        basePath: "",
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });
    }),
  );
});
