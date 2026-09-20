// ru-code: plugins — Settings ▸ Plugins (V2-43): thin route seam, all logic lives in the zone.
import { createFileRoute } from "@tanstack/react-router";

import { PluginsSettingsPage } from "../ru-code/plugins/settings/PluginsSettingsPage";

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsSettingsPage,
});
