// ru-code: backstop locale seed. The REAL guarantee is inside @ru-code/localization —
// initialLocale() reads the server-stamped window.__RU_LOCALE__ at the locale module's own
// first evaluation, so module-level L() constants are correct in any chunk order (entry
// import order alone cannot guarantee that; see localeInit.test.ts).
import "./ru-code/bootLocale";

import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clerkAppearance } from "./components/clerk/clerkAppearance";
// ru-code: plugins — dropped-in plugins, loaded after the first paint.
import { loadPlugins } from "./ru-code/plugins/loadPlugins";
import { flushPluginProblems } from "./ru-code/plugins/problems";
import { reportPluginRootError } from "./ru-code/plugins/rootErrors";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

// ru-code: register the PWA service worker so browsers offer "Install" (emitted
// at /sw.js by serviceWorkerPlugin, as an ES module → `type: "module"`). Never in
// Electron — it loads from a file-backed shell where a service worker has no meaning.
if (!isElectron && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {});
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;

// ru-code: plugins — name the plugin behind a fault React routes past every error boundary — a throw from a
// `useEffect` CLEANUP reaches no boundary at all (see `rootErrors.ts`).
//
// TWO THINGS THESE HOOKS MUST NOT BREAK, both measured by `renderFaults.e2e.test.ts`:
//
//  1. SUPPLYING EITHER CALLBACK REPLACES REACT'S OWN CONSOLE OUTPUT. React's log is the only thing
//     that ever named the cleanup class (the stack carries the plugin's module URL), so both hooks
//     re-emit it. Silencing app errors to attribute plugin ones would be a bad trade.
//  2. ONE FAULT, ONE REPORT. A plugin surface is mounted inside `PluginSurface`'s boundary, which
//     already reports a caught throw BY SURFACE NAME — so `onCaughtError` logs and says nothing
//     more. Only the uncaught path adds a report, and only when the stack names a plugin.
const logRootError = (error: unknown): void => {
  console.error(error);
};
ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onCaughtError: (error) => {
    logRootError(error);
  },
  onUncaughtError: (error, info) => {
    logRootError(error);
    reportPluginRootError(error, info.componentStack);
  },
}).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider
          appearance={clerkAppearance}
          publishableKey={clerkPublishableKey}
          passkeys={passkeys}
        >
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider appearance={clerkAppearance} publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);

// ru-code: plugins load AFTER the first render, never before it (A4 finding H2/M2).
//
// The earlier design awaited `loadPlugins()` above `createRoot(...)` so the panel registry
// could stay a plain non-reactive map. It also meant a plugin whose `activate()` never
// settled white-screened the app permanently — measured: 20 s in, `#root` still held the
// 198-byte skeleton — with no UI left to delete the plugin from. The registries are reactive
// now (`useNavPanels()` / `useOverlayPanels()` / the composer item store), so a panel or a
// `/`-menu item that arrives a moment after first paint simply appears. `loadPlugins()`
// never rejects and caps each plugin's import+activate with its own timeout, so nothing here
// can delay or break the app.
//
// `flushPluginProblems()` does NOT mark the viewport ready any more (A13, A10 finding P1) — it
// AWAITS the toaster's own mount signal (`markPluginToastViewportReady()`, raised from
// `ToastProvider`'s effect) and then drains. `render()` above is asynchronous, so anything that
// forged readiness here handed early messages to a toast manager with no subscriber and they were
// dropped. Order between these two lines is therefore no longer load-bearing; both are fire and
// forget, neither can reject.
void flushPluginProblems();
void loadPlugins();
