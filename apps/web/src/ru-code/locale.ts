// ru-code: web-side glue for the bilingual runtime.
//
// The @ru-code/localization package holds a module-level current locale that the
// injected L()/LT() calls read at evaluation time. The language is owned by the
// server (ServerSettings.locale) — there is NO client-side locale storage.
//
// The server stamps its effective locale into the served HTML as
// window.__RU_LOCALE__ (see apps/server/src/ru-code/localeBootstrapHtml.ts), so
// this module seeds it before the first render. That makes the language correct
// on any origin: localStorage is keyed by origin (host + PORT) and the server
// reserves a fresh port on most launches, so a per-origin cache would be empty
// and unreliable. Changing the language writes the server setting and reloads —
// a reload is the only fully correct way to re-run module-level L() constants,
// which freeze at import time.

import { getLocale, isLocale, setLocale, type Locale } from "@ru-code/localization";

export function readInjectedLocale(): Locale {
  if (typeof window === "undefined") return getLocale();
  const injected = (window as { __RU_LOCALE__?: unknown }).__RU_LOCALE__;
  return isLocale(injected) ? injected : getLocale();
}

/** Seed the module locale from the server-injected value. Call once, before rendering. */
export function bootLocale(): void {
  setLocale(readInjectedLocale());
}
