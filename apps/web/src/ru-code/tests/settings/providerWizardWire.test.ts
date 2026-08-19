import { afterEach, describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { setLocale } from "@ru-code/localization";

import { DRIVER_OPTION_BY_VALUE } from "../../../components/settings/providerDriverMeta";
import { deriveProviderSettingsFields } from "../../../components/settings/ProviderSettingsForm";

// End-to-end proof of the wire-token path for the provider wizard: the provider settings
// schema annotations ship as locale-independent Lc tokens (transform, driven by
// dict/packages/contracts/src/settings.ts.json `"wire": true`), and deriveProviderSettingsFields
// resolves them in the VIEWER's locale at render. Locale is a process singleton — reset it.
afterEach(() => setLocale("en"));

describe("provider wizard wire tokens resolve per-locale", () => {
  const fieldAt = (locale: "en" | "ru", key: string) => {
    setLocale(locale);
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    return deriveProviderSettingsFields(opencode!).find((field) => field.key === key);
  };

  it("resolves label + description to English in EN locale (identity)", () => {
    expect(fieldAt("en", "serverPassword")).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
    });
  });

  it("resolves label + description to Russian in RU locale", () => {
    expect(fieldAt("ru", "serverPassword")).toMatchObject({
      label: "Пароль сервера",
      description: "Хранится на диске в открытом виде.",
    });
  });

  it("leaves no raw token behind (sentinel never reaches the field model)", () => {
    const sentinel = String.fromCharCode(0x1e);
    for (const locale of ["en", "ru"] as const) {
      setLocale(locale);
      const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
      for (const field of deriveProviderSettingsFields(opencode!)) {
        expect(field.label).not.toContain(sentinel);
        if (field.description) expect(field.description).not.toContain(sentinel);
      }
    }
  });
});
