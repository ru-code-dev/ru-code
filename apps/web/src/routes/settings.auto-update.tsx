// ru-code: auto-update UI prototype — thin route seam, all logic lives in the zone.
import { createFileRoute } from "@tanstack/react-router";

import { AutoUpdateSettingsPage } from "../ru-code/auto-update-ui/settings/AutoUpdateSettingsPage";

export const Route = createFileRoute("/settings/auto-update")({
  component: AutoUpdateSettingsPage,
});
