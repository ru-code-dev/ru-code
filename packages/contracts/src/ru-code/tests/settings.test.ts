// ru-code: chat view mode — the server-owned default for qwen threads
// (ServerSettings.chatViewMode + the ServerSettingsPatch key). Covers the marked
// seams in packages/contracts/src/settings.ts.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "../../settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings.chatViewMode", () => {
  it("defaults to «compact» so existing settings.json files decode unchanged", () => {
    expect(decodeServerSettings({}).chatViewMode).toBe("compact");
    expect(DEFAULT_SERVER_SETTINGS.chatViewMode).toBe("compact");
  });

  it("round-trips «detailed» through decode/encode", () => {
    const decoded = decodeServerSettings({ chatViewMode: "detailed" });
    expect(decoded.chatViewMode).toBe("detailed");
    expect(encodeServerSettings(decoded).chatViewMode).toBe("detailed");
  });

  it("accepts the field in a server settings patch", () => {
    expect(decodeServerSettingsPatch({ chatViewMode: "detailed" }).chatViewMode).toBe("detailed");
    expect(decodeServerSettingsPatch({})).not.toHaveProperty("chatViewMode");
  });

  it("rejects unknown modes", () => {
    expect(() => decodeServerSettings({ chatViewMode: "expanded" })).toThrow();
  });
});
