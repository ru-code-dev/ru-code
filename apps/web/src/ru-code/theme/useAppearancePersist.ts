// ru-code: bind the appearance storage shim to the server-settings write path.
//
// The shim (appearanceStore.ts) is imported by non-React modules (themePalette.ts), so it
// cannot own a hook. This registers the writer once, at app boot, from inside React —
// the same `serverEnvironment.updateSettings` path patch 01's language toggle uses.
//
// Writes are fire-and-forget: the shim's cache already updated synchronously, so t3's
// `useSyncExternalStore` subscribers have repainted; persistence only has to follow.
// Unlike the locale toggle this needs no reload — t3's engine applies theme changes live.

import { useEffect } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { registerAppearancePersist } from "./appearanceStore";

export function useAppearancePersist(): void {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId;
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, "appearance change");

  useEffect(() => {
    if (!environmentId) return;
    registerAppearancePersist((patch) => {
      void persistSettings({ environmentId, input: { patch } });
    });
  }, [environmentId, persistSettings]);
}
