import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";

export interface ServerConfigShape {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly logLevel: LogLevel.LogLevel;
  // ACP / qwen wiring for the processor. The CLI path, home, and auth method are resolved
  // here (from CLI flags / env), never hardcoded in the processor. `cliJs === ""` means no
  // qwen is configured: jobs still run but fail gracefully into `error` rows.
  readonly cliJs: string;
  readonly cliHome: string | undefined;
  readonly authMethodId: string;
  readonly acpCwd: string;
  readonly acpNoSsl: boolean;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7787;
export const DEFAULT_DB_PATH = "./.data/pixso.sqlite";
export const DEFAULT_AUTH_METHOD_ID = "openai";

const defaults: ServerConfigShape = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  dbPath: DEFAULT_DB_PATH,
  logLevel: "Debug",
  cliJs: "",
  cliHome: undefined,
  authMethodId: DEFAULT_AUTH_METHOD_ID,
  acpCwd: ".",
  acpNoSsl: false,
};

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@pixso-move/server/config/ServerConfig",
) {
  // Production layer built from resolved options.
  static readonly layer = (shape: ServerConfigShape): Layer.Layer<ServerConfig> =>
    Layer.succeed(ServerConfig, shape);

  // Test layer: defaults with an in-memory DB, overridable per test.
  static readonly layerTest = (
    overrides: Partial<ServerConfigShape> = {},
  ): Layer.Layer<ServerConfig> =>
    Layer.succeed(ServerConfig, { ...defaults, dbPath: ":memory:", ...overrides });
}

// Merge CLI/env options over defaults (used by bin.ts).
export const resolveServerConfig = (overrides: Partial<ServerConfigShape>): ServerConfigShape => ({
  ...defaults,
  ...overrides,
});
