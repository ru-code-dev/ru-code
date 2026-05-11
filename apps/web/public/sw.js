// Minimal service worker — satisfies Chrome's PWA installability requirement
// (registered SW with a `fetch` handler) without providing offline capability.
// The fetch handler is intentionally a no-op: it does not call respondWith(),
// so the browser handles every request normally over the network.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // network-only pass-through, no caching
});
