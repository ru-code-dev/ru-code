// ru-code: proves the SW status pages carry NO hardcoded product branding —
// every «Ru Code» / `ru-code` literal is interpolated from @ru-code/branding at
// emission (#34). The branding module is mocked with sentinel values; the
// emitted HTML must contain the sentinels and none of the real product literals.
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@ru-code/branding", () => ({
  APP_NAME: "Acme Studio",
  APP_COMMAND: "acme",
  SUPPORT_CHANNEL_URL: "https://support.example/acme",
  // ru-code: not branding copy — a tunable the page script interpolates; kept at
  // its real value so this test only asserts the product literals.
  UPDATE_MANUAL_WINDOW_MS: 2 * 60_000,
}));

import { swDownDocument, swUpdatingDocument } from "../../auto-update-ui/sw-kit/swPages";
import { SW_PROTOCOL_VERSION, type SwMirror } from "../../auto-update-ui/sw-kit/runtime";

const NOW = 1_800_000_000_000;

const mirror = (overrides: Partial<SwMirror> = {}): SwMirror => ({
  v: SW_PROTOCOL_VERSION,
  version: "1.4.1",
  locale: "ru",
  address: "127.0.0.1:3773",
  installDir: "~/.acme/bin",
  port: 3773,
  pid: 4321,
  cssVars: {},
  dark: true,
  updatedAt: NOW - 120_000,
  ...overrides,
});

const marker = {
  v: SW_PROTOCOL_VERSION,
  targetVersion: "1.4.2",
  fromVersion: "1.4.1",
  startedAt: NOW - 30_000,
} as const;

describe("SW pages — branding interpolation (#34)", () => {
  it("down page uses the branded name/command and never the real product literals", () => {
    const html = swDownDocument({ mirror: mirror(), now: NOW });
    expect(html).toContain("Acme Studio");
    expect(html).toContain('"command":"acme"');
    expect(html).toContain("acme restart");
    expect(html).not.toContain("Ru Code");
    // the clearMsg protocol key is the ONLY "ru-code" token allowed (namespace, not branding)
    const withoutClearMsg = html.replace(/"clearMsg":"[^"]*"/g, "");
    expect(withoutClearMsg).not.toContain("ru-code");
  });

  it("updating page uses the branded name/command and support link, no real literals", () => {
    const html = swUpdatingDocument({ marker, mirror: mirror(), now: NOW });
    expect(html).toContain("Acme Studio");
    expect(html).toContain('"command":"acme"');
    expect(html).toContain("https://support.example/acme");
    expect(html).not.toContain("Ru Code");
    // the clearMsg protocol key is the ONLY "ru-code" token allowed (namespace, not branding)
    const withoutClearMsg = html.replace(/"clearMsg":"[^"]*"/g, "");
    expect(withoutClearMsg).not.toContain("ru-code");
  });

  it("omits the support line when SUPPORT_CHANNEL_URL is empty", async () => {
    vi.resetModules();
    vi.doMock("@ru-code/branding", () => ({
      APP_NAME: "Acme Studio",
      APP_COMMAND: "acme",
      SUPPORT_CHANNEL_URL: "",
      UPDATE_MANUAL_WINDOW_MS: 2 * 60_000,
    }));
    const { swUpdatingDocument: emit } = await import("../../auto-update-ui/sw-kit/swPages");
    const html = emit({ marker, mirror: mirror(), now: NOW });
    expect(html).not.toContain("support.example");
    expect(html).not.toContain("Нужна помощь");
    vi.doUnmock("@ru-code/branding");
  });
});
