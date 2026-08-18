// ru-code: server-backed replacement for `window.localStorage` in t3's theme engine.
//
// WHY. localStorage is scoped to origin = host + PORT, and the server reserves a fresh
// port on most launches, so every client-stored appearance value silently resets. The
// fork therefore owns appearance in ServerSettings. t3's theme engine is NOT rewritten:
// its reads/writes stay exactly where t3 put them, and only the backing store changes.
//
// SYNCHRONOUS BY CONSTRUCTION. t3's pre-paint and `readThemePreference()` are sync, so an
// async settings fetch would reintroduce the flash t3 does not have. The server stamps the
// effective values into the served HTML (see apps/server/src/ru-code/appearanceBootstrapHtml.ts);
// this module resolves reads from those globals on demand. Reads never await.
//
// WRITES are fire-and-forget to the server. The cache updates immediately so t3's
// `useSyncExternalStore` subscribers repaint at once; persistence follows.
//
// The five keys mirror t3's five appearance keys 1:1 — see clientBootstrapState.ts.

import { APP_SCOPE } from "@ru-code/branding";

export const THEME_PREFERENCE_KEY = `${APP_SCOPE}:theme`;
export const THEME_APPEARANCE_MODE_KEY = `${APP_SCOPE}:theme-appearance-mode`;
export const THEME_FOLLOW_SYSTEM_KEY = `${APP_SCOPE}:theme-follow-system`;
export const THEME_HALVES_KEY = `${APP_SCOPE}:theme-halves:v1`;
export const CUSTOM_THEMES_KEY = `${APP_SCOPE}:themes:v1`;

/** ServerSettings field name for each appearance key. */
const FIELD_BY_KEY: Readonly<Record<string, string>> = {
  [THEME_PREFERENCE_KEY]: "themePreference",
  [THEME_APPEARANCE_MODE_KEY]: "themeAppearanceMode",
  [THEME_FOLLOW_SYSTEM_KEY]: "themeFollowSystem",
  [THEME_HALVES_KEY]: "themeHalves",
  [CUSTOM_THEMES_KEY]: "customThemes",
};

/** Booleans round-trip as "true"/"false" because t3 parses them as strings. */
const BOOLEAN_FIELDS = new Set(["themeFollowSystem"]);

type Globals = {
  __RU_THEME_PREFERENCE__?: string;
  __RU_THEME_APPEARANCE_MODE__?: string;
  __RU_THEME_FOLLOW_SYSTEM__?: string;
  __RU_THEME_HALVES__?: string;
  __RU_CUSTOM_THEMES__?: string;
};

/** Global stamped by the server for each key (see appearanceBootstrapHtml.ts). */
const GLOBAL_BY_KEY: Readonly<Record<string, keyof Globals>> = {
  [THEME_PREFERENCE_KEY]: "__RU_THEME_PREFERENCE__",
  [THEME_APPEARANCE_MODE_KEY]: "__RU_THEME_APPEARANCE_MODE__",
  [THEME_FOLLOW_SYSTEM_KEY]: "__RU_THEME_FOLLOW_SYSTEM__",
  [THEME_HALVES_KEY]: "__RU_THEME_HALVES__",
  [CUSTOM_THEMES_KEY]: "__RU_CUSTOM_THEMES__",
};

// The server-stamped global is the single client-side source of truth: reads resolve it
// lazily (no import-order dependency) and writes update it in place before the server
// round-trip. Deliberately NO local override map — one would leak across module lifetimes
// and would mask a value pushed by another client.

function readGlobal(key: string): string | null {
  if (typeof window === "undefined") return null;
  const name = GLOBAL_BY_KEY[key];
  if (name === undefined) return null;
  const value = (window as unknown as Globals)[name];
  return value === undefined || value === "" ? null : value;
}

function writeGlobal(key: string, value: string): void {
  if (typeof window === "undefined") return;
  const name = GLOBAL_BY_KEY[key];
  if (name === undefined) return;
  (window as unknown as Globals)[name] = value;
}

/** Set once at app boot by the React layer, which owns the settings-update command. */
type Persist = (patch: Record<string, string | boolean>) => void;
let persist: Persist | null = null;

export function registerAppearancePersist(next: Persist): void {
  persist = next;
}

function push(key: string, value: string | null): void {
  const field = FIELD_BY_KEY[key];
  if (field === undefined || persist === null) return;
  persist({
    [field]: BOOLEAN_FIELDS.has(field) ? value === "true" : (value ?? ""),
  });
}

/**
 * Drop-in for the `window.localStorage` subset t3's theme engine uses.
 * Same signatures, same synchronous contract — different backing store.
 */
export const appearanceStorage = {
  getItem(key: string): string | null {
    return readGlobal(key);
  },
  setItem(key: string, value: string): void {
    writeGlobal(key, value);
    push(key, value);
  },
  removeItem(key: string): void {
    writeGlobal(key, "");
    push(key, null);
  },
};
