// @effect-diagnostics nodeBuiltinImport:off
// ru-code: filesystem path helpers for the daemon (log file location + parent-dir
// creation). Kept tiny and separate so the orchestrator stays about lifecycle.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

/** The daemon's log file sits beside the runtime-state file. */
export const daemonLogPath = (statePath: string): string =>
  NodePath.join(NodePath.dirname(statePath), "daemon.log");

/** Ensure a file's parent directory exists before we open it for writing. */
export const ensureParentDir = (filePath: string): Effect.Effect<void> =>
  Effect.sync(() => {
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  });
