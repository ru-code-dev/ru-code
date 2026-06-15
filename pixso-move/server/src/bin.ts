import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeAcpRunnerLayer } from "@pixso-move/processor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveServerConfig, ServerConfig } from "./config.ts";
import { runServer } from "./server.ts";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const host = flag("--host");
const port = flag("--port");
const db = flag("--db");
const cliJs = flag("--cli-js");
const cliHome = flag("--cli-home");
const cwd = flag("--cwd");

const config = resolveServerConfig({
  ...(host ? { host } : {}),
  ...(port ? { port: Number(port) } : {}),
  ...(db ? { dbPath: db } : {}),
  ...(cliJs ? { cliJs } : {}),
  ...(cliHome ? { cliHome } : {}),
  ...(cwd ? { acpCwd: cwd } : {}),
  ...(process.argv.includes("--no-ssl") ? { acpNoSsl: true } : {}),
});

// The real qwen ACP runner, built from the resolved CLI config and given a Node spawner.
const acpRunnerLive = makeAcpRunnerLayer({
  cliJs: config.cliJs,
  cwd: config.acpCwd,
  authMethodId: config.authMethodId,
  noSsl: config.acpNoSsl,
  ...(config.cliHome ? { cliHome: config.cliHome } : {}),
}).pipe(Layer.provide(NodeServices.layer));

runServer.pipe(
  Effect.provide(Layer.mergeAll(ServerConfig.layer(config), acpRunnerLive)),
  NodeRuntime.runMain,
);
