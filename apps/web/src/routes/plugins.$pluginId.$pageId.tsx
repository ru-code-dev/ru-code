// ru-code: plugins — file route required by TanStack file-based routing; delegates.
// The ONE host-owned route a plugin page is mounted on (decision V2-4).
//
// A plugin declares `pages: (ctx) => [{ id, title, render, nav }]`; this route resolves
// `$pluginId/$pageId` against that list and mounts the component inside the app's normal chrome.
// Everything interesting is in `ru-code/plugins/PluginPage.tsx` — a fresh fork copies the plugins
// folder and adds this file, and that is the whole page mechanism.
import { createFileRoute } from "@tanstack/react-router";

import { PluginPage } from "../ru-code/plugins/PluginPage";

export const Route = createFileRoute("/plugins/$pluginId/$pageId")({
  component: PluginPage,
});
