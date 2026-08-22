// ru-code: PWA service worker (source).
//
// Compiled by `swBuildPlugin` into a standalone root-scoped `/sw.js` (now a
// BUNDLING build — this file imports the sw-kit page emitters) and registered
// from `main.tsx` in browser contexts (never in Electron).
//
// Jobs:
//   1. Installability (Chromium needs a fetch handler before offering Install).
//   2. The auto-update / server-down choreography:
//      · the app postMessages a MIRROR (version, theme vars, locale, address
//        facts) on load and on every change; persisted in Cache Storage so it
//        survives F5, tab close and server death;
//      · at apply-restart the app postMessages an UPDATE MARKER; while a fresh
//        marker exists, a failed navigation gets the «обновляется» page,
//        otherwise the «не запущен» page (decideNavigateFallback — W15);
//      · only `mode === "navigate"` requests are intercepted, and only when
//        the network fetch actually fails — assets/API/RPC pass through.
//
// Self-typed (no `webworker` lib) so it typechecks under the web package's DOM
// config without lib conflicts.

import {
  SW_CACHE_NAME,
  SW_MARKER_KEY,
  SW_MIRROR_KEY,
  SW_MSG_MIRROR,
  SW_MSG_UPDATE_ACTIVE,
  SW_MSG_UPDATE_CLEAR,
  decideNavigateFallback,
  decodeMirror,
} from "../auto-update-ui/sw-kit/runtime";
import { swDownDocument, swUpdatingDocument } from "../auto-update-ui/sw-kit/swPages";

/** The subset of `ServiceWorkerGlobalScope` this worker actually uses. */
interface ServiceWorkerScope {
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly caches: {
    open(name: string): Promise<CacheLike>;
  };
  addEventListener(type: "install", listener: () => void): void;
  addEventListener(type: "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Minimal shape of `ExtendableEvent` — `waitUntil` keeps the worker alive. */
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal shape of `FetchEvent`. */
interface FetchEventLike extends ExtendableEventLike {
  readonly request: { readonly url: string; readonly mode: string };
  respondWith(response: Response | Promise<Response>): void;
}

interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
}

const worker = self as unknown as ServiceWorkerScope;

// Activate this worker as soon as it installs, replacing any previous one.
worker.addEventListener("install", () => {
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

// ── Cache Storage persistence (survives F5 / tab close / server death) ───────

async function readEntry(key: string): Promise<string | null> {
  try {
    const cache = await worker.caches.open(SW_CACHE_NAME);
    const hit = await cache.match(key);
    if (hit === undefined) return null;
    return await hit.text();
  } catch {
    return null;
  }
}

async function writeEntry(key: string, text: string): Promise<void> {
  const cache = await worker.caches.open(SW_CACHE_NAME);
  await cache.put(key, new Response(text, { headers: { "Content-Type": "application/json" } }));
}

async function deleteEntry(key: string): Promise<void> {
  const cache = await worker.caches.open(SW_CACHE_NAME);
  await cache.delete(key);
}

// ── mirror + marker messages from the app ────────────────────────────────────

worker.addEventListener("message", (event) => {
  const data = event.data;
  if (typeof data !== "object" || data === null) return;
  const message = data as { type?: unknown; mirror?: unknown; marker?: unknown };
  if (
    message.type === SW_MSG_MIRROR &&
    typeof message.mirror === "object" &&
    message.mirror !== null
  ) {
    event.waitUntil(
      writeEntry(SW_MIRROR_KEY, JSON.stringify(message.mirror)).catch(() => undefined),
    );
    return;
  }
  if (
    message.type === SW_MSG_UPDATE_ACTIVE &&
    typeof message.marker === "object" &&
    message.marker !== null
  ) {
    event.waitUntil(
      writeEntry(SW_MARKER_KEY, JSON.stringify(message.marker)).catch(() => undefined),
    );
    return;
  }
  if (message.type === SW_MSG_UPDATE_CLEAR) {
    event.waitUntil(deleteEntry(SW_MARKER_KEY).catch(() => undefined));
  }
});

// ── navigate fallback (the only interception) ────────────────────────────────

async function fallbackResponse(): Promise<Response> {
  const now = Date.now();
  const [markerText, mirrorText] = await Promise.all([
    readEntry(SW_MARKER_KEY),
    readEntry(SW_MIRROR_KEY),
  ]);
  const mirror = decodeMirror(mirrorText);
  const decision = decideNavigateFallback(markerText, now);
  const html =
    decision.page === "updating"
      ? swUpdatingDocument({ marker: decision.marker, mirror, now })
      : swDownDocument({ mirror, now });
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

worker.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // assets/API/RPC untouched
  event.respondWith(fetch(event.request.url).catch(() => fallbackResponse()));
});
