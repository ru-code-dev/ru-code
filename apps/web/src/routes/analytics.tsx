// ru-code: top-level analytics page (owner decision row 4 — its own page, not a settings section;
// the Usage page next door is the shape this follows). The page itself lives in ru-code/analytics.
import { createFileRoute } from "@tanstack/react-router";

import { AnalyticsPage } from "../ru-code/analytics/AnalyticsPage.tsx";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
});
