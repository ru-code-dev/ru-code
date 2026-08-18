// ru-code: stamp the server's effective appearance into every served index.html,
// alongside the locale seed (see localeBootstrapHtml.ts). Same rationale:
// localStorage is keyed by origin (host + PORT) and the server reserves a fresh port
// on most launches, so the server setting is the source of truth. It is injected as a
// synchronous global so t3's existing pre-paint script — which we feed rather than
// replace — reads it before first paint, keeping t3's no-flash behaviour intact.
//
// The globals map 1:1 onto the five reads in apps/web/index.html.

import { getBootstrapAppearance } from "./clientBootstrapState.ts";

const HEAD_OPEN = "<head>";

/** Insert the appearance seed as an early child of <head>. No-op if <head> is absent. */
export function injectAppearanceBootstrap(html: string): string {
  const appearance = getBootstrapAppearance();
  const seedScript =
    `<script>` +
    `window.__RU_THEME_PREFERENCE__=${JSON.stringify(appearance.themePreference)};` +
    `window.__RU_THEME_APPEARANCE_MODE__=${JSON.stringify(appearance.appearanceMode)};` +
    `window.__RU_THEME_FOLLOW_SYSTEM__=${JSON.stringify(String(appearance.followSystem))};` +
    `window.__RU_THEME_HALVES__=${JSON.stringify(appearance.themeHalves)};` +
    `window.__RU_CUSTOM_THEMES__=${JSON.stringify(appearance.customThemes)};` +
    `</script>`;

  const headIndex = html.indexOf(HEAD_OPEN);
  if (headIndex === -1) {
    return html;
  }
  const insertAt = headIndex + HEAD_OPEN.length;
  return html.slice(0, insertAt) + seedScript + html.slice(insertAt);
}
