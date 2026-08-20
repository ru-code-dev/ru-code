// ru-code: web-side terminal UI kill-switch (seams: ChatView terminal toggle/availability +
// both ThreadTerminalDrawer hosts). Pure UI gating — no server code is disabled; flipping
// TERMINAL_UI_VISIBILITY back restores everything. The environment's OS comes from its served
// ServerConfig descriptor, so a mac client connected to a Windows server is gated too (the
// "hide-windows" mode is about the SERVER platform, where the PTY would run).

import { TERMINAL_UI_VISIBILITY } from "@ru-code/platform-compat/constants";
import type { EnvironmentId, ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

import { useEnvironment } from "~/state/environments";

/** Pure decision — exported for tests. Unknown OS (descriptor not loaded yet) counts as
 * non-Windows, so "hide-windows" never flickers the UI off while the descriptor loads. */
export function isTerminalUiEnabledForOs(os: ExecutionEnvironmentPlatformOs | undefined): boolean {
  switch (TERMINAL_UI_VISIBILITY) {
    case "all":
      return true;
    case "hidden":
      return false;
    case "hide-windows":
      return os !== "windows";
  }
}

export function useTerminalUiEnabled(environmentId: EnvironmentId | null): boolean {
  const environment = useEnvironment(environmentId);
  return isTerminalUiEnabledForOs(environment?.serverConfig?.environment.platform.os);
}
