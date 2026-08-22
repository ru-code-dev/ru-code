// ru-code: public API of the daemon package. The app's marked seams import only
// from here (see specs/daemon/seam-map.md).

export { foregroundFlag, forceFlag, shouldDaemonize, type DaemonRoutingFlags } from "./cli.ts";
export { launchDaemon, type DaemonLaunchInput } from "./launch.ts";
export { restartDaemon } from "./restart.ts";
export { stopDaemon } from "./stop.ts";
export { runEnvAnalysis } from "./envAnalysis.ts";
export { reportBootEnvironment } from "./bootEnv.ts";
export { installSecondSignalHardExit } from "./secondSignalExit.ts";
export { checkSingleInstance, ensureSingleInstance } from "./singleInstance.ts";
export { type ForwardableServerFlags } from "./childArgs.ts";
export { DEFAULT_DAEMON_PORT, DEFAULT_DAEMON_HOST, DAEMON_CHILD_ENV } from "./constants.ts";
export { readRuntimeState, type DaemonRuntimeState } from "./runtimeState.ts";
export { isPortInUse } from "./net.ts"; // ru-code: auto-update pinned-port relaunch gate
export { spawnDetachedServer, DaemonSpawnError } from "./spawn.ts"; // ru-code: reused by the auto-update relaunch spawn
