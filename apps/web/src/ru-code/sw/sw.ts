// ru-code: PWA service worker (source).
//
// Compiled to a standalone, root-scoped `/sw.js` by `swBuildPlugin` and
// registered from `main.tsx` in browser contexts (never in Electron). Its only
// job today is to make the app installable: Chromium requires a registered
// service worker with a `fetch` handler before it offers "Install", and the web
// manifest (from `@ru-code/theme`) supplies name + icons + `display:standalone`.
//
// It is deliberately a network-only pass-through: no caching, no offline
// behaviour. The `fetch` handler is structured (not empty) so it can grow into a
// real feature — e.g. serving a cached "server unavailable" shell when the
// backend is down — without rewriting the lifecycle. That extension point is
// marked below; until then every request goes straight to the network.
//
// Authored in TypeScript and self-typed (no `webworker` lib) so it typechecks
// under the web package's DOM config without lib conflicts. It has NO imports;
// keep it import-free so the plugin can emit it as one self-contained file.

// The empty export keeps this import-free file a MODULE (its declarations must
// stay file-local, not global) — required, so the lint rule is waived here.
// oxlint-disable-next-line require-module-specifiers
export {};

/** The subset of `ServiceWorkerGlobalScope` this worker actually uses. */
interface ServiceWorkerScope {
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: "install", listener: () => void): void;
  addEventListener(type: "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
}

/** Minimal shape of `ExtendableEvent` — `waitUntil` keeps the worker alive. */
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal shape of `FetchEvent`. `respondWith` is the offline-shell seam. */
interface FetchEventLike extends ExtendableEventLike {
  readonly request: { readonly url: string; readonly mode: string };
  respondWith(response: Response | Promise<Response>): void;
}

const worker = self as unknown as ServiceWorkerScope;

// Activate this worker as soon as it installs, replacing any previous one, so a
// fresh deploy takes effect on the next load rather than after every tab closes.
worker.addEventListener("install", () => {
  void worker.skipWaiting();
});

// Take control of already-open clients immediately after activating.
worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

// Network-only pass-through. Not calling `respondWith` lets the browser handle
// the request normally over the network.
//
// EXTENSION SEAM: to serve a cached offline / "server unavailable" shell later,
// call `event.respondWith(...)` here for navigation requests
// (`event.request.mode === "navigate"`) and fall back to a precached page when
// the network fetch rejects. The install/activate hooks above would then also
// populate a cache. Left as a pure pass-through for now.
worker.addEventListener("fetch", () => {
  // no-op: every request goes to the network
});
