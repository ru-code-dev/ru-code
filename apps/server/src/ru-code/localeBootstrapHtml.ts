// ru-code: stamp the server's effective UI locale into every served index.html.
//
// The web client must know its language BEFORE any app JS runs, so the injected
// L("en","ru") calls (including the ones frozen into module-level constants)
// evaluate in the right language on the very first paint. The client normally
// reads this from localStorage — but localStorage is keyed by *origin*
// (scheme + host + PORT), and the server reserves a fresh ephemeral port on most
// launches (see packages/shared/src/Net.ts reserveLoopbackPort), so on a new
// port the client's storage is empty and it would fall back to the default
// locale even though the server setting says otherwise.
//
// The server always serves the HTML shell (see http.ts: both the SPA fallback
// and a direct "/" hit), and it is the authoritative owner of the persisted
// language (ServerSettings.locale, kept in sync with getLocale() by the
// serverSettings tap + honoring the --language override). So we stamp that value
// straight into the document as a synchronous global. The client prefers a
// same-origin localStorage value when present (an instant, race-free post-toggle
// reload) and falls back to this server-stamped value on a fresh origin.

import { getLocale } from "@ru-code/localization";

const HEAD_OPEN = "<head>";

/**
 * Insert a synchronous locale seed as the first child of <head>, before the
 * app bundle and before any localStorage read. No-op if <head> is absent.
 */
export function injectLocaleBootstrap(html: string): string {
  const serializedLocale = JSON.stringify(getLocale());
  const seedScript = `<script>window.__RU_LOCALE__=${serializedLocale};</script>`;

  const headIndex = html.indexOf(HEAD_OPEN);
  if (headIndex === -1) {
    return html;
  }
  const insertAt = headIndex + HEAD_OPEN.length;
  return html.slice(0, insertAt) + seedScript + html.slice(insertAt);
}
