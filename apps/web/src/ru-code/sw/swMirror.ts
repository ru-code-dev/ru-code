// ru-code: app-side pusher of the SW mirror (W14). The app postMessages its
// current facts (version, locale, theme custom properties, address) to the
// service worker on load and on every change; the SW persists them in Cache
// Storage so the status pages can render themed and factual while the server
// is dead. postMessage is a silent in-page call — nothing here ever opens a
// tab or window.
//
// Framework-free: the auto-update client adapter feeds facts in; a mutation
// observer re-pushes when the theme flips (class/data-theme on <html>).

// oxlint-disable unicorn/require-post-message-target-origin -- ServiceWorker/Client postMessage takes no targetOrigin

import {
  MIRRORED_CSS_VARS,
  SW_CACHE_NAME,
  SW_MARKER_KEY,
  SW_MSG_MIRROR,
  SW_MSG_UPDATE_ACTIVE,
  SW_MSG_UPDATE_CLEAR,
  SW_PROTOCOL_VERSION,
  decodeMarker,
  type SwMirror,
  type UpdateMarker,
} from "../auto-update-ui/sw-kit/runtime";

export interface MirrorFacts {
  readonly version: string;
  readonly locale: string;
  readonly address: string;
  readonly installDir: string;
  readonly port: number | null;
  readonly pid: number | null;
}

let lastFacts: MirrorFacts | null = null;
let observerStarted = false;

function postToSw(message: unknown): void {
  try {
    const container = navigator.serviceWorker;
    if (container === undefined) return;
    if (container.controller !== null) {
      container.controller.postMessage(message);
      return;
    }
    // First load after registration: the page isn't controlled yet.
    void container.ready.then((registration) => {
      registration.active?.postMessage(message);
    });
  } catch {
    // The mirror is best-effort by design; the SW pages degrade to "—" facts.
  }
}

function captureCssVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of MIRRORED_CSS_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value.length > 0) vars[name] = value;
  }
  return vars;
}

function buildMirror(facts: MirrorFacts): SwMirror {
  return {
    v: SW_PROTOCOL_VERSION,
    version: facts.version,
    locale: facts.locale,
    address: facts.address,
    installDir: facts.installDir,
    port: facts.port,
    pid: facts.pid,
    cssVars: captureCssVars(),
    dark: document.documentElement.classList.contains("dark"),
    updatedAt: Date.now(),
  };
}

/** Push the mirror now (called by the auto-update adapter on every state emission). */
export function pushSwMirror(facts: MirrorFacts): void {
  lastFacts = facts;
  postToSw({ type: SW_MSG_MIRROR, mirror: buildMirror(facts) });
  startThemeObserver();
}

/**
 * Re-push automatically when the theme changes. Beyond the class / data-theme
 * flip we also watch the root `style` attribute (inline CSS-var rewrites) and the
 * <head> subtree (stylesheet swaps) so a PALETTE-ONLY change — one that rewrites
 * the custom properties without touching a class or data-theme — still re-pushes
 * the mirror (#35 note). `buildMirror` re-reads the resolved vars each time, so
 * whatever moved the palette propagates. A microtask coalesces bursts.
 */
function startThemeObserver(): void {
  if (observerStarted) return;
  observerStarted = true;
  let scheduled = false;
  const repush = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (lastFacts !== null) {
        postToSw({ type: SW_MSG_MIRROR, mirror: buildMirror(lastFacts) });
      }
    });
  };
  const observer = new MutationObserver(repush);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  if (document.head !== null) {
    observer.observe(document.head, { childList: true, subtree: true });
  }
}

/** W15: apply-restart is starting — persist the update marker in the SW. */
export function markUpdateActive(input: {
  readonly targetVersion: string;
  readonly fromVersion: string;
}): void {
  const marker: UpdateMarker = {
    v: SW_PROTOCOL_VERSION,
    targetVersion: input.targetVersion,
    fromVersion: input.fromVersion,
    startedAt: Date.now(),
  };
  postToSw({ type: SW_MSG_UPDATE_ACTIVE, marker });
}

/** W15 belt-and-braces: cleared on update-page success AND on every healthy app load. */
export function clearUpdateMarker(): void {
  postToSw({ type: SW_MSG_UPDATE_CLEAR });
}

/**
 * Read the persisted update marker straight from Cache Storage (the SW writes it
 * there so it survives the server dying). The in-app /updating page uses this on
 * mount to tell "a real update is mid-flight" (a fresh marker, keep waiting) from
 * "nothing is happening" (no marker → the calm idle screen). Best-effort: any
 * failure — no CacheStorage, no cache, corrupt blob — reads as "no marker".
 */
export async function readUpdateMarker(): Promise<UpdateMarker | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(SW_CACHE_NAME);
    const response = await cache.match(SW_MARKER_KEY);
    if (response === undefined) return null;
    return decodeMarker(await response.text());
  } catch {
    return null;
  }
}
