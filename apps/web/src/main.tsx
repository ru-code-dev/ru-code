import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
// ru-fork: pick up the server-injected --base-url prefix so the
// router, browser-history, and service-worker registration all live
// under the same path.
import { getBasePath, joinBasePath } from "./ru-fork/basePath";

const basepath = getBasePath();

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
// ru-fork: basepath belongs on createRouter (handled below by getRouter);
// `createBrowserHistory` in this @tanstack/history version takes no path option.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history, basepath);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

if (!isElectron && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(joinBasePath(basepath, "/sw.js")).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
