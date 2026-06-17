import { createFileRoute } from "@tanstack/react-router";

import { StatsDashboard } from "../ru-fork/stats";

export const Route = createFileRoute("/settings/analytics")({
  component: StatsDashboard,
});
