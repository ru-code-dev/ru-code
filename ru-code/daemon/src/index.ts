// ru-code: public API of the daemon package. The app's marked seams import only
// from here (see specs/daemon/seam-map.md).

export { foregroundFlag, forceFlag, shouldDaemonize, type DaemonRoutingFlags } from "./cli.ts";
export { launchDaemon, type DaemonLaunchInput } from "./launch.ts";
export { restartDaemon } from "./restart.ts";
export { stopDaemon } from "./stop.ts";
export { runEnvAnalysis } from "./envAnalysis.ts";
export { installSecondSignalHardExit } from "./secondSignalExit.ts";
export { checkSingleInstance, ensureSingleInstance } from "./singleInstance.ts";
export { type ForwardableServerFlags } from "./childArgs.ts";
export { DEFAULT_DAEMON_PORT, DEFAULT_DAEMON_HOST, DAEMON_CHILD_ENV } from "./constants.ts";
export { readRuntimeState, type DaemonRuntimeState } from "./runtimeState.ts";
