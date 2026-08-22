// ru-code: unit tests for the SW runtime protocol — the navigate-fallback
// decision tree (W15 incl. the staleness guard), the defensive mirror/marker
// codecs, and the SW-served document emission (sections, config, theming).
import { describe, expect, it } from "vite-plus/test";

import { APP_COMMAND, APP_NAME, UPDATE_MANUAL_WINDOW_MS } from "@ru-code/branding";

import {
  MIRRORED_CSS_VARS,
  SW_MSG_UPDATE_CLEAR,
  SW_PROTOCOL_VERSION,
  UPDATE_MARKER_STALE_MS,
  decideNavigateFallback,
  decodeMarker,
  decodeMirror,
  themeStyleTag,
  type SwMirror,
} from "../../auto-update-ui/sw-kit/runtime";
import { STANDALONE_RESET } from "../../auto-update-ui/sw-kit/parts";
import { swDownDocument, swUpdatingDocument } from "../../auto-update-ui/sw-kit/swPages";

const NOW = 1_800_000_000_000;

const marker = (overrides: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    v: SW_PROTOCOL_VERSION,
    targetVersion: "1.4.2",
    fromVersion: "1.4.1",
    startedAt: NOW - 30_000,
    ...overrides,
  });

const mirror = (overrides: Partial<SwMirror> = {}): SwMirror => ({
  v: SW_PROTOCOL_VERSION,
  version: "1.4.1",
  locale: "ru",
  address: "127.0.0.1:3773",
  installDir: "~/.ru-code/bin",
  port: 3773,
  pid: 4321,
  cssVars: { "--background": "#111", "--foreground": "#eee" },
  dark: true,
  updatedAt: NOW - 120_000,
  ...overrides,
});

describe("decideNavigateFallback (W15)", () => {
  it("fresh marker → updating page with the decoded marker", () => {
    const decision = decideNavigateFallback(marker(), NOW);
    expect(decision.page).toBe("updating");
    if (decision.page === "updating") {
      expect(decision.marker.targetVersion).toBe("1.4.2");
      expect(decision.marker.fromVersion).toBe("1.4.1");
    }
  });

  it("no marker → down page", () => {
    expect(decideNavigateFallback(null, NOW)).toEqual({ page: "down" });
  });

  it("corrupt marker JSON → down page", () => {
    expect(decideNavigateFallback("{not json", NOW)).toEqual({ page: "down" });
  });

  it("marker missing required fields → down page", () => {
    expect(decideNavigateFallback(JSON.stringify({ v: 1 }), NOW)).toEqual({ page: "down" });
    expect(decideNavigateFallback(marker({ targetVersion: "" }), NOW)).toEqual({ page: "down" });
    expect(decideNavigateFallback(marker({ startedAt: "yesterday" }), NOW)).toEqual({
      page: "down",
    });
  });

  it("wrong protocol version → down page", () => {
    expect(decideNavigateFallback(marker({ v: 999 }), NOW)).toEqual({ page: "down" });
  });

  it("stale marker (crashed update) → down page — the staleness guard", () => {
    const stale = marker({ startedAt: NOW - UPDATE_MARKER_STALE_MS - 1 });
    expect(decideNavigateFallback(stale, NOW)).toEqual({ page: "down" });
  });

  it("marker exactly at the staleness edge is still fresh", () => {
    const edge = marker({ startedAt: NOW - UPDATE_MARKER_STALE_MS });
    expect(decideNavigateFallback(edge, NOW).page).toBe("updating");
  });

  it("marker from the future beyond skew tolerance → down page", () => {
    expect(decideNavigateFallback(marker({ startedAt: NOW + 120_000 }), NOW)).toEqual({
      page: "down",
    });
  });

  it("small clock skew into the future is tolerated", () => {
    expect(decideNavigateFallback(marker({ startedAt: NOW + 30_000 }), NOW).page).toBe("updating");
  });
});

describe("decodeMirror (defensive)", () => {
  it("round-trips a valid mirror", () => {
    const decoded = decodeMirror(JSON.stringify(mirror()));
    expect(decoded).not.toBeNull();
    expect(decoded?.version).toBe("1.4.1");
    expect(decoded?.cssVars["--background"]).toBe("#111");
    expect(decoded?.dark).toBe(true);
  });

  it("null / empty / garbage / wrong version → null", () => {
    expect(decodeMirror(null)).toBeNull();
    expect(decodeMirror("")).toBeNull();
    expect(decodeMirror("{oops")).toBeNull();
    expect(decodeMirror(JSON.stringify({ v: 2, version: "x" }))).toBeNull();
    expect(decodeMirror(JSON.stringify({ v: 1 }))).toBeNull();
  });

  it("fills missing optional fields with safe defaults", () => {
    const decoded = decodeMirror(JSON.stringify({ v: 1, version: "1.0.0" }));
    expect(decoded).not.toBeNull();
    expect(decoded?.address).toBe("");
    expect(decoded?.port).toBeNull();
    expect(decoded?.cssVars).toEqual({});
    expect(decoded?.dark).toBe(false);
  });
});

describe("decodeMarker (defensive)", () => {
  it("round-trips and defaults fromVersion", () => {
    const decoded = decodeMarker(JSON.stringify({ v: 1, targetVersion: "2.0.0", startedAt: 5 }));
    expect(decoded).toEqual({ v: 1, targetVersion: "2.0.0", fromVersion: "", startedAt: 5 });
  });
});

describe("MIRRORED_CSS_VARS (#33)", () => {
  it("includes every palette var the SW pages read and drops the unused ones", () => {
    const vars = MIRRORED_CSS_VARS as ReadonlyArray<string>;
    for (const name of [
      "--success",
      "--success-foreground",
      "--destructive-foreground",
      "--warning-foreground",
      "--input",
    ]) {
      expect(vars).toContain(name);
    }
    expect(vars).not.toContain("--ring");
    expect(vars).not.toContain("--font-mono");
  });
});

describe("themeStyleTag", () => {
  it("emits only allow-listed vars and the color scheme", () => {
    const tag = themeStyleTag(
      mirror({ cssVars: { "--background": "#000", "--evil": "url(x)", "--primary": "#f00" } }),
    );
    expect(tag).toContain("--background:#000");
    expect(tag).toContain("--primary:#f00");
    expect(tag).not.toContain("--evil");
    expect(tag).toContain("color-scheme:dark");
  });

  it("null mirror or no known vars → empty string", () => {
    expect(themeStyleTag(null)).toBe("");
    expect(themeStyleTag(mirror({ cssVars: {} }))).toBe("");
  });

  it("strips markup-breaking characters from values", () => {
    const tag = themeStyleTag(mirror({ cssVars: { "--background": "#0<script>0" } }));
    expect(tag).not.toContain("<script");
  });
});

/** Slice one `data-rcu-section="…"` block out of an emitted document. */
function section(html: string, name: string): string {
  const start = html.indexOf(`<div data-rcu-section="${name}"`);
  if (start < 0) throw new Error(`no section ${name}`);
  const next = html.indexOf('<div data-rcu-section="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("swUpdatingDocument", () => {
  const html = swUpdatingDocument({
    marker: { v: 1, targetVersion: "1.4.2", fromVersion: "1.4.1", startedAt: NOW - 30_000 },
    mirror: mirror(),
    now: NOW,
  });

  it("contains the live, success and manual sections (success/manual hidden)", () => {
    expect(html).toContain('data-rcu-section="live"');
    expect(html).toContain('data-rcu-section="success" hidden');
    expect(html).toContain('data-rcu-section="manual" hidden');
  });

  it("carries the page config and the runtime script", () => {
    expect(html).toContain('"page":"updating"');
    expect(html).toContain('"targetVersion":"1.4.2"');
    expect(html).toContain("window.__RCU__=");
    expect(html).toContain("/healthz");
  });

  it("shows the target version and the countdown slots", () => {
    expect(html).toContain("v1.4.2");
    expect(html).toContain('data-rcu="countdown"');
    expect(html).toContain('data-rcu="elapsed"');
    expect(html).toContain('data-action="stay"');
  });

  it("inlines the mirrored theme vars", () => {
    expect(html).toContain("--background:#111");
    expect(html).toContain("color-scheme:dark");
  });

  it("prepends the standalone reset into the document <style> (#31)", () => {
    expect(html).toContain(STANDALONE_RESET);
    // the reset lives ONLY in the emitted document, so the <style> opens with it
    expect(html).toContain(`<style>${STANDALONE_RESET}`);
  });

  it("pre-renders a hidden failure section with a raw-reason slot (item 7)", () => {
    expect(html).toContain('data-rcu-section="failed" hidden');
    expect(html).toContain('data-rcu="fail-reason"');
  });

  it("carries the branded command, clear-marker message and runtime strings (#34/#35)", () => {
    expect(html).toContain(`"command":"${APP_COMMAND}"`);
    expect(html).toContain(`"clearMsg":"${SW_MSG_UPDATE_CLEAR}"`);
    expect(html).toContain('"strings":{');
    // the app command travels in config, never hardcoded in the page script
    expect(html).toContain("writeText(CMD)");
  });

  it("embeds the item-7 success + manual-window rules in the page script", () => {
    expect(html).toContain("body.version === target");
    // the manual window is interpolated from branding, never a literal in the source
    expect(html).toContain(`var manualAfterMs = ${UPDATE_MANUAL_WINDOW_MS};`);
    expect(html).toContain("lastApply");
  });

  it("defaults to Russian copy and lang (mirror locale ru)", () => {
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain("обновляется");
    expect(html).toContain("Остаться");
  });

  // F18 — strict per-state button sets, asserted by PRESENCE and ABSENCE.
  //   live    → progress + elapsed only (the server it could navigate to is being replaced)
  //   success → «Вернуться (n)» countdown + «Остаться»
  //   manual  → the how-to + «Проверить снова»
  //   failed  → back to settings (the server answered again, so navigation works)
  it("gives the LIVE section no way out", () => {
    const live = section(html, "live");
    expect(live).toContain('data-rcu="elapsed"');
    expect(live).not.toContain("data-action=");
  });

  it("gives the SUCCESS section the countdown and «stay», nothing else", () => {
    const success = section(html, "success");
    expect(success).toContain('data-action="return-now"');
    expect(success).toContain('data-rcu="countdown"');
    expect(success).toContain('data-action="stay"');
    expect(success).not.toContain('data-action="probe"');
  });

  it("gives the MANUAL section the how-to and a re-check, but no return", () => {
    const manual = section(html, "manual");
    expect(manual).toContain('data-action="probe"');
    expect(manual).toContain('data-action="copy-cmd"');
    expect(manual).not.toContain('data-action="return-now"');
    expect(manual).not.toContain('data-action="back"');
  });

  it("gives the FAILED section a way back to settings", () => {
    const failed = section(html, "failed");
    expect(failed).toContain('data-action="back"');
    expect(failed).not.toContain('data-action="probe"');
  });
});

describe("swUpdatingDocument — English locale (#35)", () => {
  const html = swUpdatingDocument({
    marker: { v: 1, targetVersion: "1.4.2", fromVersion: "1.4.1", startedAt: NOW - 30_000 },
    mirror: mirror({ locale: "en" }),
    now: NOW,
  });

  it("emits English static strings and lang=en", () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("is updating");
    expect(html).toContain("Stay");
    expect(html).toContain("Update failed");
    expect(html).not.toContain("Остаться");
  });

  it("emits English runtime strings in the __RCU__.strings map", () => {
    expect(html).toContain('"probeAgain":"Check again"');
    expect(html).toContain('"copied":"Copied"');
  });
});

describe("swDownDocument", () => {
  it("renders mirror facts", () => {
    const html = swDownDocument({ mirror: mirror(), now: NOW });
    expect(html).toContain("v1.4.1");
    expect(html).toContain("127.0.0.1:3773");
    expect(html).toContain('"page":"down"');
    expect(html).toContain('data-rcu="probe-label"');
  });

  it("degrades to placeholders without a mirror", () => {
    const html = swDownDocument({ mirror: null, now: NOW });
    expect(html).toContain("—");
    expect(html).toContain("window.__RCU__=");
  });

  it("prepends the standalone reset and drops the removed footer sentence (#31/#32)", () => {
    const html = swDownDocument({ mirror: mirror(), now: NOW });
    expect(html).toContain(`<style>${STANDALONE_RESET}`);
    expect(html).not.toContain("Страница показана локально");
  });

  it("branded command in config and in the restart hint (#34)", () => {
    const html = swDownDocument({ mirror: mirror(), now: NOW });
    expect(html).toContain(`"command":"${APP_COMMAND}"`);
    expect(html).toContain(`${APP_COMMAND} restart`);
    expect(html).toContain(APP_NAME);
  });

  it("renders English copy for an en-locale mirror (#35)", () => {
    const html = swDownDocument({ mirror: mirror({ locale: "en" }), now: NOW });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("is not running");
    expect(html).toContain("Check again");
    expect(html).toContain("To stop the app");
    expect(html).not.toContain("не запущен");
  });

  // F18 — strict per-state button sets. The down page cannot navigate anywhere: the server it
  // would navigate to is the one that is not answering. Its ONE action is a re-probe; the
  // heartbeat brings the user back on its own the moment /healthz answers.
  it("offers ONLY «check again» — no return-to-app button", () => {
    const html = swDownDocument({ mirror: mirror(), now: NOW });
    expect(html).toContain('data-action="probe"');
    expect(html).not.toContain('data-action="back"');
    expect(html).not.toContain("Вернуться в приложение");
  });

  it("tells the user how to STOP the app (the background hint was stale)", () => {
    const html = swDownDocument({ mirror: mirror(), now: NOW });
    expect(html).toContain(`${APP_COMMAND} stop`);
    expect(html).not.toContain("работал в фоне");
  });
});
