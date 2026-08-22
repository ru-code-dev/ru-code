// ru-code: SW runtime protocol — shared by the app (mirror pusher), the service
// worker (persistence + navigate-fallback decision) and tests. Pure data +
// pure functions; no DOM, no worker APIs, no imports beyond types.
//
// The app postMessages this data to its SW; the SW persists it in Cache
// Storage (survives F5, tab close and server death — the whole point: it must
// be readable while the server is a corpse). Everything environment-specific
// on the SW-served pages comes from here; the page templates carry only
// structure and copy.

/** One protocol version for every persisted blob — bump together, decode defensively. */
export const SW_PROTOCOL_VERSION = 1;

/** Cache Storage bucket + synthetic request keys the SW persists under. */
export const SW_CACHE_NAME = "ru-code-sw-v1";
export const SW_MIRROR_KEY = "/__ru-code/mirror";
export const SW_MARKER_KEY = "/__ru-code/update-marker";

/**
 * The in-app route the SW UPDATING page returns to when the new server answers.
 *
 * Fixed on purpose. That page can be on screen for minutes and the user can navigate while it is —
 * every navigation fails the same way and is answered by the same document — so "wherever the tab
 * happens to point" is not a trustworthy destination. After an update there is exactly one page
 * worth landing on: the one that states which version is now running. The DOWN page is the opposite
 * case and simply reloads the path it is already sitting at.
 *
 * Lives here because `pageScript.ts` interpolates it into a document that has no imports at runtime.
 */
export const APP_UPDATE_SETTINGS_ROUTE = "/settings/auto-update";

/** postMessage envelopes (app → SW). */
export const SW_MSG_MIRROR = "ru-code:mirror";
export const SW_MSG_UPDATE_ACTIVE = "ru-code:update-active";
export const SW_MSG_UPDATE_CLEAR = "ru-code:update-clear";

/**
 * An update marker older than this is a corpse (a crashed update must not trap
 * the user on «обновляется…» forever — W15). The real restart window budget is
 * ≈ port-wait 30s + boot-sentinel 90s, comfortably inside.
 */
export const UPDATE_MARKER_STALE_MS = 5 * 60_000;

/**
 * The theme custom properties mirrored for standalone page rendering. Every var
 * the SW-page stylesheet actually reads must be here, or a light theme leaks the
 * dark fallback (#33). `--ring`/`--font-mono` were mirrored but never referenced
 * by the pages, so they are dropped.
 */
export const MIRRORED_CSS_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning-foreground",
  "--font-sans",
] as const;

export interface SwMirror {
  readonly v: typeof SW_PROTOCOL_VERSION;
  /** Currently running app version (baked). */
  readonly version: string;
  readonly locale: string;
  /** "host:port" the app was reachable at. */
  readonly address: string;
  readonly installDir: string;
  readonly port: number | null;
  readonly pid: number | null;
  /** Resolved theme custom properties captured from the live document. */
  readonly cssVars: Readonly<Record<string, string>>;
  /** Whether the dark scheme was active at capture time. */
  readonly dark: boolean;
  /** Epoch ms of the capture ("был в сети"). */
  readonly updatedAt: number;
}

export interface UpdateMarker {
  readonly v: typeof SW_PROTOCOL_VERSION;
  readonly targetVersion: string;
  readonly fromVersion: string;
  /** Epoch ms when the apply/restart handoff started. */
  readonly startedAt: number;
}

// ── defensive decoders (persisted data may come from any past version) ───────

export function decodeMirror(text: string | null): SwMirror | null {
  if (text === null || text === "") return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (record.v !== SW_PROTOCOL_VERSION) return null;
    if (typeof record.version !== "string") return null;
    return {
      v: SW_PROTOCOL_VERSION,
      version: record.version,
      locale: typeof record.locale === "string" ? record.locale : "ru",
      address: typeof record.address === "string" ? record.address : "",
      installDir: typeof record.installDir === "string" ? record.installDir : "",
      port: typeof record.port === "number" ? record.port : null,
      pid: typeof record.pid === "number" ? record.pid : null,
      cssVars:
        typeof record.cssVars === "object" && record.cssVars !== null
          ? (record.cssVars as Record<string, string>)
          : {},
      dark: record.dark === true,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function decodeMarker(text: string | null): UpdateMarker | null {
  if (text === null || text === "") return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (record.v !== SW_PROTOCOL_VERSION) return null;
    if (typeof record.targetVersion !== "string" || record.targetVersion === "") return null;
    if (typeof record.startedAt !== "number") return null;
    return {
      v: SW_PROTOCOL_VERSION,
      targetVersion: record.targetVersion,
      fromVersion: typeof record.fromVersion === "string" ? record.fromVersion : "",
      startedAt: record.startedAt,
    };
  } catch {
    return null;
  }
}

// ── the navigate-fallback decision (W15) ─────────────────────────────────────

export type NavigateFallback =
  | { readonly page: "updating"; readonly marker: UpdateMarker }
  | { readonly page: "down" };

/**
 * A failed navigation shows the UPDATING page only for a fresh, well-formed
 * marker; everything else (no marker, corrupt marker, stale marker, a marker
 * "from the future" beyond clock-skew tolerance) is the DOWN page.
 */
export function decideNavigateFallback(markerText: string | null, now: number): NavigateFallback {
  const marker = decodeMarker(markerText);
  if (marker === null) return { page: "down" };
  const age = now - marker.startedAt;
  if (age < -60_000) return { page: "down" };
  if (age > UPDATE_MARKER_STALE_MS) return { page: "down" };
  return { page: "updating", marker };
}

/** Inline `:root{…}` style tag carrying the mirrored theme vars (empty mirror → ""). */
export function themeStyleTag(mirror: SwMirror | null): string {
  if (mirror === null) return "";
  const pairs = Object.entries(mirror.cssVars)
    .filter(([name]) => (MIRRORED_CSS_VARS as ReadonlyArray<string>).includes(name))
    .map(([name, value]) => `${name}:${String(value).replace(/[<>{}]/g, "")}`)
    .join(";");
  if (pairs.length === 0) return "";
  const scheme = mirror.dark ? "color-scheme:dark" : "color-scheme:light";
  return `<style>:root{${pairs};${scheme}}</style>`;
}
